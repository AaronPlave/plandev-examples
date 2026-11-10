package hopper.activities;

import hopper.Mission;
import hopper.SimplePEL.CameraState;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;

import java.util.Optional;

/**
 * An activity that takes a picture, affecting both power and data subsystems.
 *
 * Power: turns on the camera for the imaging duration, drawing power.
 * Data: generates science data into the specified onboard storage bin.
 */
@ActivityType("TakePicture")
@Subsystem("payload")
public class TakePicture {

  @Parameter
  public long durationSeconds = 60;

  @Parameter
  public double dataRateBps = 5e6; // 5 Mbps

  @Parameter
  public int bin = 0;

  /** Site being imaged, for traceability only (does not change the effect model). */
  @Parameter
  public String siteId = "";

  @EffectModel
  public void run(Mission model) {
    // Turn on camera (power impact)
    DiscreteEffects.set(model.pel.cameraState, CameraState.ON);

    // Generate science data into onboard storage. receive(rate, dur) is a
    // blocking call: it turns the receive rate on, waits for the full duration
    // while data accumulates, then turns the rate back off. So this both
    // produces the data and provides the imaging delay -- no extra delay needed.
    var binToChange = model.data.getOnboardBin(bin);
    var dur = Duration.of(durationSeconds, Duration.SECONDS);
    binToChange.receive(dataRateBps, dur);

    // Turn off camera
    DiscreteEffects.set(model.pel.cameraState, CameraState.OFF);
  }
}
