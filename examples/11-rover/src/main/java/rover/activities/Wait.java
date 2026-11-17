package rover.activities;

import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import rover.Mission;

import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.delay;

/**
 * The rover stays where it is, idle: for the next drive window (overnight) or to recharge. It changes no
 * state; it makes the planned pause, and its reason, visible on the timeline.
 */
@ActivityType("Wait")
@Subsystem("mobility")
public class Wait {
  /** Why the rover waits, e.g. "overnight: Sun below 10°" or "recharge to 95 %". */
  @Parameter
  public String reason = "";

  @Parameter
  public Duration duration = Duration.of(1, Duration.HOUR);

  @EffectModel
  public void run(Mission model) {
    delay(duration);
  }
}
