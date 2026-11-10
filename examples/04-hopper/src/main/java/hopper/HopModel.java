package hopper;

/**
 * Where the hopper is and how long a hop takes.
 *
 * <p><b>Illustrative only.</b> Hop duration is a fixed ascent/descent overhead plus cruise at a
 * constant speed over the great-circle distance. Neither number comes from a vehicle design, and
 * there is no terrain, slope, illumination, or propellant model. The mission model's
 * {@code PerformHop} and the {@code ScheduleHopTraverse} goal both call this class, so a planned
 * itinerary and its simulation always agree on it.
 */
public final class HopModel {
  /** IAU Moon mean radius. */
  public static final double MOON_RADIUS_KM = 1737.4;
  /** Illustrative ascent + descent time per hop. */
  public static final double OVERHEAD_SECONDS = 60.0;
  /** Illustrative average speed over the ground while hopping. */
  public static final double CRUISE_KM_PER_SECOND = 0.05;

  private HopModel() {}

  /** Great-circle distance in km between two planetocentric lat/lon points (degrees). */
  public static double distanceKm(double lat1, double lon1, double lat2, double lon2) {
    final double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
    final double dp = p2 - p1, dl = Math.toRadians(lon2 - lon1);
    final double a = Math.sin(dp / 2) * Math.sin(dp / 2)
        + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * MOON_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Whole seconds for a hop of {@code km}. */
  public static long hopSeconds(double km) {
    return Math.round(OVERHEAD_SECONDS + km / CRUISE_KM_PER_SECOND);
  }
}
