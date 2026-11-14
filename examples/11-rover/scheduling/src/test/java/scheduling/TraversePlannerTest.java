package scheduling;

import org.junit.jupiter.api.Test;
import rover.DriveModel;
import rover.Terrain;
import scheduling.TraversePlanner.Itinerary;
import scheduling.TraversePlanner.Objective;
import scheduling.TraversePlanner.Path;
import scheduling.TraversePlanner.Power;
import scheduling.TraversePlanner.Site;
import scheduling.TraversePlanner.Step;
import scheduling.procedures.ScheduleTraverse;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TraversePlannerTest {
  /** A 9 x 5 grid at the equator, level except where {@code ridge} is: a wall across the middle column, open at the top row. */
  private static Terrain grid(double ridge) {
    final StringBuilder sb = new StringBuilder("ncols 9\nnrows 5\nxllcorner 0\nyllcorner 0\ncellsize 0.01\nNODATA_value -9999\n");
    for (int r = 0; r < 5; r++) {
      for (int c = 0; c < 9; c++) sb.append(c == 4 && r > 0 ? ridge : 1.0).append(' ');
      sb.append('\n');
    }
    return Terrain.parse("test", sb.toString().getBytes(StandardCharsets.US_ASCII));
  }

  private static final List<List<double[]>> NONE = List.of();
  private static final Power POWER = new Power(100, 1680, 200);

  private static Path across(Terrain t, Objective o, double maxSlope, List<List<double[]>> avoid) {
    return TraversePlanner.route(t, 0.005, 0.005, 0.005, 0.085, o, maxSlope, avoid);
  }

  @Test
  void theTerrainDataDecidesTheRoute() {
    final Path flat = across(grid(1.0), Objective.MIN_ENERGY, 20, NONE);
    final Path overRidge = across(grid(18.0), Objective.MIN_DISTANCE, 20, NONE);
    final Path aroundRidge = across(grid(18.0), Objective.MIN_ENERGY, 20, NONE);
    assertEquals(flat.km(), overRidge.km(), 1e-9, "the shortest route ignores a passable slope");
    assertEquals(18.0, overRidge.maxSlopeDeg());
    assertTrue(aroundRidge.km() > overRidge.km(), "the least-energy route is longer");
    assertTrue(aroundRidge.driveWh() < overRidge.driveWh(), "and takes less energy");
    assertEquals(1.0, aroundRidge.maxSlopeDeg());
    // The same objective on different data gives a different route.
    assertNotEquals(flat.km(), aroundRidge.km());
  }

  @Test
  void slopeLimitAndAvoidedRegionsAreImpassable() {
    final Path forced = across(grid(25.0), Objective.MIN_DISTANCE, 20, NONE);
    assertEquals(1.0, forced.maxSlopeDeg(), "a ridge above the limit must be driven around");
    // Close the gap at the top of the ridge as well: no route is left.
    final List<List<double[]>> gap = List.of(List.of(new double[] {0.035, 0.035}, new double[] {0.055, 0.035}, new double[] {0.055, 0.06}, new double[] {0.035, 0.06}));
    assertNull(across(grid(25.0), Objective.MIN_DISTANCE, 20, gap));
    assertNotNull(across(grid(12.0), Objective.MIN_DISTANCE, 20, gap));
  }

  @Test
  void routesStartAndEndAtTheExactPointsAndMatchTheDriveModel() {
    final Terrain t = grid(1.0);
    final Path p = TraversePlanner.route(t, 0.0123, 0.0049, 0.0317, 0.0871, Objective.MIN_TIME, 20, NONE);
    assertEquals(0.0049, p.waypoints().get(0)[0], 1e-9);
    assertEquals(0.0317, p.waypoints().get(p.waypoints().size() - 1)[1], 1e-9);
    long seconds = 0;
    for (int i = 1; i < p.waypoints().size(); i++) {
      final double[] a = p.waypoints().get(i - 1), b = p.waypoints().get(i);
      seconds += DriveModel.legSeconds(DriveModel.distanceKm(a[1], a[0], b[1], b[0]), 1.0);
    }
    assertEquals(seconds, p.seconds());
  }

  @Test
  void drivesAreSplitToRechargeAboveTheReserve() {
    final Terrain t = grid(12.0);
    final List<Site> far = List.of(new Site("far", "Far", 0.005, 0.085, 1));
    final Itinerary it = TraversePlanner.plan(t, far, NONE, Objective.MIN_DISTANCE, 20, new Power(100, 150, 200), 60, 0.005, 0.005, 0, 400_000, 600);
    final List<Step> drives = it.steps().stream().filter(s -> s.type().equals("Drive")).toList();
    assertTrue(drives.size() > 1, "a small battery needs a recharge stop on the ridge");
    for (int i = 1; i < drives.size(); i++) {
      // Each part starts where the last ended, after a wait.
      final double[] end = drives.get(i - 1).waypoints().get(drives.get(i - 1).waypoints().size() - 1);
      assertEquals(end[0], drives.get(i).waypoints().get(0)[0]);
      assertTrue(drives.get(i).startSec() > drives.get(i - 1).startSec() + drives.get(i - 1).durationSec());
    }
    final List<Step> ample = TraversePlanner.plan(t, far, NONE, Objective.MIN_DISTANCE, 20, POWER, 30, 0.005, 0.005, 0, 400_000, 600).steps();
    assertEquals(2, ample.size(), "one Drive and one Observe with a large battery");
  }

  @Test
  void aTightDeadlineKeepsTheMostValuableSites() {
    final Terrain t = grid(1.0);
    final List<Site> sites = List.of(new Site("west-low", "West", 0.005, 0.025, 1), new Site("east-high", "East", 0.005, 0.085, 3));
    final long both = TraversePlanner.plan(t, sites, NONE, Objective.MIN_TIME, 20, POWER, 30, 0.005, 0.045, 0, 1_000_000, 600)
        .steps().stream().mapToLong(s -> s.startSec() + s.durationSec()).max().orElseThrow();
    final Itinerary tight = TraversePlanner.plan(t, sites, NONE, Objective.MIN_TIME, 20, POWER, 30, 0.005, 0.045, 0, both - 3600, 600);
    assertEquals(List.of("east-high"), tight.visited().stream().map(Site::id).toList());
    assertFalse(tight.notes().isEmpty());
  }

  @Test
  void theShippedTerrainSeparatesTheObjectivesForTheMissionSites() {
    final Terrain t = Terrain.get();
    assertTrue(t.id.startsWith(Terrain.DATASET + "@"));
    final Site rim = ScheduleTraverse.missionSites().stream().filter(s -> s.id().equals("west-rim")).findFirst().orElseThrow();
    final Path shortest = TraversePlanner.route(t, 18.4446, 77.4509, rim.lat(), rim.lon(), Objective.MIN_DISTANCE, 20, NONE);
    final Path leastEnergy = TraversePlanner.route(t, 18.4446, 77.4509, rim.lat(), rim.lon(), Objective.MIN_ENERGY, 20, NONE);
    assertTrue(shortest.km() < leastEnergy.km());
    assertTrue(shortest.driveWh() > leastEnergy.driveWh());
    for (final Objective o : Objective.values()) {
      final Itinerary it = TraversePlanner.plan(t, ScheduleTraverse.missionSites(), NONE, o, 20, new Power(100, 1680, 254), 30, 18.4446, 77.4509, 3600, 6 * 86400, 1800);
      final Step last = it.steps().get(it.steps().size() - 1);
      System.out.printf("%s: %s, %d steps, ends %.1f h, %d waypoints; %s%n", o, it.visited().stream().map(Site::id).toList(), it.steps().size(),
          (last.startSec() + last.durationSec()) / 3600.0, it.steps().stream().mapToInt(s -> s.waypoints().size()).sum(), it.notes());
    }
    System.out.printf("west-rim MIN_DISTANCE: %.1f km, %.1f h, %.0f Wh, max slope %.1f deg, %d waypoints%n", shortest.km(), shortest.seconds() / 3600.0, shortest.driveWh(), shortest.maxSlopeDeg(), shortest.waypoints().size());
    System.out.printf("west-rim MIN_ENERGY:   %.1f km, %.1f h, %.0f Wh, max slope %.1f deg, %d waypoints%n", leastEnergy.km(), leastEnergy.seconds() / 3600.0, leastEnergy.driveWh(), leastEnergy.maxSlopeDeg(), leastEnergy.waypoints().size());
  }
}
