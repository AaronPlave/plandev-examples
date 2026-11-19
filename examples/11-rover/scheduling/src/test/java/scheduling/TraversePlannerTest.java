package scheduling;

import org.junit.jupiter.api.Test;
import rover.DriveModel;
import rover.Terrain;
import rover.MarsSun;
import scheduling.TraversePlanner.Daylight;
import scheduling.TraversePlanner.Itinerary;
import scheduling.TraversePlanner.Objective;
import scheduling.TraversePlanner.Path;
import scheduling.TraversePlanner.Power;
import scheduling.TraversePlanner.Site;
import scheduling.TraversePlanner.Step;
import scheduling.TraversePlanner.Walker;
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
  private static final long START_MS = java.time.Instant.parse("2027-02-01T00:00:00Z").toEpochMilli();
  /** A big array: the battery is not what these tests are about. */
  private static final Power POWER = new Power(100, 1680, 5000);
  private static final Daylight ANY_TIME = new Daylight(START_MS, false, 10, 2700);
  private static final Daylight DAYLIGHT = new Daylight(START_MS, true, 10, 2700);
  /** The mission's array (6.5 m^2, see rover.Configuration). */
  private static final double ARRAY = rover.DriveModel.arrayZenithW1AU(6.5 * 0.9, 0.28 * 0.9);

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
    final Itinerary it = TraversePlanner.plan(t, far, NONE, Objective.MIN_DISTANCE, 20, new Power(100, 150, 2000), ANY_TIME, 60, 0.005, 0.005, 0, 400_000, 600);
    final List<Step> drives = it.steps().stream().filter(s -> s.type().equals("Drive")).toList();
    assertTrue(drives.size() > 1, "a small battery needs a recharge stop on the ridge");
    for (int i = 1; i < drives.size(); i++) {
      // Each part starts where the last ended, after a wait.
      final double[] end = drives.get(i - 1).waypoints().get(drives.get(i - 1).waypoints().size() - 1);
      assertEquals(end[0], drives.get(i).waypoints().get(0)[0]);
      assertTrue(drives.get(i).startSec() > drives.get(i - 1).startSec() + drives.get(i - 1).durationSec());
    }
    assertTrue(it.steps().stream().anyMatch(s -> s.type().equals("Wait") && s.reason().startsWith("recharge")));
    final List<Step> ample = TraversePlanner.plan(t, far, NONE, Objective.MIN_DISTANCE, 20, POWER, ANY_TIME, 30, 0.005, 0.005, 0, 400_000, 600).steps();
    assertEquals(2, ample.size(), "one Drive and one Observe with a large battery");
  }

  @Test
  void aTightDeadlineKeepsTheMostValuableSites() {
    final Terrain t = grid(1.0);
    final List<Site> sites = List.of(new Site("west-low", "West", 0.005, 0.025, 1), new Site("east-high", "East", 0.005, 0.085, 3));
    final long both = TraversePlanner.plan(t, sites, NONE, Objective.MIN_TIME, 20, POWER, ANY_TIME, 30, 0.005, 0.045, 0, 1_000_000, 600)
        .steps().stream().mapToLong(s -> s.startSec() + s.durationSec()).max().orElseThrow();
    final Itinerary tight = TraversePlanner.plan(t, sites, NONE, Objective.MIN_TIME, 20, POWER, ANY_TIME, 30, 0.005, 0.045, 0, both - 3600, 600);
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
      final Itinerary it = TraversePlanner.plan(t, ScheduleTraverse.missionSites(), NONE, o, 20, new Power(100, 1680, ARRAY), DAYLIGHT, 30, 18.4446, 77.4509, 3600, 6 * 86400, 1800);
      final Step last = it.steps().get(it.steps().size() - 1);
      System.out.printf("%s: %s, %d steps, ends %.1f h, %d waypoints; %s%n", o, it.visited().stream().map(Site::id).toList(), it.steps().size(),
          (last.startSec() + last.durationSec()) / 3600.0, it.steps().stream().mapToInt(s -> s.waypoints().size()).sum(), it.notes());
    }
    System.out.printf("west-rim MIN_DISTANCE: %.1f km, %.1f h, %.0f Wh, max slope %.1f deg, %d waypoints%n", shortest.km(), shortest.seconds() / 3600.0, shortest.driveWh(), shortest.maxSlopeDeg(), shortest.waypoints().size());
    System.out.printf("west-rim MIN_ENERGY:   %.1f km, %.1f h, %.0f Wh, max slope %.1f deg, %d waypoints%n", leastEnergy.km(), leastEnergy.seconds() / 3600.0, leastEnergy.driveWh(), leastEnergy.maxSlopeDeg(), leastEnergy.waypoints().size());
  }

  // ---------- daylight ----------

  private static double sun(long sec, double[] at) {
    return MarsSun.elevationDeg(START_MS + sec * 1000, at[1], at[0]);
  }

  /** Seconds of driving with the Sun below the limit, checked every minute of every Drive at its start point. */
  private static long darkDriving(Itinerary it) {
    long dark = 0;
    for (final Step s : it.steps()) {
      if (!s.type().equals("Drive")) continue;
      for (long t = s.startSec(); t <= s.startSec() + s.durationSec(); t += 60) if (sun(t, s.waypoints().get(0)) < 10) dark += 60;
    }
    return dark;
  }

  private static Itinerary jezero(Daylight d, long endSec) {
    return TraversePlanner.plan(Terrain.get(), ScheduleTraverse.missionSites(), NONE, Objective.MIN_ENERGY, 20, new Power(100, 1680, ARRAY), d, 30, 18.4446, 77.4509, 3600, endSec, 1800);
  }

  @Test
  void daylightDrivesStayInsideTheWindowAndStartWithTheMargin() {
    final Itinerary it = jezero(DAYLIGHT, 6 * 86400);
    assertFalse(it.visited().isEmpty());
    assertEquals(0, darkDriving(it), "no minute of driving with the Sun below 10 deg");
    for (final Step s : it.steps()) {
      if (!s.type().equals("Drive")) continue;
      final double[] a = s.waypoints().get(0), b = s.waypoints().get(s.waypoints().size() - 1);
      assertTrue(sun(s.startSec(), a) >= 10 && sun(s.startSec() + s.durationSec(), b) >= 10, "inside the window at both ends");
      final long close = MarsSun.nextCrossing(START_MS + s.startSec() * 1000, START_MS + (s.startSec() + 100_000) * 1000, a[1], a[0], 10, false, 600_000);
      assertTrue(close - (START_MS + s.startSec() * 1000) >= 2700_000, "at least 45 min of drive window left at the start");
    }
    // The first sol's window is nearly over by the time the traverse may start: the plan waits for the night.
    assertTrue(it.steps().stream().anyMatch(s -> s.type().equals("Wait") && s.reason().startsWith("night")));
  }

  @Test
  void aMultihourDriveIsSplitAcrossSols() {
    final Itinerary it = jezero(DAYLIGHT, 6 * 86400);
    final List<Step> steps = it.steps();
    boolean split = false;
    for (int i = 2; i < steps.size(); i++) {
      if (steps.get(i).type().equals("Drive") && steps.get(i).part() > 1 && steps.get(i - 1).type().equals("Wait") && steps.get(i - 1).reason().contains("night")) split = true;
    }
    assertTrue(split, "a drive continues after a night's wait");
  }

  /** The planner's own state-of-charge estimate after each site's observation, replaying the order it chose. */
  private static List<String> estimatedSocAfterEachSite(Daylight d, long endSec) {
    final List<Site> sites = ScheduleTraverse.missionSites();
    final Itinerary it = jezero(d, endSec);
    final Walker w = new Walker(Terrain.get(), new Power(100, 1680, ARRAY), d, 30, endSec, 1800);
    TraversePlanner.State st = new TraversePlanner.State(3600, 100);
    double[] at = {77.4509, 18.4446};
    final List<String> out = new java.util.ArrayList<>();
    for (final Site s : it.visited()) {
      final TraversePlanner.Visit v = w.visit(st, TraversePlanner.route(Terrain.get(), at[1], at[0], s.lat(), s.lon(), Objective.MIN_ENERGY, 20, NONE), s);
      st = v.end();
      at = new double[] {s.lon(), s.lat()};
      out.add(String.format("%s %.0f", s.id(), st.soc()));
    }
    return out;
  }

  /**
   * The demo plans' policies (96 h from 2027-02-01 00:00 UTC, as in setup-plandev.js). The planner's state of
   * charge is an estimate of the same array model the simulation runs; this pins how far apart they may drift
   * at the end of each observation. Simulated values: integrations/mmgis/scripts/verify-rover.js on plans 78/79.
   */
  @Test
  void thePlannersBatteryEstimateMatchesTheDemoSimulations() {
    final List<String> day = estimatedSocAfterEachSite(DAYLIGHT, 4 * 86400), any = estimatedSocAfterEachSite(ANY_TIME, 4 * 86400);
    System.out.println("planner SOC after each site, DAYLIGHT: " + day + "\n                          ANY_TIME: " + any);
    final String[] simDay = {"delta-front 100", "delta-top 58", "margin-unit 100", "neretva-vallis 56", "west-rim 85"};
    final String[] simAny = {"delta-front 100", "delta-top 98", "margin-unit 100", "neretva-vallis 44", "west-rim 100"};
    for (final var pair : List.of(List.of(day, List.of(simDay)), List.of(any, List.of(simAny)))) {
      assertEquals(pair.get(1).size(), pair.get(0).size(), "same sites in the same order");
      for (int i = 0; i < pair.get(0).size(); i++) {
        final String[] e = pair.get(0).get(i).split(" "), s = pair.get(1).get(i).split(" ");
        assertEquals(s[0], e[0]);
        assertEquals(Double.parseDouble(s[1]), Double.parseDouble(e[1]), 5, "planner estimate within 5 % SOC of the simulation at " + s[0]);
      }
    }
  }

  @Test
  void drivingAtAnyHourDrivesInTheDark() {
    final long end = 4 * 86400;
    final Itinerary any = jezero(ANY_TIME, end), day = jezero(DAYLIGHT, end);
    assertTrue(darkDriving(any) > 3600, "the any-time plan drives for hours with the Sun below 10 deg");
    assertEquals(0, darkDriving(day));
    final int pAny = any.visited().stream().mapToInt(Site::priority).sum(), pDay = day.visited().stream().mapToInt(Site::priority).sum();
    final long fAny = any.steps().get(any.steps().size() - 1).startSec(), fDay = day.steps().get(day.steps().size() - 1).startSec();
    System.out.printf("ANY_TIME: %s priority %d, last step %.1f h, dark driving %.1f h%nDAYLIGHT: %s priority %d, last step %.1f h%n",
        any.visited().stream().map(Site::id).toList(), pAny, fAny / 3600.0, darkDriving(any) / 3600.0, day.visited().stream().map(Site::id).toList(), pDay, fDay / 3600.0);
    // Which plan is better is not asserted: on this rover, night driving runs the battery down and the array
    // has to repay it in daylight, so the any-time plan can finish later. The simulation is the judge.
    assertNotEquals(any.steps().size(), day.steps().size());
  }
}
