package scheduling.procedures;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import examples.orbiter.Mission;
import examples.orbiter.radar.RadarDataCollectionMode;
import examples.orbiter.spice.Spice;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.DurationValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.EnumValueMapper;
import gov.nasa.ammos.plandev.geometry.directspicecalls.SpiceDirectTimeDependentStateCalculator;
import gov.nasa.ammos.plandev.geometry.globals.JPLTimeConvertUtility;
import gov.nasa.ammos.plandev.geometry.interfaces.GeometryInformationNotAvailableException;
import gov.nasa.ammos.plandev.geometry.returnedobjects.LatLonCoord;
import gov.nasa.ammos.plandev.geometry.returnedobjects.SubPointInformation;
import gov.nasa.ammos.plandev.geometry.spiceinterpolation.Bodies;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.procedural.scheduling.ActivityAutoDelete;
import gov.nasa.ammos.plandev.procedural.scheduling.Goal;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.SchedulingProcedure;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.WithDefaults;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.DeletedAnchorStrategy;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.EditablePlan;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.NewDirective;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.AnyDirective;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.DirectiveStart;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Schedules one TakeRadarObservation per geographic target, centred on the time the MRO
 * sub-spacecraft point passes closest to that target within the plan bounds.
 *
 * <p>This is a <b>closest sub-spacecraft pass</b> search, not an instrument-footprint coverage
 * calculation: the model has no radar pointing or footprint geometry. A target is only scheduled
 * if the closest pass comes within {@code maxGroundDistanceKm} of it.
 *
 * <p>{@code targets} is a GeoJSON FeatureCollection (or a single Feature) of Point or Polygon
 * features on Mars, in planetocentric latitude / east-positive longitude degrees (IAU_MARS body-fixed).
 * Polygons are reduced to the mean of their outer-ring vertices. Each feature's {@code id}
 * (or {@code properties.id}) becomes the directive name suffix: {@code TargetObs <id>}, which is how
 * downstream tools associate created activities with their source features.
 *
 * <p>A feature may narrow its own search with {@code properties.window = {"start": ISO-8601 UTC, "end": …}}
 * (e.g. a candidate interval proposed from a 3D viewer). The window must lie inside the plan; it is searched
 * with the same kernels and step as the whole plan. With {@code rejectUnscheduled}, a target that cannot be
 * scheduled (no ephemeris coverage, or no pass within {@code maxGroundDistanceKm}) fails the run with the
 * reason, so nothing is committed; otherwise it is skipped and logged.
 */
