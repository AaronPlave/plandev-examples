package moonfall;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The drone's fictional downward survey camera and its footprint on the terrain. <b>All camera numbers are
 * assumptions for this demo</b>; nothing here describes MoonFall's real cameras.
 *
 * <p>Mounting: boresight along body -Z (down when the drone holds its coast attitude: +Z up), image +up along
 * body +X (the direction of travel while coasting). A rectangular field of view, {@link #H_FOV_DEG} across track
 * (body ±Y) by {@link #V_FOV_DEG} along track (body ±X).
 *
 * <p>Footprints are the rays through the image centre and four corners intersected with {@link MoonTerrain}
 * (the same terrain the flight is checked against), not with a sphere. A ray that leaves terrain coverage or
 * misses the surface makes the footprint unavailable rather than approximated.
 */
public final class Camera {
  private Camera() {}

  public static final double H_FOV_DEG = 40, V_FOV_DEG = 30;
  public static final int WIDTH_PX = 2048, HEIGHT_PX = 1536;
  /** 12-bit pixels, 4:1 compression. */
  public static final double MBIT_PER_IMAGE = WIDTH_PX * HEIGHT_PX * 12 / 4.0 / 1e6;
  public static final double POWER_W = 8;
  /** Imaging only after the attitude has settled into nadir hold. */
  public static final double SETTLE_S = 3;
  public static final double MAX_RANGE_M = 20_000;

  /** Body-frame boresight and image-up axes. */
  public static final double[] BORESIGHT = {0, 0, -1}, UP = {1, 0, 0};

  public enum Status { OK, NOT_IN_IMAGING_ATTITUDE, NO_TERRAIN_INTERSECTION }

  /**
   * A footprint: centre and corners (lat, lon degrees, planetocentric MOON_ME_DE421), ordered around the image, and the
   * image centre's terrain point (MOON_ME_DE421 metres) for evaluating it.
   */
  public record Footprint(Status status, String reason, double[] center, List<double[]> corners, double slantRangeM, double gsdM, double[] centerM) {}

  /** Body-frame unit vectors of the image centre and corners (+up/+right, +up/-right, -up/-right, -up/+right). */
  static List<double[]> rays() {
    final double tx = Math.tan(Math.toRadians(V_FOV_DEG / 2)), ty = Math.tan(Math.toRadians(H_FOV_DEG / 2));
    final List<double[]> out = new ArrayList<>();
    out.add(BORESIGHT.clone());
    for (final double[] s : new double[][] {{1, 1}, {1, -1}, {-1, -1}, {-1, 1}}) {
      out.add(Vec.unit(Vec.of(s[0] * tx, s[1] * ty, -1)));
    }
    return out;
  }

  public static Footprint footprint(double[] rM, double[] q, MoonTerrain terrain) {
    final List<double[]> hits = new ArrayList<>();
    for (final double[] body : rays()) {
      final double[] dir = Vec.unrotate(q, body);
      final double[] hit = terrain.intersect(rM, dir, MAX_RANGE_M, 5);
      if (hit == null) {
        return new Footprint(Status.NO_TERRAIN_INTERSECTION, String.format(Locale.ROOT, "a camera ray leaves the terrain or the %.0f km range", MAX_RANGE_M / 1000),
            null, List.of(), 0, 0, null);
      }
      hits.add(hit);
    }
    final double range = Vec.norm(Vec.sub(hits.get(0), rM));
    final double gsd = range * Math.toRadians(H_FOV_DEG) / WIDTH_PX;
    final List<double[]> corners = hits.subList(1, 5).stream().map(Camera::latLon).toList();
    return new Footprint(Status.OK, "", latLon(hits.get(0)), corners, range, gsd, hits.get(0));
  }

  // --- Usable science: a geometric footprint is not yet a usable image -----------------------------------------

  /*
   * The conceptual camera's imaging capability. These are ASSUMPTIONS for the demo, stated so that every exposure is
   * judged by the same rule; they are not MoonFall's camera:
   *  - no illuminator and no low-light mode: the ground at the image centre must be directly sunlit — the Sun above
   *    the local terrain horizon (LunarSky.terrainBlocked, within the terrain pack) — at an incidence on the local
   *    terrain of at most MAX_INCIDENCE_DEG. Light scattered into shadow (e.g. a PSR floor lit by a sunlit crater
   *    wall) is NOT modelled, so this camera cannot use it; a camera that could would be a different capability.
   *  - exposure EXPOSURE_S: the drone's motion across the line of sight during it may smear at most MAX_SMEAR_PX.
   * Evaluated at each exposure's own instant and position (not the 10-minute sky resources).
   */
  public static final double EXPOSURE_S = 0.004, MAX_INCIDENCE_DEG = 87, MAX_SMEAR_PX = 1;
  /** Terrain normal baseline at the image centre (about one image's GSD scale at survey heights). */
  public static final double NORMAL_BASELINE_M = 15;
  public static final String CAPABILITY = String.format(Locale.ROOT,
      "conceptual camera: no illuminator; image centre directly sunlit (Sun above the terrain-pack horizon) at incidence <= %.0f deg; %.0f ms exposure, smear <= %.0f px",
      MAX_INCIDENCE_DEG, EXPOSURE_S * 1000, MAX_SMEAR_PX);

  public enum Usability { USABLE, IN_SHADOW, SUN_TOO_LOW, SMEARED, NOT_EVALUATED }
  public static final Quality NOT_EVALUATED = new Quality(Usability.NOT_EVALUATED, "no footprint", -1, -1, "", -1);

  /** How one geometric exposure fares against {@link #CAPABILITY}. Angles and smear are -1 where not evaluated (no NaN in PlanDev JSON). */
  public record Quality(Usability usability, String reason, double sunIncidenceDeg, double sunElevationDeg, String sunView, double smearPx) {
    public boolean usable() { return usability == Usability.USABLE; }
  }

  /**
   * Evaluates a taken footprint: illumination at its centre's terrain point at {@code t}, and smear from the drone's
   * velocity {@code vMps} (MOON_ME_DE421) across the boresight during the exposure.
   */
  public static Quality quality(Footprint fp, double[] rM, double[] vMps, java.time.Instant t, MoonTerrain terrain) {
    if (fp.status() != Status.OK) return NOT_EVALUATED;
    final double[] ground = fp.centerM();
    final double[] sun = LunarSky.direction("SUN", t, ground);
    final double elevation = LunarSky.elevationDeg(ground, sun);
    final LunarSky.TerrainView view = LunarSky.terrainBlocked(terrain, ground, sun);
    final double[] n = terrain.normal(ground, NORMAL_BASELINE_M);
    final double incidence = Math.toDegrees(Vec.angle(n != null ? n : Vec.unit(ground), sun));
    final double[] los = Vec.unit(Vec.sub(ground, rM));
    final double smearPx = Vec.norm(Vec.reject(vMps, los)) * EXPOSURE_S / fp.gsdM();
    final Usability u;
    final String why;
    if (view != LunarSky.TerrainView.CLEAR_WITHIN_TERRAIN_PACK) {
      u = Usability.IN_SHADOW;
      why = String.format(Locale.ROOT, "image centre not directly sunlit (Sun %s, %.2f deg above the reference horizon); this camera has no illuminator and cannot use scattered light", view, elevation);
    } else if (incidence > MAX_INCIDENCE_DEG) {
      u = Usability.SUN_TOO_LOW;
      why = String.format(Locale.ROOT, "sunlit at %.1f deg incidence on the local terrain (limit %.0f)", incidence, MAX_INCIDENCE_DEG);
    } else if (smearPx > MAX_SMEAR_PX) {
      u = Usability.SMEARED;
      why = String.format(Locale.ROOT, "%.2f px smear in the %.0f ms exposure (limit %.0f)", smearPx, EXPOSURE_S * 1000, MAX_SMEAR_PX);
    } else {
      u = Usability.USABLE;
      why = "";
    }
    return new Quality(u, why, incidence, elevation, view.name(), smearPx);
  }

  /**
   * Distance (m, in the south-polar plane) from a region's centroid to the nearest point of any footprint, or -1
   * without footprints: why a 0 % coverage came out, when the images were simply elsewhere.
   */
  public static double nearestFootprintM(List<double[]> regionLatLon, List<List<double[]>> footprintsLatLon) {
    if (regionLatLon.isEmpty() || footprintsLatLon.isEmpty()) return -1;
    double cx = 0, cy = 0;
    for (final double[] p : regionLatLon) { final double[] q = polar(p[0], p[1]); cx += q[0] / regionLatLon.size(); cy += q[1] / regionLatLon.size(); }
    double best = Double.POSITIVE_INFINITY;
    for (final List<double[]> f : footprintsLatLon) {
      final List<double[]> poly = f.stream().map(p -> polar(p[0], p[1])).toList();
      if (inside(new double[] {cx, cy}, poly)) return 0;
      for (int i = 0; i < poly.size(); i++) {
        final double[] a = poly.get(i), b = poly.get((i + 1) % poly.size());
        final double dx = b[0] - a[0], dy = b[1] - a[1];
        final double t = Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(a[0] + t * dx - cx, a[1] + t * dy - cy));
      }
    }
    return best;
  }

  static double[] latLon(double[] r) {
    return new double[] {Vec.latDeg(r), Vec.lonDeg(r)};
  }

  // --- Coverage of a region by footprints, in a south-polar stereographic plane (no pole singularity) ---------

  /** South-polar stereographic metres. */
  public static double[] polar(double latDeg, double lonDeg) {
    final double rho = 2 * MoonTerrain.RADIUS_M * Math.tan(Math.toRadians(90 + latDeg) / 2);
    return new double[] {rho * Math.cos(Math.toRadians(lonDeg)), rho * Math.sin(Math.toRadians(lonDeg))};
  }

  static boolean inside(double[] p, List<double[]> poly) {
    boolean in = false;
    for (int i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
      final double[] a = poly.get(i), b = poly.get(j);
      if ((a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) in = !in;
    }
    return in;
  }

  /**
   * Fraction of a region (lat/lon ring, degrees) inside at least one footprint, on a {@code stepM} grid in the
   * polar plane. Footprint edges are straight in that plane (a few metres from the true curve at these ranges).
   */
  public static double coverage(List<double[]> regionLatLon, List<List<double[]>> footprintsLatLon, double stepM) {
    final List<double[]> region = regionLatLon.stream().map(p -> polar(p[0], p[1])).toList();
    final List<List<double[]>> fps = footprintsLatLon.stream().map(f -> f.stream().map(p -> polar(p[0], p[1])).toList()).toList();
    double minX = Double.POSITIVE_INFINITY, minY = minX, maxX = Double.NEGATIVE_INFINITY, maxY = maxX;
    for (final double[] p : region) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
    int total = 0, covered = 0;
    for (double x = minX + stepM / 2; x < maxX; x += stepM) {
      for (double y = minY + stepM / 2; y < maxY; y += stepM) {
        final double[] p = {x, y};
        if (!inside(p, region)) continue;
        total++;
        for (final List<double[]> f : fps) if (inside(p, f)) { covered++; break; }
      }
    }
    return total == 0 ? 0 : (double) covered / total;
  }
}
