package scheduling.procedures;

import examples.orbiter.Mission;
import examples.orbiter.spice.Spice;
import gov.nasa.ammos.plandev.geometry.directspicecalls.SpiceDirectTimeDependentStateCalculator;
import gov.nasa.ammos.plandev.geometry.spiceinterpolation.Bodies;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

class ScheduleTargetObservationsTest {

  @Test
  void parsesPointsAndPolygonsWithIdsAndWrapsLongitude() {
    var t = ScheduleTargetObservations.parseTargets("""
        {"type":"FeatureCollection","features":[
          {"type":"Feature","id":"a","geometry":{"type":"Point","coordinates":[350,-4.5]}},
          {"type":"Feature","properties":{"id":7},"geometry":{"type":"Polygon","coordinates":[[[10,0],[12,0],[12,2],[10,2],[10,0]]]}},
          {"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]}}]}""");
    assertEquals(3, t.size());
    assertEquals("a", t.get(0).id());
    assertEquals(-10.0, t.get(0).lonDeg(), 1e-9);
    assertEquals("7", t.get(1).id());
    assertEquals(11.0, t.get(1).lonDeg(), 1e-9);
    assertEquals(1.0, t.get(1).latDeg(), 1e-9);
    assertEquals("2", t.get(2).id());
  }

  @Test
  void greatCircleQuarterMeridian() {
    assertEquals(Math.PI / 2 * ScheduleTargetObservations.MARS_MEAN_RADIUS_KM,
        ScheduleTargetObservations.greatCircleKm(0, 0, 90, 0), 1e-6);
  }

  /** The point of the goal: a different target yields a different, nearby pass. */
  @Test
  void closestPassDependsOnTarget() {
    var dir = System.getenv().getOrDefault("SPICE_DIRECTORY", "spice-kernels");
    Spice.initialize(dir + "/latest_meta_kernel.tm");
    var calc = new SpiceDirectTimeDependentStateCalculator(new Bodies(Mission.class).getBodiesMap(), false);
    var start = Instant.parse("2024-01-02T00:00:00Z");
    var end = Instant.parse("2024-01-08T00:00:00Z");
    long step = 30_000_000L;

    var jezero = ScheduleTargetObservations.closestPass(calc, new ScheduleTargetObservations.Target("jezero", 18.4, 77.5), start, end, step);
    var gale = ScheduleTargetObservations.closestPass(calc, new ScheduleTargetObservations.Target("gale", -5.4, 137.8), start, end, step);

    assertNotNull(jezero);
    assertNotNull(gale);
    assertNotEquals(jezero.time(), gale.time());
    // ~89 near-polar orbits in 6 days put a ground track within ~100 km of any mid-latitude point
    assertTrue(jezero.distanceKm() < 100, "jezero " + jezero);
    assertTrue(gale.distanceKm() < 100, "gale " + gale);
    System.out.println(jezero + "\n" + gale);
  }
}
