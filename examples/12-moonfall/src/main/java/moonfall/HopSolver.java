package moonfall;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

/**
 * Computes a drone hop: powered lift-off and ascent, a ballistic coast, a guided braking burn to a gate above the
 * landing site, and a controlled vertical descent to touchdown. Both the scheduling goal and the simulation call
 * {@link #solve}; the same request gives the same {@link Hop}, bit for bit.
 *
 * <h2>Dynamics</h2>
 * A point mass in the Moon-fixed MOON_ME_DE421 frame (metres, seconds): point-mass lunar gravity
 * ({@link #GM}), the frame's centrifugal and Coriolis terms for a uniform rotation about +Z ({@link #OMEGA}), and
 * the engine's thrust. Mass falls at thrust / (Isp g0). Fourth-order Runge-Kutta, fixed step {@link #DT}, with the
 * thrust held over each step (the controllers are evaluated at step starts). Not modelled: lunar gravity
 * harmonics and mascons, physical libration, third-body gravity, attitude dynamics, engine transients, plume and
 * dust, navigation error.
 *
 * <h2>Guidance (deterministic, not optimal)</h2>
 * <ol>
 *   <li>LIFTOFF: full thrust along the launch site's radial up, until {@code liftHeightM} above it.</li>
 *   <li>ASCENT: full thrust in a fixed direction, pitched {@code γ} above the launch horizontal toward the target,
 *       for {@code t1}. {@code t1} is found by bisection so that the coast would cross the gate's radius, descending,
 *       at the target's downrange angle.</li>
 *   <li>COAST: no thrust.</li>
 *   <li>BRAKING: zero-effort-miss / zero-effort-velocity feedback guidance, a = 6 ZEM/tgo² − 2 ZEV/tgo, to the gate
 *       ({@code gateHeightM} above the landing site, descending at {@code gateSpeedMps}), thrust clamped to the
 *       engine's range. For each candidate braking start the shortest feasible duration is found; the start that
 *       uses least propellant is kept.</li>
 *   <li>TERMINAL: vertical-velocity hold at {@code descentSpeedMps} with horizontal position hold over the site,
 *       to touchdown.</li>
 * </ol>
 * Every pitch of the selected {@link Profile} is tried; the feasible candidate using least propellant wins. That is
 * the least-propellant <em>tested</em> candidate, not a fuel-optimal trajectory.
 *
 * <h2>Rejections</h2>
 * A request that cannot be flown returns a {@link Hop} with a non-FEASIBLE {@link Status} and a reason, and no
 * trajectory. There is no fallback path.
 */
public final class HopSolver {
  /** Bumped whenever a change can alter a solution; part of every trajectory id. */
  public static final String VERSION = "hop-solver-1";
  /** Moon GM (m^3/s^2), BODY301_GM of gm_de440.tpc. */
  public static final double GM = 4902.800118e9;
  /** Mean lunar rotation rate (rad/s) about MOON_ME +Z: one sidereal month, 27.321661 d. */
  public static final double OMEGA = 2 * Math.PI / (27.321661 * 86400);
  public static final double DT = 0.05;
  /** Spacing of the published trajectory samples (s); phase boundaries are always sampled too. */
  public static final double SAMPLE_INTERVAL_S = 1.0;
  /** Gate tolerances for a braking candidate to count as converged. */
  static final double GATE_POSITION_TOL_M = 2.0, GATE_VELOCITY_TOL_MPS = 0.3;
  static final double GUIDANCE_HOLD_S = 1.0;
  static final double MAX_ASCENT_BURN_S = 200, MAX_COAST_S = 900, MAX_TERMINAL_S = 180;

  public enum Phase { LANDED, LIFTOFF, ASCENT, COAST, BRAKING, TERMINAL }

  public enum Status {
    FEASIBLE,
    OUTSIDE_TERRAIN_COVERAGE,
    UNSUPPORTED_RANGE,
    UNREACHABLE,
    INSUFFICIENT_PROPELLANT,
    TERRAIN_CLEARANCE,
    LANDING_SLOPE,
    LANDING_SPEED,
    NO_CONVERGENCE
  }

  /** Candidate pitch sets. */
  public enum Profile {
    MIN_PROPELLANT(20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75),
    LOW_ARC(15, 20, 25),
    HIGH_ARC(60, 65, 70, 75, 80);

    final double[] pitchesDeg;
    Profile(double... p) { pitchesDeg = p; }
  }

  /**
   * @param start the drone's landed position, Moon-fixed metres
   * @param propellantKg propellant on board at lift-off
   */
  public record Request(double[] start, double propellantKg, double latitudeDeg, double longitudeDeg, Profile profile, Vehicle vehicle) {}

