package rover;

import gov.nasa.ammos.plandev.power.ArrayDeploymentStates;
import gov.nasa.ammos.plandev.power.BatterySimConfig;
import gov.nasa.ammos.plandev.power.PowerModelSimConfig;
import gov.nasa.ammos.plandev.power.SolarArraySimConfig;

import static gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Template;

/**
 * @param initialMaxVolume onboard storage capacity (bits)
 * @param initialDataRate playback rate during a Downlink pass (bit/s)
 * @param startLatitude planetocentric latitude (deg) of the rover at plan start
 * @param startLongitude east-positive longitude (deg) of the rover at plan start
 */
public record Configuration(
    PowerModelSimConfig powerConfig,
    double initialMaxVolume,
    double initialDataRate,
    double startLatitude,
    double startLongitude
) {
  public static @Template Configuration defaultConfiguration() {
    return new Configuration(
        // Illustrative sizing: a 1.9 m^2 array makes about 250 W at Mars (see Mission), and the
        // battery holds 60 Ah * 28 V = 1680 Wh.
        new PowerModelSimConfig(
            new BatterySimConfig(60.0, 28.0, 100.0),
            new SolarArraySimConfig(ArrayDeploymentStates.DEPLOYED, 1.9, 0.9, 0.28, 0.9, 1.0)),
        8e9,   // 8 Gbit
        2e6,   // 2 Mbit/s
        18.4446,  // Octavia E. Butler Landing, Jezero crater
        77.4509
    );
  }
}
