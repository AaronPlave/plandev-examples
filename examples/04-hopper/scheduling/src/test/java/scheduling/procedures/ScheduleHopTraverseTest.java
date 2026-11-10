package scheduling.procedures;

import hopper.HopModel;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ScheduleHopTraverseTest {
  private static final String SITES = """
      {"type":"FeatureCollection","features":[
        {"type":"Feature","id":"far","geometry":{"type":"Point","coordinates":[-59.0,7.6]}},
        {"type":"Feature","id":"near","geometry":{"type":"Point","coordinates":[300.95,7.42]}}]}""";

  @Test
  void parsesPointsAndWrapsLongitude() {
    final var sites = ScheduleHopTraverse.parseSites(SITES);
    assertEquals(List.of("far", "near"), sites.stream().map(ScheduleHopTraverse.Site::id).toList());
    assertEquals(-59.05, sites.get(1).lon(), 1e-9);
  }

  @Test
  void orderChangesTheRoute() {
    final var sites = ScheduleHopTraverse.parseSites(SITES);
    assertEquals("far", ScheduleHopTraverse.order(sites, "AS_DRAWN", 7.40, -59.10).get(0).id());
    assertEquals("near", ScheduleHopTraverse.order(sites, "NEAREST_NEXT", 7.40, -59.10).get(0).id());
    assertThrows(IllegalArgumentException.class, () -> ScheduleHopTraverse.order(sites, "RANDOM", 0, 0));
  }

  @Test
  void hopDurationGrowsWithDistance() {
    final double oneDegree = HopModel.distanceKm(0, 0, 0, 1);
    assertEquals(30.32, oneDegree, 0.01); // 2πR/360 for R = 1737.4 km
    assertEquals(60, HopModel.hopSeconds(0));
    assertEquals(60 + 606, HopModel.hopSeconds(oneDegree));
  }
}
