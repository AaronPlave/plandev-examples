package rover.activities;

import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.data.activities.DeleteData;
import gov.nasa.ammos.plandev.data.activities.PlaybackData;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import rover.Mission;

import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.delay;
import static rover.generated.ActivityActions.spawn;

/** A relay pass: the radio draws power while stored data is played back, then deleted. */
@ActivityType("Downlink")
@Subsystem("telecom")
public class Downlink {
  public static final double TELECOM_W = 40.0;

  @Parameter
  public Duration duration = Duration.of(15, Duration.MINUTES);

  @EffectModel
  public void run(Mission model) {
    DiscreteEffects.set(model.telecomLoad, TELECOM_W);
    spawn(model, new PlaybackData(duration));
    delay(duration);
    for (int i = 0; i < model.data.onboardBuckets.size(); ++i) {
      spawn(model, new DeleteData(Double.MAX_VALUE, true, i));
    }
    DiscreteEffects.set(model.telecomLoad, 0.0);
  }
}
