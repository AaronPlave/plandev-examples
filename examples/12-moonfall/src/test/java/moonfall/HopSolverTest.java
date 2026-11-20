package moonfall;

import moonfall.HopSolver.Hop;
import moonfall.HopSolver.Phase;
import moonfall.HopSolver.Profile;
import moonfall.HopSolver.Request;
import moonfall.HopSolver.State;
import moonfall.HopSolver.Status;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Hop solutions checked against independent arithmetic: this test's own gravity and integrator, the rocket
 * equation, the terrain sampled afresh, and Hermite reconstruction of the published samples.
 */
class HopSolverTest {
  static final MoonTerrain T = MoonTerrain.get();
  static final HopSolver SOLVER = new HopSolver(T);
  static final Vehicle V = Vehicle.defaults();
  /** Polaris-A's base in the old Cosmolabe scene. */
  static final double[] BASE = T.surfacePoint(Vec.direction(-89.55, -45));
  // Independent constants (documented values, not read from HopSolver).
  static final double GM = 4902.800118e9, OMEGA = 2 * Math.PI / (27.321661 * 86400), DT = 0.05;

  static Hop solve(double[] start, double prop, double lat, double lon, Profile p, Vehicle v) {
    return SOLVER.solve(new Request(start, prop, lat, lon, p, v));
  }

  static Hop solve(double lat, double lon) {
    return solve(BASE, 40, lat, lon, Profile.MIN_PROPELLANT, V);
  }

  // A short hop and a longer one, both feasible from the base.
  static final Hop NEAR = solve(-89.62, -30);
  static final Hop FAR = solve(-89.70, 0);

  @Test
  void feasibleHopsLandWhereAsked() {
    for (final Hop h : List.of(NEAR, FAR)) {
      assertEquals(Status.FEASIBLE, h.status(), h.reason());
      final double[] target = T.surfacePoint(Vec.direction(h == NEAR ? -89.62 : -89.70, h == NEAR ? -30 : 0));
      assertTrue(Vec.norm(Vec.sub(h.landing(), target)) < 1.0, "lands within 1 m of the requested site");
      assertEquals(0, T.clearanceM(h.landing()), 1e-6, "landing point is on the terrain");
      assertTrue(h.touchdownVerticalMps() <= V.maxTouchdownVerticalMps() && h.touchdownHorizontalMps() <= V.maxTouchdownHorizontalMps());
      assertEquals(Phase.LANDED, h.samples().get(h.samples().size() - 1).phase());
      assertEquals(h.durationS(), h.samples().get(h.samples().size() - 1).t(), 1e-9);
    }
    assertTrue(FAR.rangeM() > 2 * NEAR.rangeM());
    assertTrue(FAR.durationS() > NEAR.durationS());
    assertTrue(FAR.propellantKg() > NEAR.propellantKg());
    assertNotEquals(NEAR.trajectoryId(), FAR.trajectoryId());
  }

  @Test
  void phasesAreInFlightOrderAndContiguous() {
    final List<Phase> order = List.of(Phase.LIFTOFF, Phase.ASCENT, Phase.COAST, Phase.BRAKING, Phase.TERMINAL);
    assertEquals(order, FAR.phases().stream().map(HopSolver.PhaseSpan::phase).toList());
    for (int i = 1; i < FAR.phases().size(); i++) assertEquals(FAR.phases().get(i - 1).endS(), FAR.phases().get(i).startS(), 0);
    assertEquals(FAR.durationS(), FAR.phases().get(FAR.phases().size() - 1).endS(), 0);
  }

  @Test
  void deterministic() {
    final Hop again = solve(-89.70, 0);
    assertEquals(FAR.trajectoryId(), again.trajectoryId());
    assertEquals(FAR.samples().size(), again.samples().size());
    for (int i = 0; i < FAR.samples().size(); i++) {
      assertArrayEquals(FAR.samples().get(i).r(), again.samples().get(i).r(), 0);
      assertArrayEquals(FAR.samples().get(i).q(), again.samples().get(i).q(), 0);
    }
    assertEquals(FAR.propellantKg(), again.propellantKg(), 0);
  }

