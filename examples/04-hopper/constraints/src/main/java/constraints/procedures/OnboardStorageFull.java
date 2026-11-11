package constraints.procedures;

import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.procedural.constraints.Constraint;
import gov.nasa.ammos.plandev.procedural.constraints.Violations;
import gov.nasa.ammos.plandev.procedural.constraints.annotations.ConstraintProcedure;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Real;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;

/** Violated while onboard storage is at or above {@code fractionFull} of its capacity (data beyond it is lost). */
@ConstraintProcedure
public record OnboardStorageFull(double fractionFull) implements Constraint {
  @Override
  public Violations run(Plan plan, SimulationResults simResults) {
    final double capacity = simResults.resource("onboard.maxVolume", Real.deserializer()).sample(Duration.ZERO);
    return Violations.inside(
        simResults.resource("onboard.volume", Real.deserializer()).greaterThanOrEqualTo(fractionFull * capacity).highlightTrue());
  }
}
