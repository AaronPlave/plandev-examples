package rover;

/**
 * How fast the rover drives and what driving costs, as a function of terrain slope.
 *
 * <p><b>Illustrative only.</b> None of these numbers comes from a vehicle design: the rover drives
 * faster and further than any flown Mars rover, around the clock. They are chosen so that slope
 * matters to a traverse. The mission model's {@code Drive} activity and the {@code ScheduleTraverse}
 * goal both call this class, so a planned traverse and its simulation always agree on it.
 */
public final class DriveModel {
  /** Radius of the Mars 2000 sphere the terrain product is referenced to. */
  public static final double MARS_RADIUS_KM = 3396.19;

  /** Speed on level ground. */
  public static final double FLAT_SPEED_M_PER_S = 0.20;
  /** Slope at which speed has halved. */
  public static final double HALF_SPEED_SLOPE_DEG = 10.0;
  /** Mobility power on level ground, and the extra per degree of slope. */
  public static final double FLAT_DRIVE_W = 100.0;
  public static final double DRIVE_W_PER_DEG = 30.0;
  /** Always-on load (avionics, heaters). */
  public static final double IDLE_W = 60.0;
  /** Science instrument load while observing. */
  public static final double OBSERVE_W = 90.0;
  /** Below this state of charge the rover refuses to start another leg (fault protection). */
  public static final double HALT_SOC = 10.0;
  /** A Drive only starts if the rover is this close to its first waypoint. */
  public static final double ON_ROUTE_TOLERANCE_KM = 0.05;

  private DriveModel() {}

  /** Great-circle distance in km between two planetocentric lat/lon points (degrees). */
  public static double distanceKm(double lat1, double lon1, double lat2, double lon2) {
    final double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
    final double dp = p2 - p1, dl = Math.toRadians(lon2 - lon1);
    final double a = Math.sin(dp / 2) * Math.sin(dp / 2)
        + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  public static double speedMetersPerSecond(double slopeDeg) {
    return FLAT_SPEED_M_PER_S / (1 + slopeDeg / HALF_SPEED_SLOPE_DEG);
  }

  /** Mobility power while driving on a slope, excluding the idle load. */
  public static double drivePowerW(double slopeDeg) {
    return FLAT_DRIVE_W + DRIVE_W_PER_DEG * slopeDeg;
  }

  /** Whole seconds (at least 1) to drive {@code km} on a slope. */
  public static long legSeconds(double km, double slopeDeg) {
    return Math.max(1, Math.round(km * 1000 / speedMetersPerSecond(slopeDeg)));
  }

  /**
   * The slope a leg is driven at: the terrain cell its end point is in. Ground outside the grid, or
   * without data, counts as level; the planner never routes there.
   */
  public static double legSlopeDeg(Terrain terrain, double toLat, double toLon) {
    final double s = terrain.slopeAt(toLat, toLon);
    return Double.isNaN(s) ? 0.0 : s;
  }
}
