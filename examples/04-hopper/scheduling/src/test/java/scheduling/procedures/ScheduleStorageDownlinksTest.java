package scheduling.procedures;

import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.procedural.timeline.Interval;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ScheduleStorageDownlinksTest {
  private static Duration h(long hours) { return Duration.of(hours, Duration.HOURS); }

  // Windows 02:00, 06:00, 10:00, … one hour each, plan 24 h long.
  private static Duration latest(List<Interval> busy, Duration before) {
    return ScheduleStorageDownlinks.latestFreeWindow(h(2), h(4), h(1), h(24), busy, before);
  }

  @Test
  void picksTheLatestWindowBeforeTheOverflow() {
    assertEquals(h(6), latest(List.of(), h(7)));
    assertEquals(h(2), latest(List.of(), h(5)));
    assertNull(latest(List.of(), h(2))); // a window must start before the overflow
  }

  @Test
  void skipsWindowsWithAPassAlready() {
    final var handPlaced = Interval.between(h(6), h(7));
    assertEquals(h(2), latest(List.of(handPlaced), h(8)));
    assertNull(latest(List.of(handPlaced, Interval.between(Duration.of(150, Duration.MINUTES), h(3))), h(8)));
  }

  @Test
  void ignoresWindowsThatRunPastThePlanEnd() {
    assertEquals(h(22), latest(List.of(), h(30)));
    assertEquals(h(18), ScheduleStorageDownlinks.latestFreeWindow(h(2), h(4), h(1), Duration.of(1350, Duration.MINUTES), List.of(), h(30)));
  }
}
