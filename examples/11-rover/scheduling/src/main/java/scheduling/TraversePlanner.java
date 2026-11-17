package scheduling;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import rover.DriveModel;
import rover.MarsSun;
import rover.Terrain;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.PriorityQueue;

/**
 * Plans a rover traverse over the terrain grid: which sites to visit, in what order, along which
 * cells, and when to stop: to recharge, and, under the daylight rule, for the night. Pure functions of
 * their inputs, so the goal that calls them ({@code ScheduleTraverse}) is reproducible and testable
 * without PlanDev.
 *
 * <p>Every duration and energy here comes from {@link DriveModel}, and the Sun from {@link MarsSun},
 * which the simulation also uses. The planner's state of charge is an estimate: it integrates the
 * array's output in steps of up to {@link #SUN_STEP_SEC}, as the model updates it.
 */
public final class TraversePlanner {
  public enum Objective { MIN_DISTANCE, MIN_TIME, MIN_ENERGY }

  public record Site(String id, String name, double lat, double lon, int priority) {}

  /** A route between two points. Waypoints are [longitude, latitude], rounded to 1e-6 degrees. */
  public record Path(List<double[]> waypoints, double km, long seconds, double driveWh, double maxSlopeDeg) {}

  /** The battery as simulated at the start of the traverse, and the array (its output with the Sun overhead at 1 AU). */
  public record Power(double socPct, double capacityWh, double arrayZenithW1AU) {}

  /**
   * When the rover may drive. With {@code daylightOnly}, a drive runs only while the Sun is at least
   * {@code minSunElevationDeg} high at the rover, and starts only if it stays that high for {@code marginSec}
   * more; otherwise the rover drives at any hour. {@code planStartMs} (UTC) puts plan-relative seconds on the Sun's clock.
   */
  public record Daylight(long planStartMs, boolean daylightOnly, double minSunElevationDeg, long marginSec) {}

  /**
   * One activity to create: type "Drive" (with waypoints), "Observe", or "Wait" (with a reason). Times
   * are seconds from plan start. A Wait's site is the one the rover is heading for.
   */
  public record Step(String type, Site site, int part, long startSec, long durationSec, List<double[]> waypoints, String reason) {}

  public record Itinerary(List<Step> steps, List<Site> visited, List<String> notes) {}

  /** The planner recharges to this state of charge before driving on. */
  public static final double RESUME_SOC = 95.0;
  /** Pause after each drive before the next activity. */
  public static final long SETTLE_SECONDS = 60;
  /** Longest step over which the array's output is taken as constant (the model's Sun update interval). */
  public static final long SUN_STEP_SEC = 600;
  /**
   * Drives start this long after the drive window opens and end this long before it closes: the model
   * finds the same crossings at the rover's simulated location, to within a second.
   */
  public static final long WINDOW_GUARD_SEC = 60;
  // ponytail: visiting orders are searched exhaustively, which is exact up to here; a heuristic search beyond.
  public static final int MAX_SITES = 8;

  private TraversePlanner() {}

