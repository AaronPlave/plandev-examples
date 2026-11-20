package scheduling.procedures;

import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.procedural.scheduling.ActivityAutoDelete;
import gov.nasa.ammos.plandev.procedural.scheduling.Goal;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.DeletedAnchorStrategy;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.SchedulingProcedure;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.WithDefaults;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.EditablePlan;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.NewDirective;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.AnyDirective;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.DirectiveStart;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;
import gov.nasa.ammos.plandev.types.ActivityDirectiveId;
import moonfall.HopSolver;
import moonfall.HopSolver.Hop;
import scheduling.Sim;

import java.util.Map;

/**
 * Evaluates one hop and, if it can be flown, adds it to the plan.
 *
 * <p>The goal reads where {@code drone} is and how much propellant it has at {@code startAfter} from a simulation
 * of the plan, computes the hop with the mission model's own {@link HopSolver} and terrain, and only then decides:
 * a feasible hop becomes a {@code PerformHop} at that time; an infeasible one fails the run with the solver's
 * reason and adds nothing. It then re-simulates and checks that the simulation flew the trajectory the goal
 * evaluated (same {@code trajectoryId}, duration and propellant).
 */
@SchedulingProcedure
public record PlanHop(String drone, double latitude, double longitude, String profile, Duration startAfter, int surveyFrames, String surveyName, String surveyRegion) implements Goal {
  @WithDefaults
  public static final class Defaults {
    public static String drone = "Polaris-A";
    public static double latitude = -89.62;
    public static double longitude = -30.0;
    public static String profile = "MIN_PROPELLANT";
    public static Duration startAfter = Duration.of(1, Duration.HOUR);
    public static int surveyFrames = 0;
    public static String surveyName = "";
    public static String surveyRegion = "";
  }

  /** Re-running the goal replaces the hop it created before, rather than adding a second one. */
  @NotNull
  @Override
  public ActivityAutoDelete shouldDeletePastCreations(@NotNull Plan plan, @Nullable SimulationResults simResults) {
    return new ActivityAutoDelete.AtBeginning(DeletedAnchorStrategy.Cascade, false);
  }

  @Override
  public void run(EditablePlan plan) {
    final Duration at = plan.totalBounds().start.plus(startAfter);
    final SimulationResults sim = plan.simulate();
    final Hop hop = Sim.evaluate(sim, drone, at, latitude, longitude, HopSolver.Profile.valueOf(profile));
    System.out.printf("[PlanHop] %s → %.5f, %.5f at +%s: %s — %s; candidates: %s%n", drone, latitude, longitude, at, hop.status(), hop.reason(), hop.candidates());
    if (!hop.feasible()) {
      throw new IllegalStateException("PlanHop rejected " + drone + " → " + latitude + ", " + longitude + ": " + hop.status() + ": " + hop.reason());
    }
    final ActivityDirectiveId id = plan.create(new NewDirective(
        new AnyDirective(Map.of(
            "drone", SerializedValue.of(drone),
            "destinationLatitude", SerializedValue.of(latitude),
            "destinationLongitude", SerializedValue.of(longitude),
            "profile", SerializedValue.of(profile))),
        String.format("Hop %s to %.4f, %.4f", drone, latitude, longitude),
        "PerformHop",
        new DirectiveStart.Absolute(at)));
    if (surveyFrames > 0) {
      // Survey images from the hop's own coast: starting once the nadir attitude has settled, 2 s apart, as many as
      // fit before braking (at most surveyFrames). Anchored to the hop, so they move with it.
      final HopSolver.PhaseSpan coast = HopSolver.span(hop, HopSolver.Phase.COAST);
      final double first = coast.startS() + moonfall.Camera.SETTLE_S;
      final int frames = (int) Math.min(surveyFrames, Math.floor((coast.endS() - first) / 2.0) + 1);
      plan.create(new NewDirective(
          new AnyDirective(Map.of(
              "drone", SerializedValue.of(drone),
              "frames", SerializedValue.of(frames),
              "intervalS", SerializedValue.of(2.0),
              "targetName", SerializedValue.of(surveyName),
              "targetRegion", SerializedValue.of(surveyRegion))),
          "Survey " + (surveyName.isBlank() ? "images" : surveyName),
          "AcquireSurveyImages",
          new DirectiveStart.Anchor(id, Duration.of(Math.round(first * 1e6), Duration.MICROSECONDS), DirectiveStart.Anchor.AnchorPoint.Start)));
    }
    Sim.checkFlown(plan.simulate(), id, hop);
    plan.commit();
  }
}