  /** Each step re-integrated with this test's own dynamics, ten times finer, from the recorded state and thrust. */
  @Test
  void everyStepObeysGravityAndTheDeclaredThrust() {
    for (final Hop h : List.of(NEAR, FAR)) {
      final List<State> s = h.steps();
      double worstR = 0, worstV = 0;
      for (int i = 0; i + 1 < s.size(); i++) {
        final State a = s.get(i), b = s.get(i + 1);
        if (b.t() - a.t() > DT + 1e-9) continue; // ascent → coast boundary is a whole step too, but be safe
        double[] r = a.r().clone(), v = a.v().clone();
        double m = a.massKg();
        final double[] thrust = a.q();
        final double mdot = Vec.norm(thrust) / (V.ispS() * 9.80665);
        final int n = 10;
        final double h2 = (b.t() - a.t()) / n;
        for (int k = 0; k < n; k++) {
          final double[][] k1 = deriv(r, v, m, thrust);
          final double[][] k2 = deriv(Vec.axpy(r, h2 / 2, k1[0]), Vec.axpy(v, h2 / 2, k1[1]), m - mdot * h2 / 2, thrust);
          final double[][] k3 = deriv(Vec.axpy(r, h2 / 2, k2[0]), Vec.axpy(v, h2 / 2, k2[1]), m - mdot * h2 / 2, thrust);
          final double[][] k4 = deriv(Vec.axpy(r, h2, k3[0]), Vec.axpy(v, h2, k3[1]), m - mdot * h2, thrust);
          for (int j = 0; j < 3; j++) {
            r[j] += h2 / 6 * (k1[0][j] + 2 * k2[0][j] + 2 * k3[0][j] + k4[0][j]);
            v[j] += h2 / 6 * (k1[1][j] + 2 * k2[1][j] + 2 * k3[1][j] + k4[1][j]);
          }
          m -= mdot * h2;
        }
        worstR = Math.max(worstR, Vec.norm(Vec.sub(r, b.r())));
        worstV = Math.max(worstV, Vec.norm(Vec.sub(v, b.v())));
        assertEquals(m, b.massKg(), 1e-9, "mass falls at |T|/(Isp g0)");
      }
      assertTrue(worstR < 1e-6, "position continuity " + worstR + " m");
      assertTrue(worstV < 1e-7, "velocity continuity " + worstV + " m/s");
    }
  }

  static double[][] deriv(double[] r, double[] v, double m, double[] thrust) {
    final double rn = Vec.norm(r);
    final double[] w = {0, 0, OMEGA};
    double[] a = Vec.scale(r, -GM / (rn * rn * rn));
    a = Vec.sub(a, Vec.scale(Vec.cross(w, v), 2));
    a = Vec.sub(a, Vec.cross(w, Vec.cross(w, r)));
    a = Vec.axpy(a, 1 / m, thrust);
    return new double[][] {v, a};
  }

  @Test
  void thrustStaysInTheEngineRangeAndPropellantMatchesTheRocketEquation() {
    for (final Hop h : List.of(NEAR, FAR)) {
      double impulse = 0;
      for (final State s : h.steps()) {
        final double t = Vec.norm(s.q());
        if (s.phase() == Phase.COAST) assertEquals(0, t, 0);
        else assertTrue(t >= V.minThrottle() * V.maxThrustN() - 1e-9 && t <= V.maxThrustN() + 1e-9, s.phase() + " thrust " + t);
        impulse += t * DT;
      }
      // Total impulse / (Isp g0) is the propellant burned, independent of the throttle history.
      assertEquals(h.propellantKg(), impulse / (V.ispS() * 9.80665), 1e-6);
      final double m0 = V.dryMassKg() + 40, mf = m0 - h.propellantKg();
      assertEquals(V.ispS() * 9.80665 * Math.log(m0 / mf), h.deltaVMps(), 1e-6);
    }
  }