@SchedulingProcedure
public record ScheduleTargetObservations(
    String targets,
    double maxGroundDistanceKm,
    Duration observationDuration,
    String mode,
    Duration searchStep,
    boolean rejectUnscheduled) implements Goal {

  public static final String NAME_PREFIX = "TargetObs ";
  /** IAU 2015 Mars mean radius, used only for great-circle ground distance. */
  public static final double MARS_MEAN_RADIUS_KM = 3389.5;

  private static final Path KERNELS = Path.of(System.getenv().getOrDefault("SPICE_DIRECTORY", "spice-kernels"));
  private static final String SPACECRAFT = "-74"; // MRO; matches the model's default spiceSpacecraftId
  private static final String BODY = "MARS";
  private static final String ABCORR = "LT+S"; // same correction the mission model uses for its geometry resources

  @WithDefaults
  public static final class Defaults {
    public static String targets = "{\"type\":\"FeatureCollection\",\"features\":[]}";
    public static double maxGroundDistanceKm = 100.0;
    public static Duration observationDuration = Duration.of(5, Duration.MINUTES);
    public static String mode = "HI_RES";
    public static Duration searchStep = Duration.of(30, Duration.SECONDS);
    public static boolean rejectUnscheduled = false;
  }

  /** {@code windowStart}/{@code windowEnd}: the feature's own search window, or null for the whole plan. */
  public record Target(String id, double latDeg, double lonDeg, Instant windowStart, Instant windowEnd) {
    public Target(String id, double latDeg, double lonDeg) {
      this(id, latDeg, lonDeg, null, null);
    }
  }
  public record Pass(Instant time, double distanceKm, double subLatDeg, double subLonDeg) {}

  @NotNull
  @Override
  public ActivityAutoDelete shouldDeletePastCreations(@NotNull Plan plan, @Nullable SimulationResults simResults) {
    return new ActivityAutoDelete.AtBeginning(DeletedAnchorStrategy.Cascade, false);
  }

  @Override
  public void run(EditablePlan plan) {
    final var radarMode = RadarDataCollectionMode.valueOf(mode);
    final List<Target> parsed = parseTargets(targets);

    Spice.initialize(KERNELS.resolve("latest_meta_kernel.tm").toString());
    final var calc = new SpiceDirectTimeDependentStateCalculator(new Bodies(Mission.class).getBodiesMap(), false);

    final Instant start = plan.toAbsolute(plan.totalBounds().start);
    final Instant end = plan.toAbsolute(plan.totalBounds().end);
    final long stepMicros = searchStep.in(Duration.MICROSECONDS);
    final long halfObsMicros = observationDuration.in(Duration.MICROSECONDS) / 2;

    for (final Target t : parsed) {
      final Instant from = t.windowStart() == null ? start : t.windowStart();
      final Instant to = t.windowEnd() == null ? end : t.windowEnd();
      if (from.isBefore(start) || to.isAfter(end) || !from.isBefore(to)) {
        throw new IllegalArgumentException("target %s: search window %s – %s is empty or outside the plan (%s – %s)"
            .formatted(t.id(), from, to, start, end));
      }
      final Pass pass = closestPass(calc, t, from, to, stepMicros);
      if (pass == null || pass.distanceKm() > maxGroundDistanceKm) {
        final String why = pass == null
            ? "no MRO ephemeris coverage between %s and %s".formatted(from, to)
            : "closest MRO sub-spacecraft pass between %s and %s is %.1f km from (%.4f, %.4f), at %s; limit %.1f km"
                .formatted(from, to, pass.distanceKm(), t.latDeg(), t.lonDeg(), pass.time(), maxGroundDistanceKm);
        if (rejectUnscheduled) throw new IllegalArgumentException("target %s not scheduled: %s".formatted(t.id(), why));
        System.out.printf("[ScheduleTargetObservations] target %s: not scheduled: %s%n", t.id(), why);
        continue;
      }
      Instant obsStart = pass.time().minusNanos(halfObsMicros * 1000);
      if (obsStart.isBefore(from)) obsStart = from;
      System.out.printf("[ScheduleTargetObservations] target %s (%.4f, %.4f): closest pass %s, %.1f km, sub-SC (%.4f, %.4f)%n",
          t.id(), t.latDeg(), t.lonDeg(), pass.time(), pass.distanceKm(), pass.subLatDeg(), pass.subLonDeg());

      plan.create(new NewDirective(
          new AnyDirective(Map.of(
              "mode", new EnumValueMapper<>(RadarDataCollectionMode.class).serializeValue(radarMode),
              "duration", new DurationValueMapper().serializeValue(observationDuration),
              "scheduled", SerializedValue.of(true),
              "schedulingPriority", SerializedValue.of(1),
              "bin", SerializedValue.of(0))),
          NAME_PREFIX + t.id(),
          "TakeRadarObservation",
          new DirectiveStart.Absolute(plan.toRelative(obsStart))));
    }
    plan.commit();
  }

  /** Coarse scan at {@code stepMicros}, then a 1-second refinement around the coarse minimum. */
  static Pass closestPass(SpiceDirectTimeDependentStateCalculator calc, Target t, Instant start, Instant end, long stepMicros) {
    Pass best = null;
    for (Instant at = start; !at.isAfter(end); at = at.plusNanos(stepMicros * 1000)) {
      final Pass p = sample(calc, t, at);
      if (p != null && (best == null || p.distanceKm() < best.distanceKm())) best = p;
    }
    if (best == null) return null;
    final Instant from = best.time().minusNanos(stepMicros * 1000);
    final Instant to = best.time().plusNanos(stepMicros * 1000);
    for (Instant at = from.isBefore(start) ? start : from; !at.isAfter(to) && !at.isAfter(end); at = at.plusSeconds(1)) {
      final Pass p = sample(calc, t, at);
      if (p != null && p.distanceKm() < best.distanceKm()) best = p;
    }
    return best;
  }

  private static Pass sample(SpiceDirectTimeDependentStateCalculator calc, Target t, Instant at) {
    try {
      final SubPointInformation sp = calc.getSubPointInformation(
          JPLTimeConvertUtility.jplTimeFromUTCInstant(at), SPACECRAFT, BODY, ABCORR, false);
      if (!sp.isFound()) return null;
      final LatLonCoord ll = new LatLonCoord(sp.getSpoint());
      final double lat = Math.toDegrees(ll.getLatitude());
      final double lon = Math.toDegrees(ll.getLongitude());
      return new Pass(at, greatCircleKm(t.latDeg(), t.lonDeg(), lat, lon), lat, lon);
    } catch (GeometryInformationNotAvailableException e) {
      return null; // outside kernel coverage
    }
  }

  static double greatCircleKm(double lat1, double lon1, double lat2, double lon2) {
    final double p1 = Math.toRadians(lat1), p2 = Math.toRadians(lat2);
    final double dp = p2 - p1, dl = Math.toRadians(lon2 - lon1);
    final double a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * MARS_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  static List<Target> parseTargets(String geojson) {
    final JsonObject root = JsonParser.parseString(geojson).getAsJsonObject();
    final JsonArray features;
    if ("Feature".equals(root.get("type").getAsString())) {
      features = new JsonArray();
      features.add(root);
    } else {
      features = root.getAsJsonArray("features");
    }
    final List<Target> out = new ArrayList<>();
    for (int i = 0; i < features.size(); i++) {
      final JsonObject f = features.get(i).getAsJsonObject();
      final JsonObject geom = f.getAsJsonObject("geometry");
      final String type = geom.get("type").getAsString();
      final JsonArray coords = geom.getAsJsonArray("coordinates");
      final double[] lonLat = switch (type) {
        case "Point" -> new double[]{coords.get(0).getAsDouble(), coords.get(1).getAsDouble()};
        case "Polygon" -> ringMean(coords.get(0).getAsJsonArray());
        default -> throw new IllegalArgumentException("Unsupported target geometry " + type + " (Point or Polygon only)");
      };
      final JsonObject window = f.has("properties") && f.getAsJsonObject("properties").has("window")
          ? f.getAsJsonObject("properties").getAsJsonObject("window") : null;
      out.add(new Target(featureId(f, i), lonLat[1], normalizeLon(lonLat[0]),
          window == null ? null : Instant.parse(window.get("start").getAsString()),
          window == null ? null : Instant.parse(window.get("end").getAsString())));
    }
    return out;
  }

  private static String featureId(JsonObject f, int index) {
    final JsonElement id = f.has("id") ? f.get("id")
        : f.has("properties") && f.getAsJsonObject("properties").has("id") ? f.getAsJsonObject("properties").get("id")
        : null;
    return id == null || id.isJsonNull() ? Integer.toString(index) : id.getAsString();
  }

  // ponytail: vertex mean, not an area centroid; fine for small polygons that don't straddle ±180°.
  private static double[] ringMean(JsonArray ring) {
    final int n = ring.size() > 1 ? ring.size() - 1 : ring.size(); // GeoJSON rings repeat the first vertex
    double lon = 0, lat = 0;
    for (int i = 0; i < n; i++) {
      lon += ring.get(i).getAsJsonArray().get(0).getAsDouble();
      lat += ring.get(i).getAsJsonArray().get(1).getAsDouble();
    }
    return new double[]{lon / n, lat / n};
  }

  /** Wrap any longitude (e.g. 0..360) into [-180, 180). */
  static double normalizeLon(double lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
  }
}
