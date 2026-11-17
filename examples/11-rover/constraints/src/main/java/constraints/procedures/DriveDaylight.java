package constraints.procedures;

import gov.nasa.ammos.plandev.procedural.constraints.Constraint;
import gov.nasa.ammos.plandev.procedural.constraints.Violations;
import gov.nasa.ammos.plandev.procedural.constraints.annotations.ConstraintProcedure;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Booleans;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Strings;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;

/**
 * Flight rule: the rover drives only inside its drive window, while the Sun is at least the mission's
 * minimum elevation above the local horizontal ({@code rover.driveWindowOpen}, from the model's
 * geometric solar elevation at the rover). The limit is the model's configuration, not an argument here.
 */
@ConstraintProcedure
public record DriveDaylight() implements Constraint {
  @Override
  public Violations run(Plan plan, SimulationResults simResults) {
    final Booleans driving = simResults.resource("rover.driveStatus", Strings.deserializer()).equalTo("DRIVING");
    final Booleans open = simResults.resource("rover.driveWindowOpen", Booleans.deserializer());
    return Violations.inside(driving.and(open.not()).highlightTrue());
  }
}
