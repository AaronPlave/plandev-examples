package hopper;

import gov.nasa.ammos.plandev.power.PowerModelSimConfig;

import static gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Template;

/**
 * @param landingLatitude planetocentric latitude (deg) of the hopper at plan start
 * @param landingLongitude east-positive longitude (deg) of the hopper at plan start
 */
public record Configuration(
    PowerModelSimConfig powerConfig,
    double initialMaxVolume,
    double initialDataRate,
    double landingLatitude,
    double landingLongitude
) {
  public static @Template Configuration defaultConfiguration() {
    return new Configuration(
        PowerModelSimConfig.defaultConfiguration(),
        1e10,  // 10 Gb
        1e4,   // 10 Kbps
        7.40,  // Reiner Gamma, Oceanus Procellarum
        -59.10
    );
  }
}
