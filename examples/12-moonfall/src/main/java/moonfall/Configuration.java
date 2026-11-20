package moonfall;

import java.util.List;

import static gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Template;

/**
 * @param vehicle the drones' (fictional) vehicle parameters, shared by all four
 * @param drones each drone's site and propellant at plan start
 */
public record Configuration(Vehicle vehicle, List<DroneStart> drones) {
  public static @Template Configuration defaultConfiguration() {
    // The bases of the four drones in Cosmolabe's MoonFall scene (scripts/moonfall-schedule.mjs); full tanks.
    return new Configuration(Vehicle.defaults(), List.of(
        new DroneStart("Polaris-A", -89.55, -45, 40),
        new DroneStart("Polaris-B", -89.40, 30, 40),
        new DroneStart("Polaris-C", -89.78, 90, 40),
        new DroneStart("Polaris-D", -89.50, -135, 40)));
  }
}
