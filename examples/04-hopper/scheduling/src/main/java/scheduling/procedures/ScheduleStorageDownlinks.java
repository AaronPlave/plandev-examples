package scheduling.procedures;

import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.merlin.protocol.types.SerializedValue;
import gov.nasa.ammos.plandev.procedural.scheduling.ActivityAutoDelete;
import gov.nasa.ammos.plandev.procedural.scheduling.Goal;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.SchedulingProcedure;
import gov.nasa.ammos.plandev.procedural.scheduling.annotations.WithDefaults;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.DeletedAnchorStrategy;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.EditablePlan;
import gov.nasa.ammos.plandev.procedural.scheduling.plan.NewDirective;
import gov.nasa.ammos.plandev.procedural.timeline.Interval;
import gov.nasa.ammos.plandev.procedural.timeline.collections.profiles.Real;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.AnyDirective;
import gov.nasa.ammos.plandev.procedural.timeline.payloads.activities.DirectiveStart;
import gov.nasa.ammos.plandev.procedural.timeline.plan.Plan;
import gov.nasa.ammos.plandev.procedural.timeline.plan.SimulationResults;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Adds {@code Downlink} passes so onboard storage stays below {@code maxFraction} of capacity.
 *
 * <p>Works from the simulated {@code onboard.volume}, so it responds to whatever the plan holds when it
 * runs: the traverse goal's images (it should run after that goal), hand-placed passes, other goals' output.
 * Repeatedly: simulate, find the first time storage exceeds the limit, and put a pass in the latest free
 * contact window that starts before then. Stops when storage stays below the limit, when no free window
 * precedes the overflow (the plan keeps the overflow, which {@code OnboardStorageFull} reports), or after
 * {@code maxPasses} passes.
 *
 * <p>Contact windows are an explicit, illustrative assumption, not geometry: one {@code contactLength}
 * window every {@code contactPeriod}, the first at {@code firstContact} after plan start. A pass fills its
 * window. Existing {@code Downlink}s (hand-placed or not) occupy their windows; passes never overlap,
 * because the data model allows one playback at a time.
 */
@SchedulingProcedure
public record ScheduleStorageDownlinks(
    double maxFraction,
    Duration firstContact,
    Duration contactPeriod,
    Duration contactLength,
    int maxPasses) implements Goal {

  @WithDefaults
  public static final class Defaults {
    public static double maxFraction = 0.9;
    public static Duration firstContact = Duration.of(2, Duration.HOURS);
    public static Duration contactPeriod = Duration.of(4, Duration.HOURS);
    public static Duration contactLength = Duration.of(1, Duration.HOUR);
    public static int maxPasses = 6;
  }

  @NotNull
  @Override
  public ActivityAutoDelete shouldDeletePastCreations(@NotNull Plan plan, @Nullable SimulationResults simResults) {
    return new ActivityAutoDelete.AtBeginning(DeletedAnchorStrategy.Cascade, false);
  }

  @Override
  public void run(EditablePlan plan) {
    final Duration end = plan.totalBounds().end;
    for (int added = 0; ; ) {
      final SimulationResults sim = plan.simulate();
      final double capacity = sim.resource("onboard.maxVolume", Real.deserializer()).sample(Duration.ZERO);
      final List<Interval> over = sim.resource("onboard.volume", Real.deserializer())
          .greaterThan(maxFraction * capacity).highlightTrue().collect();
      if (over.isEmpty()) break;
      final Duration overflow = over.get(0).start;
      if (added == maxPasses) {
        System.out.printf("[ScheduleStorageDownlinks] storage still above %.0f%% at %s after %d passes (maxPasses)%n", 100 * maxFraction, overflow, added);
        break;
      }
      final List<Interval> busy = sim.instances("Downlink").collect().stream().map(i -> i.getInterval()).toList();
      final Duration window = latestFreeWindow(firstContact, contactPeriod, contactLength, end, busy, overflow);
      if (window == null) {
        System.out.printf("[ScheduleStorageDownlinks] storage exceeds %.0f%% at %s and no free contact window precedes it%n", 100 * maxFraction, overflow);
        break;
      }
      plan.create(new NewDirective(
          new AnyDirective(Map.of("duration", SerializedValue.of(contactLength.in(Duration.MICROSECONDS)))),
          "Storage downlink",
          "Downlink",
          new DirectiveStart.Absolute(window)));
      plan.commit();
      added++;
      System.out.printf("[ScheduleStorageDownlinks] storage exceeds %.0f%% at %s: pass at %s%n", 100 * maxFraction, overflow, window);
    }
  }

  /** Start of the latest contact window that starts before {@code before}, ends by {@code end} and overlaps no busy interval; null if none. */
  static Duration latestFreeWindow(Duration first, Duration period, Duration length, Duration end, List<Interval> busy, Duration before) {
    final List<Duration> starts = new ArrayList<>();
    for (Duration s = first; !s.plus(length).longerThan(end) && s.shorterThan(before); s = s.plus(period)) starts.add(s);
    for (int i = starts.size() - 1; i >= 0; i--) {
      final Duration s = starts.get(i);
      final Duration e = s.plus(length);
      if (busy.stream().noneMatch(b -> b.start.shorterThan(e) && s.shorterThan(b.end))) return s;
    }
    return null;
  }
}