  /** One state of the trajectory. Attitude q is scalar-first, MOON_ME_DE421 to body (v_body = q v q*). */
  public record State(double t, double[] r, double[] v, double[] q, double massKg, double thrustN, Phase phase) {}

  public record PhaseSpan(Phase phase, double startS, double endS) {}

  public record Hop(
      Status status,
      String reason,
      String trajectoryId,
      String terrainId,
      double rangeM,
      double pitchDeg,
      double durationS,
      double propellantKg,
      double deltaVMps,
      double maxHeightAboveTerrainM,
      double minClearanceM,
      double landingSlopeDeg,
      double touchdownVerticalMps,
      double touchdownHorizontalMps,
      double[] landing,
      double[] landingAttitude,
      List<PhaseSpan> phases,
      List<State> samples,
      String candidates,
      /** Every integration step (q holds the thrust vector, N), for checks; not published. */
      List<State> steps,
      double[] touchdownVelocity) {
    public boolean feasible() { return status == Status.FEASIBLE; }
  }

  private final MoonTerrain terrain;

  public HopSolver(MoonTerrain terrain) {
    this.terrain = terrain;
  }

  public static String trajectoryId(Request q, String terrainId) {
    final String s = String.join("|", VERSION, terrainId, q.vehicle().toString(),
        Double.toString(q.start()[0]), Double.toString(q.start()[1]), Double.toString(q.start()[2]),
        Double.toString(q.propellantKg()), Double.toString(q.latitudeDeg()), Double.toString(q.longitudeDeg()),
        q.profile().name());
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8))).substring(0, 16);
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Dynamics

  /** Gravity plus centrifugal acceleration in the rotating frame (no Coriolis). */
  static double[] apparentGravity(double[] r) {
    final double rn = Vec.norm(r);
    final double[] g = Vec.scale(r, -GM / (rn * rn * rn));
    // -ω×(ω×r) = ω² (x, y, 0) for ω along +Z.
    return Vec.add(g, Vec.of(OMEGA * OMEGA * r[0], OMEGA * OMEGA * r[1], 0));
  }

  static double[] acceleration(double[] r, double[] v, double[] thrust, double m) {
    final double[] a = apparentGravity(r);
    // Coriolis -2 ω×v = 2Ω (v_y, -v_x, 0).
    return Vec.of(a[0] + 2 * OMEGA * v[1] + thrust[0] / m, a[1] - 2 * OMEGA * v[0] + thrust[1] / m, a[2] + thrust[2] / m);
  }

  /** Mutable integration state. */
  static final class S {
    double t;
    long n;
    double[] r, v;
    double m;
    S(double t, double[] r, double[] v, double m) { this.t = t; this.n = Math.round(t / DT); this.r = r; this.v = v; this.m = m; }
    S copy() { final S c = new S(t, r.clone(), v.clone(), m); c.n = n; return c; }
  }

  /** One RK4 step with thrust vector held; mass falls linearly. */
  static void step(S s, double[] thrust, double mdot, double dt) {
    final double[] r = s.r, v = s.v;
    final double m0 = s.m, mh = m0 - mdot * dt / 2, m1 = m0 - mdot * dt;
    final double[] k1v = acceleration(r, v, thrust, m0), k1r = v;
    final double[] r2 = Vec.axpy(r, dt / 2, k1r), v2 = Vec.axpy(v, dt / 2, k1v);
    final double[] k2v = acceleration(r2, v2, thrust, mh), k2r = v2;
    final double[] r3 = Vec.axpy(r, dt / 2, k2r), v3 = Vec.axpy(v, dt / 2, k2v);
    final double[] k3v = acceleration(r3, v3, thrust, mh), k3r = v3;
    final double[] r4 = Vec.axpy(r, dt, k3r), v4 = Vec.axpy(v, dt, k3v);
    final double[] k4v = acceleration(r4, v4, thrust, m1), k4r = v4;
    for (int i = 0; i < 3; i++) {
      r[i] += dt / 6 * (k1r[i] + 2 * k2r[i] + 2 * k3r[i] + k4r[i]);
      v[i] += dt / 6 * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i]);
    }
    s.m = m1;
    // Whole steps advance an integer count, so times stay exact multiples of DT (no accumulated rounding).
    if (dt == DT) s.t = ++s.n * DT; else s.t += dt;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Flight construction

  /** Geometry shared by every candidate of one request. */
  private final class Geometry {
    final Request q;
    final double[] up0, east0, target, upT, gate, vGate;
    final double theta, gateRadius, dryKg;
    Geometry(Request q, double[] target) {
      this.q = q;
      this.up0 = Vec.unit(q.start());
      this.target = target;
      this.upT = Vec.unit(target);
      this.east0 = Vec.unit(Vec.reject(Vec.sub(target, q.start()), up0));
      this.gate = Vec.axpy(target, q.vehicle().gateHeightM(), upT);
      this.vGate = Vec.scale(upT, -q.vehicle().gateSpeedMps());
      this.theta = downrange(target);
      this.gateRadius = Vec.norm(gate);
      this.dryKg = q.vehicle().dryMassKg();
    }
    double downrange(double[] r) { return Math.atan2(Vec.dot(r, east0), Vec.dot(r, up0)); }
  }

  /** A flight being built: the states at every integration step and why it stopped, if it failed. */
  private static final class Flight {
    final List<State> states = new ArrayList<>();
    Status failure;
    String reason;
    double minClearance = Double.POSITIVE_INFINITY;
    double maxHeight = Double.NEGATIVE_INFINITY;
    Flight copy() {
      final Flight f = new Flight();
      f.states.addAll(states);
      f.minClearance = minClearance;
      f.maxHeight = maxHeight;
      return f;
    }
  }

  private interface Control { double[] thrust(S s); }

  /**
   * Integrates with {@code control} until {@code stop} or {@code maxS}; records each step into {@code f} and checks
   * propellant and (if {@code checkClearance}) terrain clearance. Returns false when the flight failed.
   */
  private boolean fly(Geometry g, S s, Flight f, Phase phase, Control control, java.util.function.Predicate<S> stop,
                      double maxS, boolean checkClearance) {
    final Vehicle veh = g.q.vehicle();
    final double end = s.t + maxS;
    while (!stop.test(s)) {
      if (s.t >= end - 1e-9) return false;
      final double[] thrust = control.thrust(s);
      final double tn = Vec.norm(thrust);
      final double mdot = veh.massFlowKgps(tn);
      if (s.m - mdot * DT < g.dryKg) {
        f.failure = Status.INSUFFICIENT_PROPELLANT;
        f.reason = String.format(Locale.ROOT, "propellant exhausted during %s at t=%.1f s", phase, s.t);
        return false;
      }
      f.states.add(new State(s.t, s.r.clone(), s.v.clone(), thrust, s.m, tn, phase));
      step(s, thrust, mdot, DT);
      final MoonTerrain.Sample ground = terrain.sample(s.r);
      if (ground == null) {
        f.failure = Status.OUTSIDE_TERRAIN_COVERAGE;
        f.reason = String.format(Locale.ROOT, "no terrain under the flight at %.5f, %.5f", Vec.latDeg(s.r), Vec.lonDeg(s.r));
        return false;
      }
      final double c = Vec.norm(s.r) - MoonTerrain.RADIUS_M - ground.heightM();
      f.maxHeight = Math.max(f.maxHeight, c);
      if (checkClearance) {
        f.minClearance = Math.min(f.minClearance, c - ground.uncertaintyM());
        if (c - ground.uncertaintyM() < veh.minClearanceM()) {
          f.failure = Status.TERRAIN_CLEARANCE;
          f.reason = String.format(Locale.ROOT, "%.1f m above terrain (%.1f m tile uncertainty) during %s at %.5f, %.5f; %.1f m required",
              c, ground.uncertaintyM(), phase, Vec.latDeg(s.r), Vec.lonDeg(s.r), veh.minClearanceM());
          return false;
        }
      }
    }
    return true;
  }

  private static double[] fullThrust(Vehicle v, double[] dir) { return Vec.scale(dir, v.maxThrustN()); }

  /** LIFTOFF from rest at the start position. */
  private Flight liftoff(Geometry g, S s) {
    final Vehicle v = g.q.vehicle();
    final Flight f = new Flight();
    final double r0 = Vec.norm(g.q.start());
    fly(g, s, f, Phase.LIFTOFF, x -> fullThrust(v, g.up0), x -> Vec.norm(x.r) - r0 >= v.liftHeightM(), 60, false);
    return f;
  }

  private double[] ascentDirection(Geometry g, double pitchDeg) {
    final double p = Math.toRadians(pitchDeg);
    return Vec.add(Vec.scale(g.east0, Math.cos(p)), Vec.scale(g.up0, Math.sin(p)));
  }

  /** Downrange angle (minus the target's) where a ballistic coast from s crosses the gate radius descending. */
  private double coastMiss(Geometry g, S start) {
    final S s = start.copy();
    final double[] zero = Vec.of(0, 0, 0);
    double prevExcess = Vec.norm(s.r) - g.gateRadius, prevAngle = g.downrange(s.r);
    final double end = s.t + MAX_COAST_S;
    while (s.t < end) {
      step(s, zero, 0, DT);
      final double excess = Vec.norm(s.r) - g.gateRadius, angle = g.downrange(s.r);
      final double clearance = terrain.clearanceM(s.r);
      if (excess <= 0 && prevExcess > 0 && Vec.dot(s.v, s.r) < 0) {
        final double u = prevExcess / (prevExcess - excess);
        return prevAngle + u * (angle - prevAngle) - g.theta;
      }
      if (!(clearance > 0)) return angle - g.theta; // hit terrain or left coverage first
      prevExcess = excess;
      prevAngle = angle;
    }
    return g.downrange(s.r) - g.theta;
  }

  private S afterAscent(Geometry g, S lifted, double pitchDeg, double t1) {
    final S s = lifted.copy();
    final Vehicle v = g.q.vehicle();
    final double[] thrust = fullThrust(v, ascentDirection(g, pitchDeg));
    final double mdot = v.massFlowKgps(v.maxThrustN());
    final int n = (int) Math.floor(t1 / DT + 1e-9);
    for (int i = 0; i < n; i++) step(s, thrust, mdot, DT);
    final double rest = t1 - n * DT;
    if (rest > 1e-9) step(s, thrust, mdot, rest);
    return s;
  }

  /** ZEM/ZEV braking command toward the gate, clamped to the engine. */
  private double[] brakingThrust(Geometry g, S s, double tEnd, double[] held) {
    final Vehicle v = g.q.vehicle();
    final double tgo = tEnd - s.t;
    if (tgo <= GUIDANCE_HOLD_S && held != null) return held;
    final double[] gr = apparentGravity(s.r);
    final double[] zem = Vec.sub(g.gate, Vec.add(Vec.axpy(s.r, tgo, s.v), Vec.scale(gr, 0.5 * tgo * tgo)));
    final double[] zev = Vec.sub(g.vGate, Vec.axpy(s.v, tgo, gr));
    final double[] a = Vec.sub(Vec.scale(zem, 6 / (tgo * tgo)), Vec.scale(zev, 2 / tgo));
    return clamp(v, Vec.scale(a, s.m), g.upT);
  }

  private static double[] clamp(Vehicle v, double[] thrust, double[] fallbackDir) {
    final double n = Vec.norm(thrust), lo = v.minThrottle() * v.maxThrustN(), hi = v.maxThrustN();
    if (n < 1e-9) return Vec.scale(fallbackDir, lo);
    return n > hi ? Vec.scale(thrust, hi / n) : n < lo ? Vec.scale(thrust, lo / n) : thrust;
  }

  private record Braking(boolean ok, S end, Flight flight, double propellantKg) {}

  private Braking brake(Geometry g, S start, Flight before, double tgo) {
    final S s = start.copy();
    final Flight f = before.copy();
    final double tEnd = s.t + tgo;
    final double[][] held = {null};
    final boolean ok = fly(g, s, f, Phase.BRAKING, x -> {
      final double[] t = brakingThrust(g, x, tEnd, held[0]);
      if (tEnd - x.t > GUIDANCE_HOLD_S) held[0] = t;
      return t;
    }, x -> x.t >= tEnd - 1e-9, tgo + 1, true);
    final boolean converged = ok && Vec.norm(Vec.sub(s.r, g.gate)) <= GATE_POSITION_TOL_M
        && Vec.norm(Vec.sub(s.v, g.vGate)) <= GATE_VELOCITY_TOL_MPS;
    if (!ok && f.failure == null) {
      f.failure = Status.NO_CONVERGENCE;
      f.reason = "braking did not finish";
    } else if (ok && !converged) {
      f.failure = Status.NO_CONVERGENCE;
      f.reason = String.format(Locale.ROOT, "braking missed the gate by %.1f m, %.2f m/s",
          Vec.norm(Vec.sub(s.r, g.gate)), Vec.norm(Vec.sub(s.v, g.vGate)));
    }
    return new Braking(converged, s, f, start.m - s.m);
  }

  /** Terminal descent; returns the touchdown state or null (failure recorded in f). */
  private S terminal(Geometry g, S s, Flight f) {
    final Vehicle v = g.q.vehicle();
    final double[] vRef = Vec.scale(g.upT, -v.descentSpeedMps());
    final double kv = 1.0, kp = 0.25;
    final boolean ok = fly(g, s, f, Phase.TERMINAL, x -> {
      final double[] eh = Vec.reject(Vec.sub(x.r, g.target), g.upT);
      final double[] a = Vec.sub(Vec.axpy(Vec.scale(Vec.sub(vRef, x.v), kv), -kp, eh), apparentGravity(x.r));
      return clamp(v, Vec.scale(a, x.m), g.upT);
    }, x -> terrain.clearanceM(x.r) <= 0, MAX_TERMINAL_S, false);
    return ok ? s : null;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private record Candidate(double pitchDeg, Flight flight, S touchdown, double propellantKg, String note) {}

  public Hop solve(Request q) {
    final String tid = trajectoryId(q, terrain.id);
    final Vehicle v = q.vehicle();
    final double[] targetDir = Vec.direction(q.latitudeDeg(), q.longitudeDeg());
    if (q.propellantKg() < 0 || q.propellantKg() > v.propellantCapacityKg() + 1e-9) {
      return fail(Status.INSUFFICIENT_PROPELLANT, String.format(Locale.ROOT, "propellant %.2f kg outside 0..%.1f kg", q.propellantKg(), v.propellantCapacityKg()), tid, 0, "");
    }
    if (terrain.sample(q.start()) == null) return fail(Status.OUTSIDE_TERRAIN_COVERAGE, "no terrain at the start position", tid, 0, "");
    final MoonTerrain.Sample site = terrain.sample(targetDir);
    if (site == null) {
      return fail(Status.OUTSIDE_TERRAIN_COVERAGE, String.format(Locale.ROOT, "destination %.5f, %.5f is outside the terrain pack", q.latitudeDeg(), q.longitudeDeg()), tid, 0, "");
    }
    final double[] target = terrain.surfacePoint(targetDir);
    final double rangeM = Vec.angle(q.start(), target) * MoonTerrain.RADIUS_M;
    if (rangeM < v.minRangeM() || rangeM > v.maxRangeM()) {
      return fail(Status.UNSUPPORTED_RANGE, String.format(Locale.ROOT, "range %.0f m outside the supported %.0f..%.0f m", rangeM, v.minRangeM(), v.maxRangeM()), tid, rangeM, "");
    }
    if (site.level() < v.minLandingTerrainLevel()) {
      return fail(Status.OUTSIDE_TERRAIN_COVERAGE, String.format(Locale.ROOT,
          "landing site terrain is level %d (%s); level %d or finer is required to assess it", site.level(), site.tileId(), v.minLandingTerrainLevel()), tid, rangeM, "");
    }
    final double slope = terrain.slopeDeg(targetDir, v.landingSlopeBaselineM());
    if (Double.isNaN(slope)) return fail(Status.OUTSIDE_TERRAIN_COVERAGE, "no terrain around the landing site to measure its slope", tid, rangeM, "");
    if (slope > v.maxLandingSlopeDeg()) {
      return fail(Status.LANDING_SLOPE, String.format(Locale.ROOT, "landing site slope %.1f° exceeds %.1f°", slope, v.maxLandingSlopeDeg()), tid, rangeM, "");
    }

    final Geometry g = new Geometry(q, target);
    final S s0 = new S(0, q.start().clone(), Vec.of(0, 0, 0), v.dryMassKg() + q.propellantKg());
    final double weightN = s0.m * Vec.norm(apparentGravity(s0.r));
    if (v.maxThrustN() <= weightN * 1.05) {
      return fail(Status.UNREACHABLE, String.format(Locale.ROOT, "thrust %.0f N cannot lift %.1f kg (weight %.0f N)", v.maxThrustN(), s0.m, weightN), tid, rangeM, "");
    }
    final Flight lift = liftoff(g, s0);
    if (lift.failure != null) return fail(lift.failure, lift.reason, tid, rangeM, "");

    Candidate best = null;
    final List<Candidate> rejected = new ArrayList<>(), feasible = new ArrayList<>();
    for (final double pitch : q.profile().pitchesDeg) {
      final Candidate c = candidate(g, s0, lift, pitch);
      if (c.touchdown() == null) { rejected.add(c); continue; }
      feasible.add(c);
      if (best == null || c.propellantKg() < best.propellantKg()) best = c;
    }
    final StringBuilder notes = new StringBuilder();
    for (final Candidate c : feasible) {
      notes.append(String.format(Locale.ROOT, "%.0f°: %.2f kg%s; ", c.pitchDeg(), c.propellantKg(), c == best ? " (selected)" : ""));
    }
    for (final Candidate c : rejected) notes.append(String.format(Locale.ROOT, "%.0f°: %s; ", c.pitchDeg(), c.note()));
    if (best == null) {
      // The most advanced failure tells the most: an obstruction or landing problem beats "could not reach".
      final Candidate worst = rejected.stream().max(java.util.Comparator.comparingInt(c -> rank(c.flight().failure))).orElseThrow();
      return fail(worst.flight().failure, worst.flight().reason + " (best of " + rejected.size() + " pitches)", tid, rangeM, notes.toString());
    }
    return finish(g, best, tid, rangeM, slope, notes.toString());
  }

  private static int rank(Status s) {
    return switch (s) {
      case LANDING_SPEED -> 6;
      case TERRAIN_CLEARANCE -> 5;
      case INSUFFICIENT_PROPELLANT -> 4;
      case NO_CONVERGENCE -> 3;
      case OUTSIDE_TERRAIN_COVERAGE -> 2;
      default -> 1;
    };
  }

  private Candidate candidate(Geometry g, S s0, Flight lift, double pitch) {
    final Vehicle v = g.q.vehicle();
    final S lifted = s0; // liftoff() advanced s0 to the end of the vertical rise
    final double mdot = v.massFlowKgps(v.maxThrustN());
    final double propLimitedS = (lifted.m - v.dryMassKg() - v.reservePropellantKg()) / mdot;
    final double hi0 = Math.min(MAX_ASCENT_BURN_S, propLimitedS);
    final Flight noTrajectory = lift.copy();
    if (hi0 <= 0 || coastMiss(g, afterAscent(g, lifted, pitch, hi0)) < 0) {
      noTrajectory.failure = hi0 == propLimitedS ? Status.INSUFFICIENT_PROPELLANT : Status.UNREACHABLE;
      noTrajectory.reason = hi0 == propLimitedS
          ? String.format(Locale.ROOT, "the remaining propellant cannot reach the target at %.0f° pitch", pitch)
          : String.format(Locale.ROOT, "a %.0f s full-thrust ascent at %.0f° pitch does not reach the target", MAX_ASCENT_BURN_S, pitch);
      return new Candidate(pitch, noTrajectory, null, 0, noTrajectory.failure.name());
    }
    double lo = 0, hi = hi0;
    for (int i = 0; i < 40 && hi - lo > 1e-4; i++) {
      final double mid = 0.5 * (lo + hi);
      if (coastMiss(g, afterAscent(g, lifted, pitch, mid)) < 0) lo = mid; else hi = mid;
    }
    // Whole integration steps, so the recorded ascent is exactly the one the search evaluated.
    final double t1 = Math.max(1, Math.round(hi / DT)) * DT;

    // The nominal flight: ascent then coast to the gate radius, recorded at every step.
    final Flight f = lift.copy();
    final S s = lifted.copy();
    final double ascentEnd = s.t + t1;
    final double[] thrust = fullThrust(v, ascentDirection(g, pitch));
    if (!fly(g, s, f, Phase.ASCENT, x -> thrust, x -> x.t >= ascentEnd - DT / 2, t1 + 1, true)) {
      return new Candidate(pitch, f, null, 0, f.failure.name());
    }
    final List<S> coast = new ArrayList<>();
    final Flight coastFlight = f.copy();
    final S c = s.copy();
    final boolean coastOk = fly(g, c, coastFlight, Phase.COAST, x -> {
      coast.add(x.copy());
      return Vec.of(0, 0, 0);
    }, x -> Vec.norm(x.r) <= g.gateRadius && Vec.dot(x.v, x.r) < 0, MAX_COAST_S, true);
    if (coast.isEmpty()) {
      if (coastFlight.failure == null) { coastFlight.failure = Status.UNREACHABLE; coastFlight.reason = "no coast"; }
      return new Candidate(pitch, coastFlight, null, 0, coastFlight.failure.name());
    }
    if (!coastOk && coastFlight.failure == null) {
      coastFlight.failure = Status.UNREACHABLE;
      coastFlight.reason = "coast did not reach the gate";
    }

    // Braking start: every 2 s back from the gate along the descending coast, stopping once the cost has risen
    // three times in a row; then every 0.25 s around the best.
    Braking best = null;
    double bestTs = Double.NaN;
    Flight lastFailure = coastFlight.failure != null ? coastFlight : null;
    final int stride = (int) Math.round(2.0 / DT);
    int rising = 0;
    for (int i = coast.size() - 1; i >= 0 && rising < 3; i -= stride) {
      if (Vec.dot(coast.get(i).v, coast.get(i).r) > 0) break; // still climbing
      final Braking b = brakeFrom(g, f, coast, i);
      if (!b.ok()) { lastFailure = b.flight(); continue; }
      if (best == null || b.propellantKg() < best.propellantKg()) { best = b; bestTs = i; rising = 0; } else rising++;
    }
    if (best != null) {
      final int center = (int) bestTs, fine = (int) Math.round(0.25 / DT);
      for (int i = Math.max(0, center - stride); i <= Math.min(coast.size() - 1, center + stride); i += fine) {
        final Braking b = brakeFrom(g, f, coast, i);
        if (b != null && b.ok() && b.propellantKg() < best.propellantKg()) best = b;
      }
    }
    if (best == null) {
      final Flight fail = lastFailure != null ? lastFailure : coastFlight;
      if (fail.failure == null) { fail.failure = Status.NO_CONVERGENCE; fail.reason = "no braking start reached the gate"; }
      return new Candidate(pitch, fail, null, 0, fail.failure.name());
    }
    final Flight full = best.flight();
    final S td = terminal(g, best.end().copy(), full);
    if (td == null) {
      if (full.failure == null) { full.failure = Status.NO_CONVERGENCE; full.reason = "terminal descent did not land"; }
      return new Candidate(pitch, full, null, 0, full.failure.name());
    }
    return new Candidate(pitch, full, td, v.dryMassKg() + g.q.propellantKg() - td.m, "");
  }

  /** Braking from coast index i, with the shortest converging duration (bisection), or null if none does. */
  private Braking brakeFrom(Geometry g, Flight ascent, List<S> coast, int i) {
    final Flight before = ascent.copy();
    for (int k = 0; k < i; k++) {
      final S x = coast.get(k);
      before.states.add(new State(x.t, x.r.clone(), x.v.clone(), Vec.of(0, 0, 0), x.m, 0, Phase.COAST));
      before.maxHeight = Math.max(before.maxHeight, terrain.clearanceM(x.r));
      final MoonTerrain.Sample gs = terrain.sample(x.r);
      before.minClearance = Math.min(before.minClearance, Vec.norm(x.r) - MoonTerrain.RADIUS_M - gs.heightM() - gs.uncertaintyM());
    }
    final S start = coast.get(i);
    Braking hiB = brake(g, start, before, 120);
    if (!hiB.ok()) return hiB;
    double lo = 2, hi = 120;
    for (int it = 0; it < 14 && hi - lo > 0.25; it++) {
      final double mid = 0.5 * (lo + hi);
      final Braking b = brake(g, start, before, mid);
      if (b.ok()) { hi = mid; hiB = b; } else lo = mid;
    }
    // Shortest converging braking need not be the cheapest; also try a little longer.
    for (final double extra : new double[] {2, 5}) {
      final Braking b = brake(g, start, before, hi + extra);
      if (b.ok() && b.propellantKg() < hiB.propellantKg()) hiB = b;
    }
    return hiB;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private Hop finish(Geometry g, Candidate c, String tid, double rangeM, double slope, String notes) {
    final Vehicle v = g.q.vehicle();
    final S td = c.touchdown();
    final double[] up = Vec.unit(td.r);
    final double vert = -Vec.dot(td.v, up), horiz = Vec.norm(Vec.reject(td.v, up));
    final double propellant = g.q.propellantKg() - (td.m - v.dryMassKg());
    if (vert > v.maxTouchdownVerticalMps() || horiz > v.maxTouchdownHorizontalMps()) {
      return fail(Status.LANDING_SPEED, String.format(Locale.ROOT, "touchdown at %.2f m/s vertical, %.2f m/s horizontal exceeds %.1f / %.1f m/s",
          vert, horiz, v.maxTouchdownVerticalMps(), v.maxTouchdownHorizontalMps()), tid, rangeM, notes);
    }
    if (td.m - v.dryMassKg() < v.reservePropellantKg()) {
      return fail(Status.INSUFFICIENT_PROPELLANT, String.format(Locale.ROOT, "%.2f kg would remain after landing; %.1f kg reserve required",
          td.m - v.dryMassKg(), v.reservePropellantKg()), tid, rangeM, notes);
    }
    final double[] landing = terrain.surfacePoint(td.r);
    final double[] n = terrain.normal(landing, v.landingSlopeBaselineM());
    final double[] normal = n != null ? n : Vec.unit(landing);
    final double[] landedQ = landedAttitude(normal, g.east0);
    final List<State> all = c.flight().states;
    // Thrust-direction attitudes need the step's thrust vector, held in the State's q slot during the build.
    final List<State> samples = new ArrayList<>();
    final List<PhaseSpan> phases = new ArrayList<>();
    Phase current = null;
    double phaseStart = 0, lastSample = Double.NEGATIVE_INFINITY;
    for (int i = 0; i < all.size(); i++) {
      final State x = all.get(i);
      final boolean boundary = x.phase() != current;
      if (boundary) {
        if (current != null) phases.add(new PhaseSpan(current, phaseStart, x.t()));
        current = x.phase();
        phaseStart = x.t();
      }
      if (boundary || x.t() - lastSample >= SAMPLE_INTERVAL_S - 1e-9) {
        samples.add(withAttitude(x, g));
        lastSample = x.t();
      }
    }
    phases.add(new PhaseSpan(current, phaseStart, td.t));
    samples.add(new State(td.t, landing, Vec.of(0, 0, 0), landedQ, td.m, 0, Phase.LANDED));
    final double rocketDv = v.ispS() * Vehicle.G0 * Math.log((v.dryMassKg() + g.q.propellantKg()) / td.m);
    return new Hop(Status.FEASIBLE, String.format(Locale.ROOT, "%.0f m hop at %.0f° pitch, %.1f s, %.2f kg", rangeM, c.pitchDeg(), td.t, propellant),
        tid, terrain.id, rangeM, c.pitchDeg(), td.t, propellant, rocketDv, c.flight().maxHeight, c.flight().minClearance, slope, vert, horiz,
        landing, landedQ, List.copyOf(phases), List.copyOf(samples), notes, List.copyOf(all), td.copy().v);
  }

  /** The attitude policy: thrust axis +Z while powered, nadir-hold (+Z up, +X along track) while coasting. */
  private static State withAttitude(State x, HopSolver.Geometry g) {
    final double[] thrust = x.q(); // the build stored the step's thrust vector here
    final double[] z, xAxis;
    if (x.phase() == Phase.COAST) {
      z = Vec.unit(x.r());
      final double[] h = Vec.reject(x.v(), z);
      xAxis = Vec.norm(h) > 0.1 ? Vec.unit(h) : Vec.unit(Vec.reject(g.east0, z));
    } else {
      z = Vec.unit(thrust);
      xAxis = Vec.unit(Vec.reject(g.east0, z));
    }
    final double[] y = Vec.cross(z, xAxis);
    return new State(x.t(), x.r(), x.v(), Vec.quaternion(xAxis, y, z), x.massKg(), x.thrustN(), x.phase());
  }

  /** The coast attitude policy: +Z radial up (camera at nadir), +X along the horizontal velocity. */
  public static double[] coastAttitude(double[] r, double[] v) {
    final double[] z = Vec.unit(r);
    final double[] x = Vec.unit(Vec.reject(v, z));
    return Vec.quaternion(x, Vec.cross(z, x), z);
  }

  /** The phase at {@code t} seconds after lift-off (LANDED outside the flight). */
  public static Phase phaseAt(Hop hop, double t) {
    for (final PhaseSpan p : hop.phases()) if (t >= p.startS() && t < p.endS()) return p.phase();
    return Phase.LANDED;
  }

  public static PhaseSpan span(Hop hop, Phase phase) {
    return hop.phases().stream().filter(p -> p.phase() == phase).findFirst().orElseThrow();
  }

  /**
   * Position and velocity at {@code t} seconds after lift-off, by cubic Hermite interpolation between the two
   * integration steps around it (DT apart; micrometre-level error against the integrated path).
   */
  public static double[][] stateAt(Hop hop, double t) {
    final List<State> s = hop.steps();
    final int i = (int) Math.max(0, Math.min(s.size() - 2, Math.floor(t / DT)));
    final State a = s.get(i), b = s.get(i + 1);
    final double h = b.t() - a.t(), u = (t - a.t()) / h;
    final double h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
    final double d00 = 6 * u * u - 6 * u, d10 = 3 * u * u - 4 * u + 1, d01 = -6 * u * u + 6 * u, d11 = 3 * u * u - 2 * u;
    final double[] r = new double[3], v = new double[3];
    for (int k = 0; k < 3; k++) {
      r[k] = h00 * a.r()[k] + h10 * h * a.v()[k] + h01 * b.r()[k] + h11 * h * b.v()[k];
      v[k] = (d00 * a.r()[k] + d10 * h * a.v()[k] + d01 * b.r()[k] + d11 * h * b.v()[k]) / h;
    }
    return new double[][] {r, v};
  }

  /** Landed attitude: +Z along the terrain normal, +X toward {@code heading} projected onto the ground. */
  public static double[] landedAttitude(double[] normal, double[] heading) {
    final double[] z = Vec.unit(normal);
    final double[] x = Vec.unit(Vec.reject(heading, z));
    return Vec.quaternion(x, Vec.cross(z, x), z);
  }

  private Hop fail(Status status, String reason, String tid, double rangeM, String notes) {
    return new Hop(status, reason, tid, terrain.id, rangeM, Double.NaN, 0, 0, 0, Double.NaN, Double.NaN, Double.NaN, Double.NaN, Double.NaN,
        null, null, List.of(), List.of(), notes, List.of(), null);
  }
}