  /**
   * The cheapest 8-connected route over terrain cells from one point to another, or null if there is
   * none. A cell is impassable if it has no data, is steeper than {@code maxSlopeDeg}, or its centre
   * is in an {@code avoid} polygon; the cell the route starts in is exempt, so the rover can leave it.
   */
  public static Path route(Terrain t, double lat0, double lon0, double lat1, double lon1,
                           Objective objective, double maxSlopeDeg, List<List<double[]>> avoid) {
    final int c0 = t.col(lon0), r0 = t.row(lat0), c1 = t.col(lon1), r1 = t.row(lat1);
    if (!t.inside(c0, r0) || !t.inside(c1, r1)) return null;
    final int start = r0 * t.ncols + c0, goal = r1 * t.ncols + c1, n = t.ncols * t.nrows;
    final double[] g = new double[n];
    final int[] parent = new int[n];
    Arrays.fill(g, Double.POSITIVE_INFINITY);
    Arrays.fill(parent, -1);
    g[start] = 0;
    // The cheapest any km can be: level ground. Keeps the straight-line heuristic admissible.
    final double perKm = cost(objective, 1.0, 0.0);
    final PriorityQueue<double[]> open = new PriorityQueue<>((a, b) -> Double.compare(a[0], b[0]));
    open.add(new double[] {0, start});
    while (!open.isEmpty()) {
      final double[] top = open.poll();
      final int cur = (int) top[1];
      if (cur == goal) break;
      final int cc = cur % t.ncols, cr = cur / t.ncols;
      if (top[0] > g[cur] + perKm * DriveModel.distanceKm(t.lat(cr), t.lon(cc), t.lat(r1), t.lon(c1)) + 1e-9) continue; // stale entry
      for (int dr = -1; dr <= 1; dr++) {
        for (int dc = -1; dc <= 1; dc++) {
          final int nc = cc + dc, nr = cr + dr;
          if ((dr == 0 && dc == 0) || !passable(t, nc, nr, maxSlopeDeg, avoid)) continue;
          final int next = nr * t.ncols + nc;
          final double km = DriveModel.distanceKm(t.lat(cr), t.lon(cc), t.lat(nr), t.lon(nc));
          final double cand = g[cur] + cost(objective, km, t.slope(nc, nr));
          if (cand < g[next]) {
            g[next] = cand;
            parent[next] = cur;
            open.add(new double[] {cand + perKm * DriveModel.distanceKm(t.lat(nr), t.lon(nc), t.lat(r1), t.lon(c1)), next});
          }
        }
      }
    }
    if (start != goal && parent[goal] < 0) return null;

    final List<double[]> cells = new ArrayList<>();
    for (int c = goal; c != start; c = parent[c]) cells.add(0, new double[] {t.lon(c % t.ncols), t.lat(c / t.ncols)});
    // The exact end points replace the centres of the first and last cells.
    final List<double[]> wp = new ArrayList<>();
    wp.add(round(lon0, lat0));
    for (int i = 0; i < cells.size() - 1; i++) wp.add(round(cells.get(i)[0], cells.get(i)[1]));
    wp.add(round(lon1, lat1));
    return measure(t, wp);
  }

  /** Distance, duration and drive energy of a waypoint list, leg by leg, exactly as the Drive activity simulates it. */
  public static Path measure(Terrain t, List<double[]> wp) {
    double km = 0, wh = 0, maxSlope = 0;
    long seconds = 0;
    for (int i = 1; i < wp.size(); i++) {
      final double legKm = DriveModel.distanceKm(wp.get(i - 1)[1], wp.get(i - 1)[0], wp.get(i)[1], wp.get(i)[0]);
      final double slope = DriveModel.legSlopeDeg(t, wp.get(i)[1], wp.get(i)[0]);
      final long s = DriveModel.legSeconds(legKm, slope);
      km += legKm;
      seconds += s;
      wh += DriveModel.drivePowerW(slope) * s / 3600.0;
      maxSlope = Math.max(maxSlope, slope);
    }
    return new Path(wp, km, seconds, wh, maxSlope);
  }

  private static double cost(Objective o, double km, double slopeDeg) {
    final double seconds = km * 1000 / DriveModel.speedMetersPerSecond(slopeDeg);
    return switch (o) {
      case MIN_DISTANCE -> km;
      case MIN_TIME -> seconds;
      case MIN_ENERGY -> DriveModel.drivePowerW(slopeDeg) * seconds / 3600.0;
    };
  }

  private static boolean passable(Terrain t, int col, int row, double maxSlopeDeg, List<List<double[]>> avoid) {
    final double s = t.slope(col, row);
    if (Double.isNaN(s) || s > maxSlopeDeg) return false;
    for (final List<double[]> ring : avoid) if (inRing(t.lon(col), t.lat(row), ring)) return false;
    return true;
  }

