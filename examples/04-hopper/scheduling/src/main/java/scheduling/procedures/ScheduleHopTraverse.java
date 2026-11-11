package scheduling.procedures;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.procedural.scheduling.ActivityAutoDelete;
import gov.nasa.ammos.plandev.procedural.scheduling.Goal;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.SchedulingProcedure;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.WithDefaults;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.DeletedAnchorStrategy;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.EditablePlan;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.NewDirective;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Real;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.AnyDirective;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.DirectiveStart;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;
import hopper.HopModel;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Plans a hop-and-image traverse over GeoJSON sites: for each site, a {@code PerformHop} from the
 * hopper's current location to the site, a rest, then a {@code TakePicture} there.
 *
 * <p>{@code sites} is a GeoJSON FeatureCollection of Point features on the Moon (planetocentric
 * latitude / east-positive longitude, degrees). Each feature's {@code id} is written into the
 * activities' {@code toSiteId} / {@code siteId} arguments. The start location is the simulated
 * {@code hopper.latitude/longitude} at {@code startAfter}. Hop durations come from
 * {@link HopModel} (illustrative), the same function the simulation uses.
 *
 * <p>{@code order}: {@code AS_DRAWN} visits sites in the given order; {@code NEAREST_NEXT} always
 * hops to the closest unvisited site. Sites that would finish after the plan end are dropped.
 */
@SchedulingProcedure
public record ScheduleHopTraverse(
    String sites,
    String order,
    Duration startAfter,
    Duration restAfterHop,
    Duration pictureDuration) implements Goal {

  @WithDefaults
  public static final class Defaults {
    public static String sites = "{\"type\":\"FeatureCollection\",\"features\":[]}";
    public static String order = "AS_DRAWN";
    public static Duration startAfter = Duration.of(1, Duration.HOUR);
    public static Duration restAfterHop = Duration.of(30, Duration.MINUTES);
    public static Duration pictureDuration = Duration.of(2, Duration.MINUTES);
  }

  public record Site(String id, double lat, double lon) {}

  /** Illustrative data rates: navigation telemetry while hopping, science imaging at a site. */
  public static final double HOP_DATA_RATE_BPS = 2e5;
  public static final double IMAGE_DATA_RATE_BPS = 2e7;

  @NotNull
  @Override
  public ActivityAutoDelete shouldDeletePastCreations(@NotNull Plan plan, @Nullable SimulationResults simResults) {
    return new ActivityAutoDelete.AtBeginning(DeletedAnchorStrategy.Cascade, false);
  }

  @Override
  public void run(EditablePlan plan) {
    final Duration end = plan.totalBounds().end;
    Duration t = plan.totalBounds().start.plus(startAfter);

    final SimulationResults sim = plan.simulate();
    double lat = sim.resource("hopper.latitude", Real.deserializer()).sample(t);
    double lon = sim.resource("hopper.longitude", Real.deserializer()).sample(t);

    final List<Site> route = order(parseSites(sites), order, lat, lon);
    final long pictureSeconds = pictureDuration.in(Duration.SECONDS);
    for (final Site s : route) {
      final double km = HopModel.distanceKm(lat, lon, s.lat(), s.lon());
      final long hopSeconds = HopModel.hopSeconds(km);
      final Duration hopEnd = t.plus(Duration.of(hopSeconds, Duration.SECONDS));
      final Duration pictureStart = hopEnd.plus(restAfterHop);
      if (pictureStart.plus(pictureDuration).longerThan(end)) {
        System.out.printf("[ScheduleHopTraverse] site %s dropped: traverse would run past the plan end%n", s.id());
        break;
      }
      plan.create(new NewDirective(
          new AnyDirective(Map.of(
              "toSiteId", SerializedValue.of(s.id()),
              "toLatitude", SerializedValue.of(s.lat()),
              "toLongitude", SerializedValue.of(s.lon()),
              "durationSeconds", SerializedValue.of(hopSeconds), // informational: the model derives it
              "dataRateBps", SerializedValue.of(HOP_DATA_RATE_BPS),
              "bin", SerializedValue.of(0))),
          "Hop to " + s.id(),
          "PerformHop",
          new DirectiveStart.Absolute(t)));
      plan.create(new NewDirective(
          new AnyDirective(Map.of(
              "siteId", SerializedValue.of(s.id()),
              "durationSeconds", SerializedValue.of(pictureSeconds),
              "dataRateBps", SerializedValue.of(IMAGE_DATA_RATE_BPS),
              "bin", SerializedValue.of(0))),
          "Image " + s.id(),
          "TakePicture",
          new DirectiveStart.Absolute(pictureStart)));
      System.out.printf("[ScheduleHopTraverse] hop to %s: %.2f km, %d s%n", s.id(), km, hopSeconds);
      t = pictureStart.plus(pictureDuration);
      lat = s.lat();
      lon = s.lon();
    }
    plan.commit();
  }

  static List<Site> order(List<Site> sites, String order, double lat, double lon) {
    switch (order) {
      case "AS_DRAWN":
        return sites;
      case "NEAREST_NEXT": {
        final List<Site> left = new ArrayList<>(sites);
        final List<Site> out = new ArrayList<>();
        while (!left.isEmpty()) {
          Site best = left.get(0);
          for (final Site s : left) {
            if (HopModel.distanceKm(lat, lon, s.lat(), s.lon()) < HopModel.distanceKm(lat, lon, best.lat(), best.lon())) best = s;
          }
          out.add(best);
          left.remove(best);
          lat = best.lat();
          lon = best.lon();
        }
        return out;
      }
      default:
        throw new IllegalArgumentException("order must be AS_DRAWN or NEAREST_NEXT, got " + order);
    }
  }

  static List<Site> parseSites(String geojson) {
    final JsonArray features = JsonParser.parseString(geojson).getAsJsonObject().getAsJsonArray("features");
    final List<Site> out = new ArrayList<>();
    for (int i = 0; i < features.size(); i++) {
      final JsonObject f = features.get(i).getAsJsonObject();
      final JsonObject geom = f.getAsJsonObject("geometry");
      if (!"Point".equals(geom.get("type").getAsString())) {
        throw new IllegalArgumentException("Unsupported site geometry " + geom.get("type") + " (Point only)");
      }
      final JsonArray c = geom.getAsJsonArray("coordinates");
      final JsonElement id = f.get("id");
      double lon = c.get(0).getAsDouble();
      lon = ((lon + 180) % 360 + 360) % 360 - 180;
      out.add(new Site(id == null || id.isJsonNull() ? Integer.toString(i) : id.getAsString(), c.get(1).getAsDouble(), lon));
    }
    return out;
  }
}
