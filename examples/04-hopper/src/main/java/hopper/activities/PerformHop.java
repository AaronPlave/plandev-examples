package hopper.activities;

import hopper.HopModel;
import hopper.Mission;
import hopper.SimplePEL.HopState;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;

import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentValue;

/**
 * Perform a hop which activates hop mode and draws power for the duration of the hop.
 *
 * <p>With a destination ({@code toSiteId} non-empty), the hop flies from the hopper's current
 * location to ({@code toLatitude}, {@code toLongitude}): its duration comes from {@link HopModel}
 * (illustrative) and {@code durationSeconds} is ignored. The location resources change when it
 * lands. Without a destination it is the original fixed-duration hop in place.
 */
@ActivityType("PerformHop")
@Subsystem("mobility")
public class PerformHop {

  @Parameter
  public long durationSeconds = 300;

  @Parameter
  public double dataRateBps = 5e6; // 5 Mbps

  @Parameter
  public int bin = 0;

  /** Destination site id; empty means "hop in place" for durationSeconds. */
  @Parameter
  public String toSiteId = "";

  @Parameter
  public double toLatitude = 0.0;

  @Parameter
  public double toLongitude = 0.0;

  @EffectModel
  public void run(Mission model) {
    final boolean moving = !toSiteId.isEmpty();
    final double km = moving
        ? HopModel.distanceKm(currentValue(model.latitude), currentValue(model.longitude), toLatitude, toLongitude)
        : 0.0;
    final long seconds = moving ? HopModel.hopSeconds(km) : durationSeconds;

    // Turn on hop mode (power impact)
    DiscreteEffects.set(model.pel.hopState, HopState.ON);

    // Generate data into onboard storage. receive(rate, dur) is a blocking
    // call: it turns the receive rate on, waits for the full duration while
    // data accumulates, then turns the rate back off. So this both produces the
    // data and provides the hop delay -- no extra delay needed.
    var binToChange = model.data.getOnboardBin(bin);
    binToChange.receive(dataRateBps, Duration.of(seconds, Duration.SECONDS));

    if (moving) {
      DiscreteEffects.set(model.latitude, toLatitude);
      DiscreteEffects.set(model.longitude, toLongitude);
      DiscreteEffects.set(model.odometerKm, currentValue(model.odometerKm) + km);
    }

    // Turn off hop mode
    DiscreteEffects.set(model.pel.hopState, HopState.OFF);
  }
}
