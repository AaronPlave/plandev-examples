package moonfall;

import gov.nasa.ammos.plandev.merlin.framework.annotations.AutoValueMapper;

/**
 * The fictional MoonFall-like drone: a point mass with one throttleable main engine. <b>Every number here is an
 * assumption for this demo</b>, not a property of JPL's MoonFall vehicles.
 *
 * @param dryMassKg mass without propellant
 * @param propellantCapacityKg tank capacity (each drone starts full)
 * @param maxThrustN main-engine thrust at full throttle
 * @param minThrottle lowest throttle the engine can hold while lit (fraction of max)
 * @param ispS specific impulse (s); mass flow = thrust / (ispS * 9.80665)
 * @param liftHeightM vertical rise above the launch site before pitching over
 * @param gateHeightM height above the landing site at which braking ends and the vertical descent begins
 * @param gateSpeedMps descent speed at the gate
 * @param descentSpeedMps descent speed the terminal controller holds to touchdown
 * @param maxTouchdownVerticalMps landing tolerance, vertical
 * @param maxTouchdownHorizontalMps landing tolerance, horizontal
 * @param minClearanceM least height above terrain between lift-off and the gate, after adding the terrain's
 *     stated tile uncertainty
 * @param maxLandingSlopeDeg steepest landing-site slope
 * @param landingSlopeBaselineM half-width over which the landing slope is measured
 * @param minLandingTerrainLevel coarsest terrain tile level a landing site may be assessed on (level 11 is
 *     about 27 m between posts, level 12 about 13 m)
 * @param reservePropellantKg propellant that must remain after landing
 * @param minRangeM shortest hop the guidance supports
 * @param maxRangeM longest hop the guidance supports
 */
@AutoValueMapper.Record
public record Vehicle(
    double dryMassKg,
    double propellantCapacityKg,
    double maxThrustN,
    double minThrottle,
    double ispS,
    double liftHeightM,
    double gateHeightM,
    double gateSpeedMps,
    double descentSpeedMps,
    double maxTouchdownVerticalMps,
    double maxTouchdownHorizontalMps,
    double minClearanceM,
    double maxLandingSlopeDeg,
    double landingSlopeBaselineM,
    int minLandingTerrainLevel,
    double reservePropellantKg,
    double minRangeM,
    double maxRangeM) {

  public static final double G0 = 9.80665;

  public static Vehicle defaults() {
    return new Vehicle(60, 40, 440, 0.25, 235, 15, 30, 2, 1, 2, 0.5, 5, 12, 15, 11, 1, 50, 20_000);
  }

  public double massFlowKgps(double thrustN) {
    return thrustN / (ispS * G0);
  }
}
