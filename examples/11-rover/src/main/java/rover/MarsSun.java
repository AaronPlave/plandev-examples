package rover;

/**
 * Where the Sun is in a Mars surface location's sky, from the Mars24 algorithm (Allison and McEwen,
 * Planet. Space Sci. 48, 215, 2000; NASA GISS "Mars24 Sunclock" technical notes). Deterministic, no
 * kernels: both the mission model and the scheduling goal call it, so they agree on the sky exactly.
 *
 * <p>Conventions:
 * <ul>
 *   <li>Time: UTC milliseconds since the Unix epoch. TT − UTC is taken as 69.184 s (leap seconds as of
 *       2017; none announced since).
 *   <li>Location: planetocentric latitude and east-positive longitude in degrees, IAU_MARS, as everywhere
 *       else in this mission. Latitude is converted to planetographic (the ellipsoid normal) for the sky.
 *   <li>Elevation is geometric: the Sun's centre above the ellipsoid's local horizontal plane. No
 *       refraction, no terrain horizon, no atmosphere. Whether nearby terrain shadows the rover is not
 *       modeled.
 * </ul>
 *
 * <p>Checked against SPICE (de440s, mar097, pck00011, LT+S) in {@code MarsSunTest} to 0.003° in elevation.
 */
public final class MarsSun {
  private MarsSun() {}

  /** TT − UTC, seconds. */
  public static final double TT_MINUS_UTC_S = 69.184;
  /** IAU 2015 Mars ellipsoid flattening, (3396.19 − 3376.20) / 3396.19. */
  public static final double FLATTENING = (3396.19 - 3376.20) / 3396.19;

  private static final double[] PBS_A = {0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.0020, 0.0018};
  private static final double[] PBS_TAU = {2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493};
  private static final double[] PBS_PHI = {49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095};

  /**
   * The Sun at one instant, independent of location: areocentric solar longitude {@code ls}, planetographic
   * subsolar latitude {@code decl} and east longitude {@code subLon} (degrees), heliocentric distance {@code au},
   * and Mars Coordinated Time at the prime meridian, {@code mstHours}.
   */
  public record Sky(double ls, double decl, double subLon, double au, double mstHours) {}

  public static Sky sky(long utcMs) {
    final double jdTT = 2440587.5 + (utcMs / 1000.0 + TT_MINUS_UTC_S) / 86400.0;
    final double dt = jdTT - 2451545.0; // days from J2000 (TT)
    final double m = 19.3871 + 0.52402073 * dt; // mean anomaly
    final double alphaFms = 270.3871 + 0.524038496 * dt; // fictitious mean sun
    double pbs = 0;
    for (int i = 0; i < PBS_A.length; i++) pbs += PBS_A[i] * cosd(0.985626 * dt / PBS_TAU[i] + PBS_PHI[i]);
    final double eqCentre = (10.691 + 3.0e-7 * dt) * sind(m) + 0.623 * sind(2 * m) + 0.050 * sind(3 * m)
        + 0.005 * sind(4 * m) + 0.0005 * sind(5 * m) + pbs; // ν − M
    final double ls = mod(alphaFms + eqCentre, 360);
    final double eot = 2.861 * sind(2 * ls) - 0.071 * sind(4 * ls) + 0.002 * sind(6 * ls) - eqCentre; // degrees
    final double mst = mod(24 * ((jdTT - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626), 24);
    // Mars24 adds 0.25° sin Ls to its "planetographic" declination; the plain term is the Sun direction's
    // declination in IAU_MARS, which is what the ellipsoid-normal elevation needs (SPICE agrees to 0.003°).
    final double decl = Math.toDegrees(Math.asin(0.42565 * sind(ls)));
    // Subsolar west longitude is MST·15 + EOT + 180; east-positive here.
    final double subLon = mod(-(mst * 15 + eot + 180), 360);
    final double au = 1.523679 * (1.00436 - 0.09309 * cosd(m) - 0.004336 * cosd(2 * m) - 0.00031 * cosd(3 * m) - 0.00003 * cosd(4 * m));
    return new Sky(ls, decl, subLon, au, mst);
  }

  /** Geometric solar elevation (degrees) at a planetocentric latitude / east longitude. */
  public static double elevationDeg(long utcMs, double latDeg, double lonEastDeg) {
    return elevationDeg(sky(utcMs), latDeg, lonEastDeg);
  }

  public static double elevationDeg(Sky s, double latDeg, double lonEastDeg) {
    final double phi = planetographic(latDeg);
    final double h = lonEastDeg - s.subLon(); // hour angle
    return Math.toDegrees(Math.asin(sind(phi) * sind(s.decl()) + cosd(phi) * cosd(s.decl()) * cosd(h)));
  }

  /** Local true solar time, hours (12 = the Sun on the meridian). */
  public static double localTrueSolarTimeHours(long utcMs, double lonEastDeg) {
    return mod(12 + (lonEastDeg - sky(utcMs).subLon()) / 15, 24);
  }

  public static double planetographic(double planetocentricLatDeg) {
    final double k = (1 - FLATTENING) * (1 - FLATTENING);
    return Math.toDegrees(Math.atan(Math.tan(Math.toRadians(planetocentricLatDeg)) / k));
  }

  /**
   * The first time at or after {@code fromMs} (within {@code limitMs}) at which the Sun's elevation is
   * {@code rising ? at least : below} {@code thresholdDeg}, to {@code stepMs / 2^10} precision; {@code Long.MAX_VALUE}
   * if there is none. Coarse scan, then bisection.
   */
  public static long nextCrossing(long fromMs, long limitMs, double latDeg, double lonEastDeg, double thresholdDeg, boolean rising, long stepMs) {
    final java.util.function.LongPredicate hit = t -> (elevationDeg(t, latDeg, lonEastDeg) >= thresholdDeg) == rising;
    if (hit.test(fromMs)) return fromMs;
    for (long t = fromMs; t < limitMs; t += stepMs) {
      final long next = Math.min(t + stepMs, limitMs);
      if (!hit.test(next)) continue;
      long lo = t, hi = next; // !hit(lo), hit(hi)
      while (hi - lo > Math.max(1, stepMs >> 10)) {
        final long mid = (lo + hi) >>> 1;
        if (hit.test(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    return Long.MAX_VALUE;
  }

  private static double sind(double d) {
    return Math.sin(Math.toRadians(d));
  }

  private static double cosd(double d) {
    return Math.cos(Math.toRadians(d));
  }

  private static double mod(double x, double m) {
    return ((x % m) + m) % m;
  }
}
