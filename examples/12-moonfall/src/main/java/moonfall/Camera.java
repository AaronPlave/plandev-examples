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

  /** A footprint: centre and corners (lat, lon degrees, planetocentric MOON_ME_DE421), ordered around the image. */
  public record Footprint(Status status, String reason, double[] center, List<double[]> corners, double slantRangeM, double gsdM) {}

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
            null, List.of(), 0, 0);
      }
      hits.add(hit);
    }
    final double range = Vec.norm(Vec.sub(hits.get(0), rM));
    final double gsd = range * Math.toRadians(H_FOV_DEG) / WIDTH_PX;
    final List<double[]> corners = hits.subList(1, 5).stream().map(Camera::latLon).toList();
    return new Footprint(Status.OK, "", latLon(hits.get(0)), corners, range, gsd);
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
