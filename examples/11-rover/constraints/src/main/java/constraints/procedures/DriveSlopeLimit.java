package constraints.procedures;

import gov.nasa.ammos.plandev.procedural.constraints.Constraint;
import gov.nasa.ammos.plandev.procedural.constraints.Violations;
import gov.nasa.ammos.plandev.procedural.constraints.annotations.ConstraintProcedure;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Real;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;

/** Flight rule: the rover should not drive on terrain steeper than {@code maxSlopeDeg}. */
@ConstraintProcedure
public record DriveSlopeLimit(double maxSlopeDeg) implements Constraint {
  @Override
  public Violations run(Plan plan, SimulationResults simResults) {
    return Violations.inside(simResults.resource("rover.slopeDeg", Real.deserializer()).greaterThan(maxSlopeDeg).highlightTrue());
  }
}