  /** Ray casting on [lon, lat] vertices; planar, which suits regions a few km across. */
  static boolean inRing(double x, double y, List<double[]> ring) {
    boolean inside = false;
    for (int i = 0, j = ring.size() - 1; i < ring.size(); j = i++) {
      final double xi = ring.get(i)[0], yi = ring.get(i)[1], xj = ring.get(j)[0], yj = ring.get(j)[1];
      if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  private static double[] round(double lon, double lat) {
    return new double[] {Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6};
  }

  /**
   * A traverse from (lat, lon) starting at {@code startSec}: the visiting order that collects the most
   * site priority by {@code endSec}, and among those the one that finishes first. Each leg is routed by
   * {@link #route}; every candidate order is played forward in time, so night, recharge stops and the
   * daylight rule count exactly as they will be scheduled.
   */
  public static Itinerary plan(Terrain t, List<Site> sites, List<List<double[]>> avoid, Objective objective, double maxSlopeDeg,
                               Power power, Daylight daylight, double minSOC, double lat, double lon, long startSec, long endSec, long observeSec) {
    if (sites.size() > MAX_SITES) throw new IllegalArgumentException("at most " + MAX_SITES + " sites, got " + sites.size());
    final List<String> notes = new ArrayList<>();
    final int n = sites.size();
    // paths[i][j]: from node i to site j, where node n is the start.
    final Path[][] paths = new Path[n + 1][n];
    for (int i = 0; i <= n; i++) {
      for (int j = 0; j < n; j++) {
        if (i == j) continue;
        final double fromLat = i == n ? lat : sites.get(i).lat(), fromLon = i == n ? lon : sites.get(i).lon();
        paths[i][j] = route(t, fromLat, fromLon, sites.get(j).lat(), sites.get(j).lon(), objective, maxSlopeDeg, avoid);
      }
    }
    for (int j = 0; j < n; j++) {
      if (paths[n][j] == null) notes.add("site " + sites.get(j).id() + " cannot be reached: no route within the slope limit and outside the avoided regions");
    }
    final Walker w = new Walker(t, power, daylight, minSOC, endSec, observeSec);
    final int[] best = search(sites, paths, w, new State(startSec, power.socPct()));

    final List<Step> steps = new ArrayList<>();
    final List<Site> visited = new ArrayList<>();
    State st = new State(startSec, power.socPct());
    int from = n;
    for (final int j : best) {
      final Visit v = w.visit(st, paths[from][j], sites.get(j));
      steps.addAll(v.steps());
      visited.add(sites.get(j));
      st = v.end();
      from = j;
    }
    for (final Site s : sites) {
      if (!visited.contains(s) && notes.stream().noneMatch(x -> x.startsWith("site " + s.id() + " "))) notes.add("site " + s.id() + " not visited: no time for it before the plan end");
    }
    if (daylight.daylightOnly()) notes.add(String.format("drives only with the Sun at least %.0f° high, starting with %d min of that left", daylight.minSunElevationDeg(), daylight.marginSec() / 60));
    return new Itinerary(steps, visited, notes);
  }

  /** Where the traverse stands: seconds from plan start, estimated state of charge. */
  record State(long t, double soc) {}

  /** The activities that take the rover to a site and observe it, and the state after. */
  record Visit(State end, List<Step> steps) {}

  /** Plays a traverse forward in time: drives, recharge stops, nights and observations. */
  static final class Walker {
    final Terrain terrain;
    final Power power;
    final Daylight day;
    final double minSOC;
    final long endSec, observeSec;

    Walker(Terrain terrain, Power power, Daylight day, double minSOC, long endSec, long observeSec) {
      this.terrain = terrain;
      this.power = power;
      this.day = day;
      this.minSOC = minSOC;
      this.endSec = endSec;
      this.observeSec = observeSec;
    }

    long ms(long sec) {
      return day.planStartMs() + sec * 1000;
    }

    double arrayW(long sec, double lat, double lon) {
      final MarsSun.Sky sky = MarsSun.sky(ms(sec));
      return DriveModel.arrayW(power.arrayZenithW1AU(), MarsSun.elevationDeg(sky, lat, lon), sky.au());
    }

    /** State of charge after {@code dur} seconds from {@code t} with a load of {@code loadW} on top of the idle load. */
    double charge(double soc, long t, long dur, double lat, double lon, double loadW) {
      for (long a = 0; a < dur; a += SUN_STEP_SEC) {
        final long d = Math.min(SUN_STEP_SEC, dur - a);
        final double w = arrayW(t + a + d / 2, lat, lon) - DriveModel.IDLE_W - loadW;
        soc = Math.min(100, soc + w * d / 3600.0 / power.capacityWh() * 100);
      }
      return soc;
    }

    boolean sunUp(long sec, double lat, double lon) {
      return MarsSun.elevationDeg(ms(sec), lat, lon) >= day.minSunElevationDeg();
    }

    /** Seconds from plan start at which the drive window next closes (or opens), at or after {@code sec}; MAX_VALUE beyond a sol and a half. */
    long next(long sec, double lat, double lon, boolean opening) {
      final long ms = MarsSun.nextCrossing(ms(sec), ms(sec) + 133_200_000L, lat, lon, day.minSunElevationDeg(), opening, SUN_STEP_SEC * 1000);
      return ms == Long.MAX_VALUE ? Long.MAX_VALUE : Math.floorDiv(ms - day.planStartMs() + 999, 1000);
    }

    /** Earliest time at or after {@code t} at which a drive may start here. */
    long drivable(long t, double lat, double lon) {
      if (!day.daylightOnly()) return t;
      for (int k = 0; k < 4; k++) {
        if (sunUp(t, lat, lon)) {
          final long close = next(t, lat, lon, false);
          if (close - t >= day.marginSec() + WINDOW_GUARD_SEC) return t;
          t = close;
        }
        final long open = next(t, lat, lon, true);
        if (open == Long.MAX_VALUE) return Long.MAX_VALUE;
        t = open + WINDOW_GUARD_SEC;
      }
      return Long.MAX_VALUE;
    }

    /** Drive the path from {@code s} and observe the site, or null if that cannot finish by the plan end. */
    Visit visit(State s, Path path, Site site) {
      final List<double[]> wp = path.waypoints();
      final List<Step> steps = new ArrayList<>();
      long t = s.t();
      double soc = s.soc();
      int segStart = -1, part = 1, stuck = 0;
      boolean closed = false; // the last drive stopped because its window was closing
      long segStartT = 0, close = Long.MAX_VALUE;
      for (int i = 1; i < wp.size(); i++) {
        final double lat = wp.get(i - 1)[1], lon = wp.get(i - 1)[0];
        if (segStart < 0) {
          final long go = drivable(t, lat, lon);
          if (go > endSec) return null;
          if (go > t) {
            final double e = MarsSun.elevationDeg(ms(t), lat, lon);
            final String why = e < day.minSunElevationDeg() ? String.format("night: Sun below %.0f°", day.minSunElevationDeg())
                : closed ? String.format("night: Sun about to drop below %.0f°", day.minSunElevationDeg())
                : String.format("night: under %d min of drive window left", day.marginSec() / 60);
            soc = waitStep(steps, site, t, go, soc, lat, lon, why);
            t = go;
          }
          segStart = i - 1;
          segStartT = t;
          close = day.daylightOnly() ? next(t, lat, lon, false) - WINDOW_GUARD_SEC : Long.MAX_VALUE;
        }
        final double km = DriveModel.distanceKm(lat, lon, wp.get(i)[1], wp.get(i)[0]);
        final double slope = DriveModel.legSlopeDeg(terrain, wp.get(i)[1], wp.get(i)[0]);
        final long legSec = DriveModel.legSeconds(km, slope);
        final double after = charge(soc, t, legSec, lat, lon, DriveModel.drivePowerW(slope));
        final boolean low = after < minSOC && soc < RESUME_SOC;
        closed = !low && t + legSec > close;
        if (low || closed) {
          // Stop here: end the drive at this waypoint, then wait for charge or for the next window.
          if (i - 1 > segStart) {
            steps.add(new Step("Drive", site, part++, segStartT, t - segStartT, wp.subList(segStart, i), null));
            soc = charge(soc, t, SETTLE_SECONDS, lat, lon, 0);
            t += SETTLE_SECONDS;
            stuck = 0;
          } else if (++stuck > 2) {
            return null; // this leg never fits a window or a charge: the route cannot be driven
          }
          segStart = -1;
          if (low) {
            long u = t;
            double c = soc;
            while (c < RESUME_SOC) {
              if (u > endSec) return null;
              c = charge(c, u, SUN_STEP_SEC, lat, lon, 0);
              u += SUN_STEP_SEC;
            }
            soc = waitStep(steps, site, t, u, soc, lat, lon, String.format("recharge to %.0f %%", RESUME_SOC));
            t = u;
          }
          i--;
          continue;
        }
        soc = after;
        t += legSec;
      }
      if (segStart >= 0 && wp.size() - 1 > segStart) steps.add(new Step("Drive", site, part, segStartT, t - segStartT, wp.subList(segStart, wp.size()), null));
      final double[] end = wp.get(wp.size() - 1);
      soc = charge(soc, t, SETTLE_SECONDS, end[1], end[0], 0);
      t += SETTLE_SECONDS;
      if (t + observeSec > endSec) return null;
      steps.add(new Step("Observe", site, 1, t, observeSec, List.of(), null));
      soc = charge(soc, t, observeSec, end[1], end[0], DriveModel.OBSERVE_W);
      return new Visit(new State(t + observeSec, soc), steps);
    }

    /** A Wait from {@code from} to {@code to}, merged into a Wait just before it; the state of charge at its end. */
    double waitStep(List<Step> steps, Site site, long from, long to, double soc, double lat, double lon, String why) {
      final Step last = steps.isEmpty() ? null : steps.get(steps.size() - 1);
      if (last != null && last.type().equals("Wait") && last.startSec() + last.durationSec() == from)
        steps.set(steps.size() - 1, new Step("Wait", site, 1, last.startSec(), to - last.startSec(), List.of(), last.reason() + ", then " + why));
      else steps.add(new Step("Wait", site, 1, from, to - from, List.of(), why));
      return charge(soc, from, to - from, lat, lon, 0);
    }
  }

  /**
   * Depth-first over visiting orders, each played forward by the walker: most total priority by the plan
   * end, then earliest finish. A branch is cut once even all the sites left could not beat the best.
   */
  private static int[] search(List<Site> sites, Path[][] paths, Walker w, State start) {
    final int n = sites.size();
    final int[][] best = {new int[0]};
    final double[] bestScore = {0, Double.MAX_VALUE}; // priority, finish
    final int[] order = new int[n];
    final boolean[] used = new boolean[n];
    final int total = sites.stream().mapToInt(Site::priority).sum();
    new Object() {
      void go(int depth, int from, State st, int priority, int left) {
        if (priority > bestScore[0] || (priority == bestScore[0] && depth > 0 && st.t() < bestScore[1])) {
          bestScore[0] = priority;
          bestScore[1] = st.t();
          best[0] = Arrays.copyOf(order, depth);
        }
        if (priority + left < bestScore[0]) return;
        for (int j = 0; j < n; j++) {
          if (used[j] || paths[from][j] == null) continue;
          final Visit v = w.visit(st, paths[from][j], sites.get(j));
          if (v == null) continue;
          used[j] = true;
          order[depth] = j;
          go(depth + 1, j, v.end(), priority + sites.get(j).priority(), left - sites.get(j).priority());
          used[j] = false;
        }
      }
    }.go(0, n, start, 0, total);
    return best[0];
  }

  // ---------- GeoJSON inputs ----------

  /** Point features → sites. {@code properties.priority} defaults to 1 and is clamped to 1..3. */
  public static List<Site> parseSites(String geojson) {
    final List<Site> out = new ArrayList<>();
    final JsonArray features = JsonParser.parseString(geojson).getAsJsonObject().getAsJsonArray("features");
    for (int i = 0; i < features.size(); i++) {
      final JsonObject f = features.get(i).getAsJsonObject();
      final JsonObject geom = f.getAsJsonObject("geometry");
      if (!"Point".equals(geom.get("type").getAsString())) throw new IllegalArgumentException("sites must be Point features, got " + geom.get("type"));
      final JsonArray c = geom.getAsJsonArray("coordinates");
      final JsonObject props = f.has("properties") && f.get("properties").isJsonObject() ? f.getAsJsonObject("properties") : new JsonObject();
      final JsonElement id = f.get("id");
      final String siteId = id == null || id.isJsonNull() ? Integer.toString(i) : id.getAsString();
      final JsonElement name = props.get("name"), priority = props.get("priority");
      out.add(new Site(
          siteId,
          name == null || name.isJsonNull() ? siteId : name.getAsString(),
          c.get(1).getAsDouble(),
          c.get(0).getAsDouble(),
          priority == null || priority.isJsonNull() ? 1 : Math.max(1, Math.min(3, priority.getAsInt()))));
    }
    return out;
  }

  /** Polygon features → outer rings of [lon, lat]. Blank input is no regions. */
  public static List<List<double[]>> parsePolygons(String geojson) {
    final List<List<double[]>> out = new ArrayList<>();
    if (geojson == null || geojson.isBlank()) return out;
    for (final JsonElement fe : JsonParser.parseString(geojson).getAsJsonObject().getAsJsonArray("features")) {
      final JsonObject geom = fe.getAsJsonObject().getAsJsonObject("geometry");
      if (!"Polygon".equals(geom.get("type").getAsString())) throw new IllegalArgumentException("avoid must be Polygon features, got " + geom.get("type"));
      final List<double[]> ring = new ArrayList<>();
      for (final JsonElement p : geom.getAsJsonArray("coordinates").get(0).getAsJsonArray()) {
        ring.add(new double[] {p.getAsJsonArray().get(0).getAsDouble(), p.getAsJsonArray().get(1).getAsDouble()});
      }
      out.add(ring);
    }
    return out;
  }
}
