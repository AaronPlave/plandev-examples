package rover.activities;

import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import rover.DriveModel;
import rover.Mission;

/**
 * A science observation where the rover stands: the instrument draws power and writes data to
 * onboard storage.
 *
 * <p>The site fields say which site the observation was planned for and where that site is. They do
 * not move the rover: if a drive stopped short, the observation is made wherever the rover is.
 */
@ActivityType("Observe")
@Subsystem("payload")
public class Observe {

  @Parameter
  public String siteId = "";

  @Parameter
  public String siteName = "";

  /** Planned site location, degrees (planetocentric latitude, east-positive longitude). */
  @Parameter
  public double siteLatitude = 0.0;

  @Parameter
  public double siteLongitude = 0.0;

  /** Science priority of the site, 1 (low) to 3 (high). */
  @Parameter
  public int priority = 1;

  @Parameter
  public long durationSeconds = 1800;

  @Parameter
  public double dataRateBps = 5e5;

  @Parameter
  public int bin = 0;

  @EffectModel
  public void run(Mission model) {
    DiscreteEffects.set(model.instrumentLoad, DriveModel.OBSERVE_W);
    model.data.getOnboardBin(bin).receive(dataRateBps, Duration.of(durationSeconds, Duration.SECONDS));
    DiscreteEffects.set(model.instrumentLoad, 0.0);
  }
}
