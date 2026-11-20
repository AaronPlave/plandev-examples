package moonfall;

import gov.nasa.ammos.plandev.merlin.framework.annotations.AutoValueMapper;

/**
 * A drone's simulated state as one resource value, for the 3D view: position (km) and velocity (km/s) in
 * MOON_ME_DE421, Moon-centred; attitude as a scalar-first quaternion from MOON_ME_DE421 to the drone body
 * (v_body = q v q*); the flight phase; and the trajectory it belongs to ("" when landed between hops).
 *
 * <p>While flying, the value changes at every published trajectory sample ({@link HopSolver#SAMPLE_INTERVAL_S}
 * and every phase boundary), and position and velocity together reproduce the integrated path by cubic Hermite
 * interpolation to a few centimetres ({@code HopSolverTest}). While landed it is constant with zero velocity.
 */
@AutoValueMapper.Record
public record DroneState(
    double xKm, double yKm, double zKm,
    double vxKmps, double vyKmps, double vzKmps,
    double qw, double qx, double qy, double qz,
    String phase,
    String trajectoryId) {

  public double[] positionM() {
    return new double[] {xKm * 1000, yKm * 1000, zKm * 1000};
  }

  public double[] attitude() {
    return new double[] {qw, qx, qy, qz};
  }

  public static DroneState of(double[] rM, double[] vMps, double[] q, HopSolver.Phase phase, String trajectoryId) {
    return new DroneState(rM[0] / 1000, rM[1] / 1000, rM[2] / 1000, vMps[0] / 1000, vMps[1] / 1000, vMps[2] / 1000,
        q[0], q[1], q[2], q[3], phase.name(), trajectoryId);
  }
}