  /** The Jacobi integral of the rotating frame is constant while coasting. */
  @Test
  void coastConservesTheJacobiIntegral() {
    double lo = Double.POSITIVE_INFINITY, hi = Double.NEGATIVE_INFINITY;
    for (final State s : FAR.steps()) {
      if (s.phase() != Phase.COAST) continue;
      final double c = 0.5 * Vec.dot(s.v(), s.v()) - GM / Vec.norm(s.r()) - 0.5 * OMEGA * OMEGA * (s.r()[0] * s.r()[0] + s.r()[1] * s.r()[1]);
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    assertTrue(hi - lo < 1e-6, "Jacobi drift " + (hi - lo) + " J/kg");
  }

  @Test
  void clearsTheTerrainFromLiftoffToTheGate() {
    for (final Hop h : List.of(NEAR, FAR)) {
      for (final State s : h.steps()) {
        if (s.phase() == Phase.LIFTOFF || s.phase() == Phase.TERMINAL) continue;
        final MoonTerrain.Sample g = T.sample(s.r());
        assertNotNull(g);
        assertTrue(Vec.norm(s.r()) - MoonTerrain.RADIUS_M - g.heightM() - g.uncertaintyM() >= V.minClearanceM() - 1e-9);
      }
    }
  }

  /** The 1 s samples, Hermite-interpolated as Cosmolabe does, reproduce every integration step. */
  @Test
  void publishedSamplesInterpolateToTheIntegratedPath() {
    for (final Hop h : List.of(NEAR, FAR)) {
      final List<State> samples = h.samples();
      double worst = 0;
      int j = 0;
      for (final State s : h.steps()) {
        while (j + 2 < samples.size() && samples.get(j + 1).t() <= s.t()) j++;
        final State a = samples.get(j), b = samples.get(j + 1);
        if (s.t() < a.t() || s.t() > b.t() || b.phase() == Phase.LANDED) continue;
        worst = Math.max(worst, Vec.norm(Vec.sub(hermite(a, b, s.t()), s.r())));
      }
      assertTrue(worst < 0.05, "interpolation error " + worst + " m");
    }
  }

  static double[] hermite(State a, State b, double t) {
    final double h = b.t() - a.t(), u = (t - a.t()) / h;
    final double h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
    final double[] p = new double[3];
    for (int i = 0; i < 3; i++) p[i] = h00 * a.r()[i] + h10 * h * a.v()[i] + h01 * b.r()[i] + h11 * h * b.v()[i];
    return p;
  }

  @Test
  void attitudeFollowsThePolicy() {
    for (final State s : FAR.samples()) {
      final double[] zBody = Vec.unrotate(s.q(), Vec.of(0, 0, 1));
      assertEquals(1, Math.hypot(Math.hypot(s.q()[0], s.q()[1]), Math.hypot(s.q()[2], s.q()[3])), 1e-12);
      if (s.phase() == Phase.COAST) {
        assertEquals(0, Vec.angle(zBody, Vec.unit(s.r())), 1e-9, "coast: +Z up, camera (-Z) at nadir");
        final double[] xBody = Vec.unrotate(s.q(), Vec.of(1, 0, 0));
        assertEquals(0, Vec.angle(xBody, Vec.unit(Vec.reject(s.v(), Vec.unit(s.r())))), 1e-9, "coast: +X along track");
      }
    }
    // Powered: +Z along thrust, checked on the dense steps (q there is the thrust vector).
    final State landed = FAR.samples().get(FAR.samples().size() - 1);
    final double[] n = T.normal(landed.r(), V.landingSlopeBaselineM());
    assertEquals(0, Vec.angle(Vec.unrotate(landed.q(), Vec.of(0, 0, 1)), n), 1e-9, "landed: +Z along the terrain normal");
  }

  @Test
  void nextHopStartsWhereThePreviousLanded() {
    final double left = 40 - NEAR.propellantKg();
    final Hop next = solve(NEAR.landing(), left, -89.55, -45, Profile.MIN_PROPELLANT, V);
    assertEquals(Status.FEASIBLE, next.status(), next.reason());
    assertArrayEquals(NEAR.landing(), next.samples().get(0).r(), 0);
    assertNotEquals(solve(-89.55, -45).status(), Status.FEASIBLE, "from the base, the base itself is no hop");
    assertTrue(Vec.norm(Vec.sub(next.landing(), BASE)) < 1.0);
  }

  @Test
  void framesAndUnits() {
    for (final State s : NEAR.samples()) {
      assertEquals(MoonTerrain.RADIUS_M, Vec.norm(s.r()), 20_000, "Moon-centred metres");
    }
    final double[] l = NEAR.landing();
    assertEquals(-89.62, Vec.latDeg(l), 1e-9);
    assertEquals(-30, Vec.lonDeg(l), 1e-6);
  }

  // --- Rejections: explicit status, reason, and no trajectory -------------------------------------------------

  static void rejected(Hop h, Status expected) {
    assertEquals(expected, h.status(), h.reason());
    assertFalse(h.reason().isBlank());
    assertTrue(h.samples().isEmpty(), "a rejected hop has no trajectory");
    assertNull(h.landing());
  }

  @Test
  void zeroDistanceAndNearbyDestinations() {
    rejected(solve(-89.55, -45), Status.UNSUPPORTED_RANGE);
    rejected(solve(-89.55, -44.95), Status.UNSUPPORTED_RANGE); // 12 m
  }

  @Test
  void unsupportedAndMissingTerrain() {
    rejected(solve(-88.5, 0), Status.OUTSIDE_TERRAIN_COVERAGE);
    // A packed tile of level 10 (~55 m posts) is too coarse to assess a landing site.
    final double[] coarse = tileCentre(10, 507, 508);
    assertEquals(10, T.sample(coarse).level());
    rejected(solve(Vec.latDeg(coarse), Vec.lonDeg(coarse)), Status.OUTSIDE_TERRAIN_COVERAGE);
  }

  static double[] tileCentre(int level, int x, int y) {
    final double n = 1 << level, u = (x + 0.5) / n * 2 - 1, v = (y + 0.5) / n * 2 - 1;
    return Vec.unit(Vec.of(-u, v, -1)); // nz: N=(0,0,-1), U=(-1,0,0), V=(0,1,0)
  }

  @Test
  void insufficientPropellant() {
    rejected(solve(BASE, 5, -89.62, -30, Profile.MIN_PROPELLANT, V), Status.INSUFFICIENT_PROPELLANT);
  }

  @Test
  void unreachableUnderTheDeclaredPropulsion() {
    final Vehicle weak = new Vehicle(60, 40, 150, 0.25, 235, 15, 30, 2, 1, 2, 0.5, 5, 12, 15, 11, 1, 50, 20_000);
    rejected(solve(BASE, 40, -89.62, -30, Profile.MIN_PROPELLANT, weak), Status.UNREACHABLE);
  }

  @Test
  void terrainObstruction() {
    // Shallow arcs from the base into the crater hit the rim; MIN_PROPELLANT climbs over it.
    rejected(solve(BASE, 40, -89.72, -5, Profile.LOW_ARC, V), Status.TERRAIN_CLEARANCE);
    assertEquals(Status.FEASIBLE, solve(BASE, 40, -89.72, -5, Profile.MIN_PROPELLANT, V).status());
  }

  @Test
  void unacceptableLandingTerrain() {
    final Hop h = solve(-89.45, -60);
    rejected(h, Status.LANDING_SLOPE);
    assertTrue(T.slopeDeg(Vec.direction(-89.45, -60), 15) > V.maxLandingSlopeDeg());
  }

  @Test
  void excessiveLandingVelocity() {
    final Vehicle hard = new Vehicle(60, 40, 440, 0.25, 235, 15, 30, 3, 3, 2, 0.5, 5, 12, 15, 11, 1, 50, 20_000);
    rejected(solve(BASE, 40, -89.62, -30, Profile.MIN_PROPELLANT, hard), Status.LANDING_SPEED);
  }
}
