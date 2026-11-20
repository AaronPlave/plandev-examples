package scheduling;

import gov.nasa.ammos.plandev.merlin.driver.MissionModel;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.orchestration.simulation.SimulationUtility;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.EditablePlan;
import gov.nasa.ammos.plandev.procedural.scheduling.utils.DefaultEditablePlanDriver;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.AnyInstance;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.DirectiveStart;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.Instance;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;
import gov.nasa.ammos.plandev.procedural.utils.TypeUtilsEditablePlanAdapter;
import gov.nasa.ammos.plandev.procedural.utils.TypeUtilsPlanAdapter;
import gov.nasa.ammos.plandev.types.ActivityDirectiveId;
import gov.nasa.ammos.plandev.types.Plan;
import gov.nasa.ammos.plandev.types.Timestamp;
import moonfall.Configuration;
import moonfall.DroneState;
import moonfall.HopSolver;
import moonfall.HopSolver.Hop;
import moonfall.LunarSky;
import moonfall.Mission;
import moonfall.MoonTerrain;
import moonfall.Vec;
import moonfall.generated.GeneratedModelType;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import scheduling.procedures.PlanHop;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** The mission model simulated locally (Merlin), and the PlanHop goal run against it. */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class MissionSimulationTest {
  static final Instant START = Instant.parse("2028-12-15T10:00:00Z");
  static final Duration T1 = Duration.of(1, Duration.HOUR);
  // Destination A: 3.9 km onto the Shackleton rim plain. Destination B: 9.7 km, down into the crater.
  static final double A_LAT = -89.62, A_LON = -30, B_LAT = -89.70, B_LON = 0;

  private SimulationUtility util;
  private MissionModel<?> model;
  private EditablePlan plan;

  @BeforeAll
  void beforeAll() {
    util = new SimulationUtility();
    model = SimulationUtility.instantiateMissionModel(new GeneratedModelType(), START, Configuration.defaultConfiguration());
  }

  @AfterAll
  void afterAll() {
    util.close();
  }

  @BeforeEach
  void beforeEach() {
    plan = new DefaultEditablePlanDriver(new TypeUtilsEditablePlanAdapter(new TypeUtilsPlanAdapter(
        new Plan("MoonFall test", new Timestamp(START), new Timestamp(START.plusSeconds(86400)), Map.of(), Map.of())), util, model));
  }

  ActivityDirectiveId hop(String drone, Duration at, double lat, double lon) {
    return plan.create("PerformHop", new DirectiveStart.Absolute(at), Map.of(
        "drone", SerializedValue.of(drone), "destinationLatitude", SerializedValue.of(lat), "destinationLongitude", SerializedValue.of(lon),
        "profile", SerializedValue.of("MIN_PROPELLANT")));
  }

  static Instance<AnyInstance> instance(SimulationResults sim, ActivityDirectiveId id) {
    return sim.instances("PerformHop").collect().stream().filter(i -> id.equals(i.directiveId)).findFirst().orElseThrow();
  }

  static String attr(SimulationResults sim, ActivityDirectiveId id, String key) {
    return Sim.result(sim, id).get(key).asString().orElseThrow();
  }

  static double num(SimulationResults sim, ActivityDirectiveId id, String key) {
    return Sim.result(sim, id).get(key).asReal().orElseThrow();
  }

  /** The hop the solver computes from where the simulation has the drone just before {@code at}. */
  static Hop expected(SimulationResults sim, String drone, Duration at, double lat, double lon) {
    return Sim.evaluate(sim, drone, at.minus(Duration.EPSILON), lat, lon, HopSolver.Profile.MIN_PROPELLANT);
  }

  @Test
  void simulationFliesTheSolvedTrajectory() {
    final ActivityDirectiveId id = hop("Polaris-A", T1, A_LAT, A_LON);
    final SimulationResults sim = plan.simulate();
    final Hop hop = expected(sim, "Polaris-A", T1, A_LAT, A_LON);
    assertTrue(hop.feasible(), hop.reason());
    assertEquals("FEASIBLE", attr(sim, id, "status"));
    assertEquals(hop.trajectoryId(), attr(sim, id, "trajectoryId"));
    assertEquals(MoonTerrain.get().id, attr(sim, id, "terrain"));

    // The activity lasts exactly the flight (to the microsecond the simulation keeps time in).
    final var interval = instance(sim, id).getInterval();
    assertEquals(T1, interval.start);
    assertEquals(Math.round(hop.durationS() * 1e6), interval.end.minus(interval.start).in(Duration.MICROSECONDS));

    // Each published sample is the drone's state from its time until the next.
    for (final HopSolver.State s : hop.samples()) {
      final Duration t = T1.plus(Duration.of(Math.round(s.t() * 1e6), Duration.MICROSECONDS));
      final DroneState d = Sim.drone(sim, "Polaris-A", t);
      assertArrayEquals(new double[] {s.r()[0] / 1000, s.r()[1] / 1000, s.r()[2] / 1000}, new double[] {d.xKm(), d.yKm(), d.zKm()}, 0);
      assertArrayEquals(s.q(), d.attitude(), 0);
      assertEquals(s.phase().name(), d.phase());
      assertEquals(s.massKg() - Sim.vehicle(sim).dryMassKg(), Sim.real(sim, "Polaris-A.propellantKg", t), 0);
    }

    // Not at the landing site before touchdown; there after it, with the propellant the solver burned.
    final Duration justBefore = T1.plus(Duration.of(Math.round(hop.durationS() * 1e6) - 1, Duration.MICROSECONDS));
    assertNotEquals("LANDED", Sim.drone(sim, "Polaris-A", justBefore).phase());
    assertTrue(Vec.norm(Vec.sub(Sim.drone(sim, "Polaris-A", justBefore).positionM(), hop.landing())) > 0.01);
    final Duration after = T1.plus(Duration.of(1, Duration.HOUR));
    final DroneState landed = Sim.drone(sim, "Polaris-A", after);
    assertEquals("LANDED", landed.phase());
    assertEquals("", landed.trajectoryId());
    assertTrue(Vec.norm(Vec.sub(landed.positionM(), hop.landing())) < 1e-6);
    assertEquals(40 - hop.propellantKg(), Sim.real(sim, "Polaris-A.propellantKg", after), 1e-9);
    assertEquals(A_LAT, Sim.real(sim, "Polaris-A.latitude", after), 1e-9);

    // Sky resources: SPICE (LunarSky) at the drone's position, refreshed every Mission.SKY_STEP; after landing the
    // landing site's.
    final Duration skyAt = after; // a multiple of SKY_STEP: the value held from there
    final Duration read = after.plus(Duration.of(1, Duration.MINUTE));
    final java.time.Instant skyUtc = START.plus(java.time.Duration.of(skyAt.in(Duration.MICROSECONDS), java.time.temporal.ChronoUnit.MICROS));
    final double[] site = hop.landing();
    assertEquals(LunarSky.elevationDeg(site, LunarSky.direction("SUN", skyUtc, site)), Sim.real(sim, "Polaris-A.sunElevationDeg", read), 1e-9);
    assertEquals(LunarSky.elevationDeg(site, LunarSky.direction("EARTH", skyUtc, site)), Sim.real(sim, "Polaris-A.earthElevationDeg", read), 1e-9);
  }

  @Test
  void editingTheDestinationReplacesTheTrajectory() {
    final ActivityDirectiveId id = hop("Polaris-A", T1, A_LAT, A_LON);
    final SimulationResults simA = plan.simulate();
    final String trajA = attr(simA, id, "trajectoryId");
    final double durA = num(simA, id, "durationS"), propA = num(simA, id, "propellantKg");

    // The operator changes the destination: the same directive, re-simulated.
    plan.delete(id);
    final ActivityDirectiveId idB = hop("Polaris-A", T1, B_LAT, B_LON);
    final SimulationResults simB = plan.simulate();
    final String trajB = attr(simB, idB, "trajectoryId");
    assertNotEquals(trajA, trajB);
    assertTrue(num(simB, idB, "durationS") > durA + 30, "longer flight");
    assertTrue(num(simB, idB, "propellantKg") > propA + 2, "more propellant");
    assertEquals(B_LAT, Sim.real(simB, "Polaris-A.latitude", T1.plus(Duration.of(1, Duration.HOUR))), 1e-9);
    // Nothing of trajectory A is left in the new simulation.
    for (double s = 0; s < 400; s += 0.5) {
      assertNotEquals(trajA, Sim.drone(simB, "Polaris-A", T1.plus(Duration.of(Math.round(s * 1e6), Duration.MICROSECONDS))).trajectoryId());
    }
  }

  @Test
  void anInfeasibleHopDoesNotMoveTheDrone() {
    final ActivityDirectiveId id = hop("Polaris-A", T1, -89.45, -60); // 15.8° slope at the site
    final SimulationResults sim = plan.simulate();
    assertEquals("LANDING_SLOPE", attr(sim, id, "status"));
    assertFalse(attr(sim, id, "reason").isBlank());
    final var interval = instance(sim, id).getInterval();
    assertEquals(interval.start, interval.end);
    final Duration after = T1.plus(Duration.of(1, Duration.HOUR));
    assertEquals(-89.55, Sim.real(sim, "Polaris-A.latitude", after), 1e-9);
    assertEquals(40, Sim.real(sim, "Polaris-A.propellantKg", after), 0);
    assertEquals("LANDED", Sim.drone(sim, "Polaris-A", T1.plus(Duration.of(30, Duration.SECONDS))).phase());
  }

  @Test
  void theNextHopStartsWhereTheLastLanded() {
    final ActivityDirectiveId first = hop("Polaris-A", T1, A_LAT, A_LON);
    final Duration t2 = T1.plus(Duration.of(3, Duration.HOUR));
    final ActivityDirectiveId second = hop("Polaris-A", t2, B_LAT, B_LON);
    final SimulationResults sim = plan.simulate();
    assertEquals(A_LAT, num(sim, second, "startLatitude"), 1e-9);
    assertEquals(40 - num(sim, first, "propellantKg"), num(sim, second, "propellantBeforeKg"), 1e-12);
    final Hop fromA = expected(sim, "Polaris-A", t2, B_LAT, B_LON);
    assertEquals(fromA.trajectoryId(), attr(sim, second, "trajectoryId"));
    // And it differs from the same hop flown from the base.
    assertNotEquals(attr(sim, second, "trajectoryId"), expected(sim, "Polaris-A", T1, B_LAT, B_LON).trajectoryId());
  }

  @Test
  void dronesFlyConcurrentlyWithoutDisturbingEachOther() {
    final ActivityDirectiveId a = hop("Polaris-A", T1, A_LAT, A_LON);
    final ActivityDirectiveId c = hop("Polaris-B", T1.plus(Duration.of(20, Duration.SECONDS)), -89.50, 40);
    final SimulationResults both = plan.simulate();
    assertEquals("FEASIBLE", attr(both, c, "status"), attr(both, c, "reason"));
    final String trajA = attr(both, a, "trajectoryId"), trajC = attr(both, c, "trajectoryId");
    assertEquals(expected(both, "Polaris-B", T1.plus(Duration.of(20, Duration.SECONDS)), -89.50, 40).trajectoryId(), trajC);

    plan.delete(c);
    final SimulationResults onlyA = plan.simulate();
    assertEquals(trajA, attr(onlyA, a, "trajectoryId"));
    // Polaris-A's state is identical with and without Polaris-C in the air.
    for (double s = 0; s < 200; s += 0.25) {
      final Duration t = T1.plus(Duration.of(Math.round(s * 1e6), Duration.MICROSECONDS));
      assertEquals(Sim.drone(onlyA, "Polaris-A", t), Sim.drone(both, "Polaris-A", t));
    }
    // While both fly, each carries its own trajectory id.
    final Duration mid = T1.plus(Duration.of(60, Duration.SECONDS));
    assertEquals(trajA, Sim.drone(both, "Polaris-A", mid).trajectoryId());
    assertEquals(trajC, Sim.drone(both, "Polaris-B", mid).trajectoryId());
  }

  @Test
  void aSecondHopWhileFlyingIsRefused() {
    hop("Polaris-A", T1, A_LAT, A_LON);
    final ActivityDirectiveId busy = hop("Polaris-A", T1.plus(Duration.of(30, Duration.SECONDS)), B_LAT, B_LON);
    assertEquals("DRONE_BUSY", attr(plan.simulate(), busy, "status"));
  }

  // --- Imaging ---------------------------------------------------------------------------------------------------

  ActivityDirectiveId image(String drone, Duration at, int frames, String region) {
    return plan.create("AcquireSurveyImages", new DirectiveStart.Absolute(at), Map.of(
        "drone", SerializedValue.of(drone), "frames", SerializedValue.of(frames), "intervalS", SerializedValue.of(2.0),
        "targetName", SerializedValue.of("test area"), "targetRegion", SerializedValue.of(region)));
  }

  static Map<String, SerializedValue> imaging(SimulationResults sim, ActivityDirectiveId id) {
    for (final Instance<AnyInstance> i : sim.instances("AcquireSurveyImages")) {
      if (id.equals(i.directiveId)) return i.inner.computedAttributes.asMap().orElseThrow();
    }
    throw new IllegalStateException("no imaging instance");
  }

  static Duration at(Duration base, double s) {
    return base.plus(Duration.of(Math.round(s * 1e6), Duration.MICROSECONDS));
  }

  @Test
  void imagingInTheCoastSeesTheTerrainBelowTheDrone() {
    hop("Polaris-A", T1, B_LAT, B_LON);
    final Hop h = expected(plan.simulate(), "Polaris-A", T1, B_LAT, B_LON);
    final double start = HopSolver.span(h, HopSolver.Phase.COAST).startS() + 4;
    final ActivityDirectiveId img = image("Polaris-A", at(T1, start), 6, "");
    final SimulationResults sim = plan.simulate();
    final Map<String, SerializedValue> r = imaging(sim, img);
    assertEquals(6, r.get("imagesTaken").asInt().orElseThrow());
    assertEquals(h.trajectoryId(), r.get("trajectoryId").asString().orElseThrow());
    assertEquals(6 * moonfall.Camera.MBIT_PER_IMAGE, Sim.real(sim, "Polaris-A.dataStoredMbit", at(T1, 3600)), 1e-9);
    final List<SerializedValue> frames = r.get("frames").asList().orElseThrow();
    for (int k = 0; k < 6; k++) {
      final Map<String, SerializedValue> f = frames.get(k).asMap().orElseThrow();
      assertEquals("OK", f.get("status").asString().orElseThrow());
      // Nadir camera in coast attitude: the image centre is the terrain under the drone, at its height above it.
      final double[] rDrone = HopSolver.stateAt(h, start + 2 * k)[0];
      assertEquals(Vec.latDeg(rDrone), f.get("centerLatitude").asReal().orElseThrow(), 1e-6);
      assertEquals(MoonTerrain.get().clearanceM(rDrone), f.get("slantRangeM").asReal().orElseThrow(), 0.05);
    }
    assertEquals(6, com.google.gson.JsonParser.parseString(r.get("footprints").asString().orElseThrow()).getAsJsonObject()
        .getAsJsonArray("features").size());
  }

  @Test
  void imagesOutsideTheCoastAreSkippedAndMakeNoData() {
    hop("Polaris-A", T1, B_LAT, B_LON);
    final ActivityDirectiveId img = image("Polaris-A", at(T1, 5), 3, ""); // during the ascent burn
    final ActivityDirectiveId landed = image("Polaris-A", at(T1, 1800), 2, "");
    final SimulationResults sim = plan.simulate();
    assertEquals(0, imaging(sim, img).get("imagesTaken").asInt().orElseThrow());
    assertEquals(0, imaging(sim, landed).get("imagesTaken").asInt().orElseThrow());
    final String reason = imaging(sim, img).get("frames").asList().orElseThrow().get(0).asMap().orElseThrow().get("reason").asString().orElseThrow();
    assertTrue(reason.contains("ASCENT"), reason);
    assertEquals(0, Sim.real(sim, "Polaris-A.dataStoredMbit", at(T1, 3600)), 0);
  }

  @Test
  void changingTheDestinationChangesWhatTheSameImagesCover() {
    // A survey area under the coast toward B.
    hop("Polaris-A", T1, B_LAT, B_LON);
    final Hop hB = expected(plan.simulate(), "Polaris-A", T1, B_LAT, B_LON);
    final double start = HopSolver.span(hB, HopSolver.Phase.COAST).startS() + 20;
    final double[] mid = HopSolver.stateAt(hB, start + 6)[0];
    final String region = square(Vec.latDeg(mid), Vec.lonDeg(mid), 150);
    final ActivityDirectiveId img = image("Polaris-A", at(T1, start), 6, region);
    final double coverB = imaging(plan.simulate(), img).get("geometricCoverage").asReal().orElseThrow();
    assertTrue(coverB > 0.9, "the area under the B coast is covered: " + coverB);

    // Same images, same times; the hop now goes to A.
    plan.delete(plan.simulate().instances("PerformHop").collect().get(0).directiveId);
    hop("Polaris-A", T1, A_LAT, A_LON);
    final Map<String, SerializedValue> rA = imaging(plan.simulate(), img);
    final double coverA = rA.get("geometricCoverage").asReal().orElseThrow();
    assertTrue(coverA < 0.1, "toward A, the area is missed: " + coverA);
    // Usable coverage never exceeds geometric coverage, and both are reported with the camera's stated capability.
    assertTrue(rA.get("usableCoverage").asReal().orElseThrow() <= coverA);
    assertTrue(rA.get("imagingCapability").asString().orElseThrow().contains("no illuminator"));
  }

  /** A square GeoJSON Polygon of half-size {@code halfM} around a point, in the south-polar plane. */
  static String square(double lat, double lon, double halfM) {
    final double[] c = moonfall.Camera.polar(lat, lon);
    final StringBuilder sb = new StringBuilder("{\"type\":\"Polygon\",\"coordinates\":[[");
    final double[][] d = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}, {-1, -1}};
    for (int i = 0; i < d.length; i++) {
      final double x = c[0] + d[i][0] * halfM, y = c[1] + d[i][1] * halfM;
      final double rho = Math.hypot(x, y);
      final double la = 2 * Math.toDegrees(Math.atan(rho / (2 * MoonTerrain.RADIUS_M))) - 90, lo = Math.toDegrees(Math.atan2(y, x));
      sb.append(i > 0 ? "," : "").append("[").append(lo).append(",").append(la).append("]");
    }
    return sb.append("]]}").toString();
  }

  // --- The goal ------------------------------------------------------------------------------------------------

  @Test
  void planHopEvaluatesThenSchedulesTheSameFlight() {
    new PlanHop("Polaris-A", B_LAT, B_LON, "MIN_PROPELLANT", T1, 6, "test", "").run(plan);
    final SimulationResults sim = plan.simulate();
    final List<Instance<AnyInstance>> hops = sim.instances("PerformHop").collect();
    assertEquals(1, hops.size());
    final Hop evaluated = expected(sim, "Polaris-A", T1, B_LAT, B_LON);
    assertEquals(evaluated.trajectoryId(), Sim.result(sim, hops.get(0).directiveId).get("trajectoryId").asString().orElseThrow());
    // The survey it scheduled is anchored in the hop's coast: every image is taken.
    final Instance<AnyInstance> survey = sim.instances("AcquireSurveyImages").collect().get(0);
    assertEquals(6, survey.inner.computedAttributes.asMap().orElseThrow().get("imagesTaken").asInt().orElseThrow());
  }

  @Test
  void planHopRejectsAnInfeasibleHopWithItsReason() {
    final var e = assertThrows(IllegalStateException.class, () -> new PlanHop("Polaris-A", -89.45, -60, "MIN_PROPELLANT", T1, 0, "", "").run(plan));
    assertTrue(e.getMessage().contains("LANDING_SLOPE"), e.getMessage());
    assertTrue(plan.simulate().instances("PerformHop").collect().isEmpty(), "nothing was scheduled");
  }
}
