package scheduling;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import rover.DriveModel;
import rover.Terrain;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.PriorityQueue;

/**
 * Plans a rover traverse over the terrain grid: which sites to visit, in what order, along which
 * cells, and when to stop and recharge. Pure functions of their inputs, so the goal that calls them
 * ({@code ScheduleTraverse}) is reproducible and testable without PlanDev.
 *
 * <p>Every duration and energy here comes from {@link DriveModel}, which the simulation also uses.
 */
public final class TraversePlanner {
  public enum Objective { MIN_DISTANCE, MIN_TIME, MIN_ENERGY }

  public record Site(String id, String name, double lat, double lon, int priority) {}

  /** A route between two points. Waypoints are [longitude, latitude], rounded to 1e-6 degrees. */
  public record Path(List<double[]> waypoints, double km, long seconds, double driveWh, double maxSlopeDeg) {}

  /** The battery as simulated at the start of the traverse. */
  public record Power(double socPct, double capacityWh, double productionW) {}

  /** One activity to create: type "Drive" (with waypoints) or "Observe". Times are seconds from plan start. */
  public record Step(String type, Site site, int part, long startSec, long durationSec, List<double[]> waypoints) {}

  public record Itinerary(List<Step> steps, List<Site> visited, List<String> notes) {}

  /** The planner recharges to this state of charge before driving on. */
  public static final double RESUME_SOC = 95.0;
  /** Pause after each drive before the next activity. */
  public static final long SETTLE_SECONDS = 60;
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
   * site priority by {@code endSec}, and among those the quickest, counting recharge time. Each leg is
   * routed by {@link #route}; a drive is split, and the rover waits to recharge, wherever the
   * estimated state of charge would fall below {@code minSOC}.
   */
  public static Itinerary plan(Terrain t, List<Site> sites, List<List<double[]>> avoid, Objective objective, double maxSlopeDeg,
                               Power power, double minSOC, double lat, double lon, long startSec, long endSec, long observeSec) {
    if (sites.size() > MAX_SITES) throw new IllegalArgumentException("at most " + MAX_SITES + " sites, got " + sites.size());
    final double rechargeW = power.productionW() - DriveModel.IDLE_W;
    if (rechargeW <= 0) throw new IllegalArgumentException("the array produces no more than the idle load; the rover cannot recharge");
    final List<String> notes = new ArrayList<>();
    final int n = sites.size();
    // paths[i][j]: from node i to site j, where node n is the start.
    final Path[][] paths = new Path[n + 1][n];
    final double[][] legSeconds = new double[n + 1][n];
    for (int i = 0; i <= n; i++) {
      for (int j = 0; j < n; j++) {
        if (i == j) continue;
        final double fromLat = i == n ? lat : sites.get(i).lat(), fromLon = i == n ? lon : sites.get(i).lon();
        final Path p = route(t, fromLat, fromLon, sites.get(j).lat(), sites.get(j).lon(), objective, maxSlopeDeg, avoid);
        paths[i][j] = p;
        if (p == null) continue;
        // Time to earn back what the leg takes out of the battery, at the resting recharge rate.
        final double netWh = p.driveWh() - rechargeW * p.seconds() / 3600.0;
        legSeconds[i][j] = p.seconds() + SETTLE_SECONDS + observeSec + Math.max(0, netWh) / rechargeW * 3600.0;
      }
    }
    for (int j = 0; j < n; j++) {
      if (paths[n][j] == null) notes.add("site " + sites.get(j).id() + " cannot be reached: no route within the slope limit and outside the avoided regions");
    }

    final int[] best = search(sites, paths, legSeconds, endSec - startSec);
    final List<Step> steps = new ArrayList<>();
    final List<Site> visited = new ArrayList<>();
    double soc = power.socPct();
    long time = startSec;
    int from = n;
    for (final int j : best) {
      final Site site = sites.get(j);
      final List<double[]> wp = paths[from][j].waypoints();
      final List<Step> legSteps = new ArrayList<>();
      int segStart = 0, part = 1;
      long segStartSec = time;
      for (int i = 1; i < wp.size(); i++) {
        final double km = DriveModel.distanceKm(wp.get(i - 1)[1], wp.get(i - 1)[0], wp.get(i)[1], wp.get(i)[0]);
        final double slope = DriveModel.legSlopeDeg(t, wp.get(i)[1], wp.get(i)[0]);
        final long s = DriveModel.legSeconds(km, slope);
        final double dSoc = (rechargeW - DriveModel.drivePowerW(slope)) * s / 3600.0 / power.capacityWh() * 100;
        if (soc + dSoc < minSOC && soc < RESUME_SOC) {
          if (i - 1 > segStart) {
            legSteps.add(new Step("Drive", site, part++, segStartSec, time - segStartSec, wp.subList(segStart, i)));
            time += SETTLE_SECONDS;
          }
          time += Math.round((RESUME_SOC - soc) / 100 * power.capacityWh() / rechargeW * 3600);
          soc = RESUME_SOC;
          segStart = i - 1;
          segStartSec = time;
        }
        soc = Math.min(100, soc + dSoc);
        time += s;
      }
      if (wp.size() - 1 > segStart) legSteps.add(new Step("Drive", site, part, segStartSec, time - segStartSec, wp.subList(segStart, wp.size())));
      time += SETTLE_SECONDS;
      if (time + observeSec > endSec) {
        notes.add("site " + site.id() + " and any after it dropped: the traverse would run past the plan end");
        break;
      }
      steps.addAll(legSteps);
      steps.add(new Step("Observe", site, 1, time, observeSec, List.of()));
      soc = Math.min(100, soc + (rechargeW - DriveModel.OBSERVE_W) * observeSec / 3600.0 / power.capacityWh() * 100);
      time += observeSec;
      visited.add(site);
      from = j;
    }
    for (final Site s : sites) {
      if (!visited.contains(s) && notes.stream().noneMatch(x -> x.startsWith("site " + s.id() + " "))) notes.add("site " + s.id() + " not visited: no time for it before the plan end");
    }
    return new Itinerary(steps, visited, notes);
  }

  /** Depth-first over visiting orders: most total priority within the time budget, then least time. */
  private static int[] search(List<Site> sites, Path[][] paths, double[][] legSeconds, double budgetSec) {
    final int n = sites.size();
    final int[][] best = {new int[0]};
    final double[] bestScore = {0, 0}; // priority, seconds
    final int[] order = new int[n];
    final boolean[] used = new boolean[n];
    new Object() {
      void go(int depth, int from, double seconds, int priority) {
        if (priority > bestScore[0] || (priority == bestScore[0] && depth > 0 && seconds < bestScore[1])) {
          bestScore[0] = priority;
          bestScore[1] = seconds;
          best[0] = Arrays.copyOf(order, depth);
        }
        for (int j = 0; j < n; j++) {
          if (used[j] || paths[from][j] == null || seconds + legSeconds[from][j] > budgetSec) continue;
          used[j] = true;
          order[depth] = j;
          go(depth + 1, j, seconds + legSeconds[from][j], priority + sites.get(j).priority());
          used[j] = false;
        }
      }
    }.go(0, n, 0, 0);
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
