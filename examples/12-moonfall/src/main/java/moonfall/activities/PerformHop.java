package moonfall.activities;

import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.AutoValueMapper;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import moonfall.Drone;
import moonfall.DroneState;
import moonfall.HopSolver;
import moonfall.HopSolver.Hop;
import moonfall.HopSolver.Phase;
import moonfall.HopSolver.Profile;
import moonfall.Mission;
import moonfall.Vec;

import java.util.List;
import java.util.Optional;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;

import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentTime;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.delay;

/**
 * Hop a drone to a destination.
 *
 * <p>When the activity starts, the trajectory is computed ({@link HopSolver}) from where the simulation has the
 * drone and the propellant it has then, to {@code destinationLatitude}/{@code destinationLongitude}
 * (planetocentric degrees, MOON_ME_DE421). A feasible hop is flown: the drone's resources follow the trajectory
 * and the activity lasts as long as the flight. An infeasible hop does not fly: the drone stays where it is, the
 * activity takes no time, and its result says why ({@code status}, {@code reason}).
 *
 * <p>The result (computed attributes) identifies the trajectory flown: {@code trajectoryId} is a hash of every
 * input (solver version, terrain, vehicle, start, propellant, destination, profile), so the scheduling goal and the
 * simulation can show they computed the same flight.
 */
@ActivityType("PerformHop")
@Subsystem("flight")
public class PerformHop {
  @Parameter
  public String drone = "Polaris-A";

  @Parameter
  public double destinationLatitude = -89.62;

  @Parameter
  public double destinationLongitude = -30.0;

  /** Pitch candidates tried: MIN_PROPELLANT (20–75°), LOW_ARC (15–25°), HIGH_ARC (60–80°). */
  @Parameter
  public Profile profile = Profile.MIN_PROPELLANT;

  @AutoValueMapper.Record
  public record Result(
      String status,
      String reason,
      String trajectoryId,
      String terrain,
      String solver,
      double startLatitude,
      double startLongitude,
      double propellantBeforeKg,
      double rangeM,
      double pitchDeg,
      double durationS,
      double propellantKg,
      double deltaVMps,
      double maxHeightAboveTerrainM,
      double minClearanceM,
      double landingSlopeDeg,
      double touchdownVerticalMps,
      double landingLatitude,
      double landingLongitude,
      List<String> phases,
      String candidates) {}

  /** Numbers that do not apply (the hop was not flown, or failed before they were computed) are reported as 0. */
  private static double n(double x) {
    return Double.isFinite(x) ? x : 0;
  }

  @EffectModel
  public Result run(Mission model) {
    final Drone d = model.drone(drone);
    final DroneState now = d.current();
    final double[] start = now.positionM();
    final double propellant = gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentValue(d.propellantKg);
    if (!Phase.LANDED.name().equals(now.phase())) {
      return new Result("DRONE_BUSY", drone + " is " + now.phase() + ", not landed", "", model.terrain.id, HopSolver.VERSION,
          Vec.latDeg(start), Vec.lonDeg(start), propellant, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, List.of(), "");
    }
    final Hop hop = model.solver.solve(new HopSolver.Request(start, propellant, destinationLatitude, destinationLongitude, profile, model.vehicle));
    if (hop.feasible()) {
      final Duration t0 = currentTime();
      DiscreteEffects.set(d.flight, Optional.of(new Drone.Flying(hop, t0)));
      for (final HopSolver.State s : hop.samples()) {
        final Duration at = t0.plus(Duration.of(Math.round(s.t() * 1e6), Duration.MICROSECONDS));
        final Duration wait = at.minus(currentTime());
        if (wait.longerThan(Duration.ZERO)) delay(wait);
        d.set(s, hop.trajectoryId(), model.vehicle.dryMassKg(), model.terrain);
      }
      DiscreteEffects.set(d.flight, Optional.empty());
    }
    return new Result(hop.status().name(), hop.reason(), hop.trajectoryId(), hop.terrainId(), HopSolver.VERSION,
        Vec.latDeg(start), Vec.lonDeg(start), propellant, n(hop.rangeM()), n(hop.pitchDeg()), hop.durationS(), hop.propellantKg(),
        hop.deltaVMps(), n(hop.maxHeightAboveTerrainM()), n(hop.minClearanceM()), n(hop.landingSlopeDeg()), n(hop.touchdownVerticalMps()),
        hop.feasible() ? Vec.latDeg(hop.landing()) : 0, hop.feasible() ? Vec.lonDeg(hop.landing()) : 0,
        hop.phases().stream().map(p -> String.format(java.util.Locale.ROOT, "%s %.2f-%.2f s", p.phase(), p.startS(), p.endS())).toList(),
        hop.candidates());
  }
}
