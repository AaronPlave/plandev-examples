package scheduling;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.DoubleValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.IntegerValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.StringValueMapper;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Constants;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Real;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.AnyInstance;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.Instance;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;
import gov.nasa.ammos.plandev.types.ActivityDirectiveId;
import moonfall.DroneState;
import moonfall.HopSolver;
import moonfall.HopSolver.Hop;
import moonfall.MoonTerrain;
import moonfall.Vehicle;
import moonfall.generated.AutoValueMappers;

import java.util.Map;

/** Reading the mission's simulated state, and evaluating hops from it, the same way the simulation does. */
public final class Sim {
  private Sim() {}

  private static final HopSolver SOLVER = new HopSolver(MoonTerrain.get());

  public static DroneState drone(SimulationResults sim, String drone, Duration at) {
    final DoubleValueMapper d = new DoubleValueMapper();
    final StringValueMapper s = new StringValueMapper();
    final SerializedValue v = sim.resource(drone + ".state", Constants.<SerializedValue>deserializer(seg -> seg.value)).sample(at);
    return AutoValueMappers.moonfall_DroneState(d, d, d, d, d, d, d, d, d, d, s, s).deserializeValue(v).getSuccessOrThrow();
  }

  public static double real(SimulationResults sim, String resource, Duration at) {
    return sim.resource(resource, Real.deserializer()).sample(at);
  }

  /** The vehicle the simulation flies (its configuration, published as {@code mission.vehicle}). */
  public static Vehicle vehicle(SimulationResults sim) {
    final DoubleValueMapper d = new DoubleValueMapper();
    final SerializedValue v = sim.resource("mission.vehicle", Constants.<SerializedValue>deserializer(seg -> seg.value)).sample(Duration.ZERO);
    return AutoValueMappers.moonfall_Vehicle(d, d, d, d, d, d, d, d, d, d, d, d, d, d, new IntegerValueMapper(), d, d, d)
        .deserializeValue(v).getSuccessOrThrow();
  }

  /** The hop the simulation would compute if {@code drone} started it at {@code at}. */
  public static Hop evaluate(SimulationResults sim, String drone, Duration at, double lat, double lon, HopSolver.Profile profile) {
    final DroneState state = drone(sim, drone, at);
    if (!HopSolver.Phase.LANDED.name().equals(state.phase())) {
      throw new IllegalStateException(drone + " is " + state.phase() + " at +" + at + ", not landed");
    }
    return SOLVER.solve(new HopSolver.Request(state.positionM(), real(sim, drone + ".propellantKg", at), lat, lon, profile, vehicle(sim)));
  }

  /** The PerformHop result the simulation recorded for a directive. */
  public static Map<String, SerializedValue> result(SimulationResults sim, ActivityDirectiveId id) {
    for (final Instance<AnyInstance> i : sim.instances("PerformHop")) {
      if (id.equals(i.directiveId)) return i.inner.computedAttributes.asMap().orElseThrow();
    }
    throw new IllegalStateException("no simulated PerformHop for directive " + id);
  }

  /** Fails if the simulation did not fly exactly the hop the goal evaluated. */
  public static void checkFlown(SimulationResults sim, ActivityDirectiveId id, Hop hop) {
    final Map<String, SerializedValue> r = result(sim, id);
    final String flown = r.get("trajectoryId").asString().orElseThrow();
    final double duration = r.get("durationS").asReal().orElseThrow(), prop = r.get("propellantKg").asReal().orElseThrow();
    if (!flown.equals(hop.trajectoryId()) || duration != hop.durationS() || prop != hop.propellantKg()) {
      throw new IllegalStateException(String.format("goal and simulation disagree: evaluated %s (%.2f s, %.3f kg), simulated %s %s (%.2f s, %.3f kg)",
          hop.trajectoryId(), hop.durationS(), hop.propellantKg(), r.get("status").asString().orElse("?"), flown, duration, prop));
    }
  }
}
