package scheduling.procedures;

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
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import rover.Terrain;
import scheduling.TraversePlanner;
import scheduling.TraversePlanner.Itinerary;
import scheduling.TraversePlanner.Daylight;
import scheduling.TraversePlanner.Objective;
import scheduling.TraversePlanner.Power;
import scheduling.TraversePlanner.Site;
import scheduling.TraversePlanner.Step;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Plans a rover traverse of science sites over the mission's terrain grid ({@link Terrain}) and
 * creates its activities: {@code Drive}s, each carrying the waypoints of its part of the route, and
 * an {@code Observe} at each site reached. See {@link TraversePlanner} for the algorithm.
 *
 * <ul>
 *   <li>{@code sites}: GeoJSON FeatureCollection of Point features (planetocentric latitude,
 *       east-positive longitude) with {@code id}, {@code properties.name} and
 *       {@code properties.priority} (1 to 3). Blank means the mission's own site catalog.
 *   <li>{@code avoid}: GeoJSON FeatureCollection of Polygon features the route must stay out of. Blank for none.
 *   <li>{@code objective}: what each route minimizes: {@code MIN_DISTANCE}, {@code MIN_TIME} or {@code MIN_ENERGY}.
 *   <li>{@code maxSlopeDeg}: cells steeper than this are impassable.
 *   <li>{@code minSOC}: the rover stops to recharge rather than let its estimated state of charge fall below this.
 *   <li>{@code driveWindow}: {@code DAYLIGHT} drives only inside the mission's drive window (the Sun at least
 *       its minimum elevation, with its daylight margin left at each start), waiting overnight where
 *       needed; {@code ANY_TIME} drives whenever the battery allows.
 * </ul>
 *
 * <p>The start location, state of charge, battery capacity, array size and the mission's drive-window
 * limits are read from a simulation of the plan at {@code startAfter}.
 */
@SchedulingProcedure
public record ScheduleTraverse(
    String sites,
    String avoid,
    String objective,
    double maxSlopeDeg,
    double minSOC,
    Duration startAfter,
    Duration observeDuration,
    String driveWindow) implements Goal {

  @WithDefaults
  public static final class Defaults {
    public static String sites = "";
    public static String avoid = "";
    public static String objective = "MIN_ENERGY";
    public static double maxSlopeDeg = 20.0;
    public static double minSOC = 30.0;
    public static Duration startAfter = Duration.of(1, Duration.HOUR);
    public static Duration observeDuration = Duration.of(30, Duration.MINUTES);
    public static String driveWindow = "DAYLIGHT";
  }

  /** Illustrative science data rate while observing. */
  public static final double OBSERVE_DATA_RATE_BPS = 5e5;

  @NotNull
  @Override
  public ActivityAutoDelete shouldDeletePastCreations(@NotNull Plan plan, @Nullable SimulationResults simResults) {
    return new ActivityAutoDelete.AtBeginning(DeletedAnchorStrategy.Cascade, false);
  }

  @Override
  public void run(EditablePlan plan) {
    final Duration start = plan.totalBounds().start.plus(startAfter);
    final SimulationResults sim = plan.simulate();
    final Terrain terrain = Terrain.get();
    final Itinerary itinerary = TraversePlanner.plan(
        terrain,
        sites.isBlank() ? missionSites() : TraversePlanner.parseSites(sites),
        TraversePlanner.parsePolygons(avoid),
        Objective.valueOf(objective),
        maxSlopeDeg,
        new Power(sample(sim, "mainbattery.batterySOC", start), sample(sim, "rover.batteryCapacityWh", start), sample(sim, "rover.arrayZenithW1AU", start)),
        new Daylight(
            plan.toAbsolute(Duration.ZERO).toEpochMilli(),
            switch (driveWindow) {
              case "DAYLIGHT" -> true;
              case "ANY_TIME" -> false;
              default -> throw new IllegalArgumentException("driveWindow must be DAYLIGHT or ANY_TIME, got " + driveWindow);
            },
            sample(sim, "rover.driveMinSunElevationDeg", start),
            Math.round(sample(sim, "rover.driveDaylightMarginMin", start) * 60)),
        minSOC,
        sample(sim, "rover.latitude", start),
        sample(sim, "rover.longitude", start),
        start.in(Duration.SECONDS),
        plan.totalBounds().end.in(Duration.SECONDS),
        observeDuration.in(Duration.SECONDS));

    for (final Step s : itinerary.steps()) {
      final Site site = s.site();
      if (s.type().equals("Wait")) {
        plan.create(new NewDirective(
            new AnyDirective(Map.of("reason", SerializedValue.of(s.reason()), "duration", SerializedValue.of(s.durationSec() * 1_000_000L))),
            "Wait: " + s.reason().replaceAll(",.*", ""),
            "Wait",
            new DirectiveStart.Absolute(Duration.of(s.startSec(), Duration.SECONDS))));
        continue;
      }
      final boolean drive = s.type().equals("Drive");
      final Map<String, SerializedValue> args = drive
          ? Map.of(
              "toSiteId", SerializedValue.of(site.id()),
              "waypoints", SerializedValue.of(s.waypoints().stream()
                  .map(p -> SerializedValue.of(List.of(SerializedValue.of(p[0]), SerializedValue.of(p[1])))).toList()),
              "terrain", SerializedValue.of(terrain.id),
              "objective", SerializedValue.of(objective))
          : Map.of(
              "siteId", SerializedValue.of(site.id()),
              "siteName", SerializedValue.of(site.name()),
              "siteLatitude", SerializedValue.of(site.lat()),
              "siteLongitude", SerializedValue.of(site.lon()),
              "priority", SerializedValue.of(site.priority()),
              "durationSeconds", SerializedValue.of(s.durationSec()),
              "dataRateBps", SerializedValue.of(OBSERVE_DATA_RATE_BPS));
      plan.create(new NewDirective(
          new AnyDirective(args),
          drive ? "Drive to " + site.id() + (s.part() > 1 ? " (part " + s.part() + ")" : "") : "Observe " + site.id(),
          s.type(),
          new DirectiveStart.Absolute(Duration.of(s.startSec(), Duration.SECONDS))));
    }
    for (final String note : itinerary.notes()) System.out.println("[ScheduleTraverse] " + note);
    System.out.printf("[ScheduleTraverse] %s, %s, on %s: %d sites, %d activities%n", objective, driveWindow, terrain.id, itinerary.visited().size(), itinerary.steps().size());
    plan.commit();
  }

  private static double sample(SimulationResults sim, String resource, Duration at) {
    return sim.resource(resource, Real.deserializer()).sample(at);
  }

  /** The site catalog shipped with the mission model. */
  public static List<Site> missionSites() {
    try (InputStream in = Terrain.class.getResourceAsStream("/rover/sites.geojson")) {
      return TraversePlanner.parseSites(new String(in.readAllBytes(), StandardCharsets.UTF_8));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
