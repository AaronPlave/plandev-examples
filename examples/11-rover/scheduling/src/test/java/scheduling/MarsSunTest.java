package scheduling;

import org.junit.jupiter.api.Test;
import rover.MarsSun;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MarsSunTest {
  private static final double LAT = 18.4446, LON = 77.4509; // Jezero, planetocentric / east

  private static long ms(String utc) {
    return Instant.parse(utc + "Z").toEpochMilli();
  }

  /**
   * Mars24 against SPICE: solar elevation above the IAU_MARS ellipsoid normal at Jezero, from de440s,
   * mar097 and pck00011 with CN+S (generated with spiceypy; see the rover README).
   */
  @Test
  void elevationMatchesSpice() {
    final Object[][] ref = {
        {"2027-02-01T00:00:00", 37.9658, 1.661025},
        {"2027-02-01T03:00:00", -1.6604, 1.661079},
        {"2027-02-01T06:00:00", -36.3824, 1.661131},
        {"2027-02-01T09:00:00", -49.7633, 1.661174},
        {"2027-02-01T12:00:00", -26.4182, 1.661206},
        {"2027-02-01T15:00:00", 10.6577, 1.66123},
        {"2027-02-01T18:00:00", 50.8636, 1.661255},
        {"2027-02-01T21:00:00", 86.8441, 1.661289},
        {"2021-02-18T20:44:00", 39.4469, 1.571239},
        {"2026-08-10T10:00:00", 10.8099, 1.491788},
        {"2029-05-01T05:30:00", -45.7829, 1.617056},
    };
    double worst = 0;
    for (final Object[] r : ref) {
      final long t = ms((String) r[0]);
      final double e = MarsSun.elevationDeg(t, LAT, LON);
      worst = Math.max(worst, Math.abs(e - (double) r[1]));
      assertEquals((double) r[1], e, 0.01, (String) r[0]);
      assertEquals((double) r[2], MarsSun.sky(t).au(), 1e-3, (String) r[0] + " distance");
    }
    System.out.printf("MarsSun vs SPICE: worst elevation error %.4f deg%n", worst);
  }

  /** The published Mars24 worked example (2000-01-06 00:00 UTC). */
  @Test
  void mars24WorkedExample() {
    final MarsSun.Sky s = MarsSun.sky(ms("2000-01-06T00:00:00"));
    assertEquals(277.18758, s.ls(), 2e-3);
    assertEquals(23.99425, s.mstHours(), 2e-3);
  }

  @Test
  void crossingsBracketTheThreshold() {
    final long from = ms("2027-02-01T00:00:00"), day = 90_000_000L;
    final long set = MarsSun.nextCrossing(from, from + day, LAT, LON, 10, false, 600_000);
    final long rise = MarsSun.nextCrossing(set, set + day, LAT, LON, 10, true, 600_000);
    assertTrue(set > from && rise > set);
    assertEquals(10, MarsSun.elevationDeg(set, LAT, LON), 0.01);
    assertEquals(10, MarsSun.elevationDeg(rise, LAT, LON), 0.01);
    // A sol later the Sun sets again, 24 h 39 min 35 s on (to the scan's precision and the season's drift).
    final long set2 = MarsSun.nextCrossing(rise, rise + day, LAT, LON, 10, false, 600_000);
    assertEquals(88_775_244, set2 - set, 120_000);
  }
}
