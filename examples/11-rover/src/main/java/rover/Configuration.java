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
 * @param driveMinSunElevationDeg flight rule: the rover drives only while the Sun is at least this high
 * @param driveDaylightMarginMin planning rule: a drive starts only if the Sun stays above that limit this much longer
 */
public record Configuration(
    PowerModelSimConfig powerConfig,
    double initialMaxVolume,
    double initialDataRate,
    double startLatitude,
    double startLongitude,
    double driveMinSunElevationDeg,
    double driveDaylightMarginMin
) {
  public static @Template Configuration defaultConfiguration() {
    return new Configuration(
        // Illustrative sizing: a horizontal 6.5 m^2 array makes about 730 W with the Sun overhead near
        // aphelion, and about 240 W averaged over a sol at Jezero in early 2027 (see Mission); the battery holds
        // 60 Ah * 28 V = 1680 Wh, enough for a night of the 60 W idle load.
        new PowerModelSimConfig(
            new BatterySimConfig(60.0, 28.0, 100.0),
            new SolarArraySimConfig(ArrayDeploymentStates.DEPLOYED, 6.5, 0.9, 0.28, 0.9, 1.0)),
        8e9,   // 8 Gbit
        2e6,   // 2 Mbit/s
        18.4446,  // Octavia E. Butler Landing, Jezero crater
        77.4509,
        // Example operating limits for this demo, not a mission's.
        10.0,
        45.0
    );
  }
}
