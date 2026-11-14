package rover.activities;

import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType;
import gov.nasa.ammos.plandev.merlin.framework.annotations.ActivityType.EffectModel;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Export.Parameter;
import gov.nasa.ammos.plandev.merlin.framework.annotations.Subsystem;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import rover.DriveModel;
import rover.Mission;
import rover.Mission.DriveStatus;

import java.util.List;

import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentValue;

/**
 * Drive along a planned route.
 *
 * <p>{@code waypoints} is the planned route: [longitude, latitude] pairs in degrees (planetocentric,
 * east-positive), the first being where the drive starts. The rover drives each leg at the speed and
 * power {@link DriveModel} gives for the terrain slope at the leg's end, and its simulated location
 * changes on arrival at each waypoint.
 *
 * <p>The simulation can leave the planned route. If the rover is not at the first waypoint, it does
 * not move ({@code OFF_ROUTE}). If the battery falls below {@link DriveModel#HALT_SOC}, it stops at
 * the waypoint it has reached ({@code HALTED_LOW_BATTERY}).
 */
@ActivityType("Drive")
@Subsystem("mobility")
public class Drive {

  /** Site this drive is heading for; informational. */
  @Parameter
  public String toSiteId = "";

  @Parameter
  public List<List<Double>> waypoints = List.of();

  /** The terrain dataset the route was planned on ({@code Terrain.id}); informational. */
  @Parameter
  public String terrain = "";

  /** What the route was planned to minimize; informational. */
  @Parameter
  public String objective = "";

  /** Engineering telemetry written to storage while driving. */
  @Parameter
  public double dataRateBps = 2e4;

  @Parameter
  public int bin = 0;

  @EffectModel
  public void run(Mission model) {
    if (waypoints.size() < 2) return;
    final List<Double> first = waypoints.get(0);
    if (DriveModel.distanceKm(currentValue(model.latitude), currentValue(model.longitude), first.get(1), first.get(0))
        > DriveModel.ON_ROUTE_TOLERANCE_KM) {
      DiscreteEffects.set(model.driveStatus, DriveStatus.OFF_ROUTE);
      return;
    }
    DiscreteEffects.set(model.driveStatus, DriveStatus.DRIVING);
    DriveStatus end = DriveStatus.IDLE;
    for (int i = 1; i < waypoints.size(); i++) {
      if (currentValue(model.battery.batterySOC) < DriveModel.HALT_SOC) {
        end = DriveStatus.HALTED_LOW_BATTERY;
        break;
      }
      final double lat = waypoints.get(i).get(1), lon = waypoints.get(i).get(0);
      final double km = DriveModel.distanceKm(currentValue(model.latitude), currentValue(model.longitude), lat, lon);
      final double slope = DriveModel.legSlopeDeg(model.terrain, lat, lon);
      DiscreteEffects.set(model.slopeDeg, slope);
      DiscreteEffects.set(model.driveLoad, DriveModel.drivePowerW(slope));
      // receive() blocks for the leg's duration while telemetry accumulates.
      model.data.getOnboardBin(bin).receive(dataRateBps, Duration.of(DriveModel.legSeconds(km, slope), Duration.SECONDS));
      DiscreteEffects.set(model.latitude, lat);
      DiscreteEffects.set(model.longitude, lon);
      DiscreteEffects.set(model.odometerKm, currentValue(model.odometerKm) + km);
    }
    DiscreteEffects.set(model.driveLoad, 0.0);
    DiscreteEffects.set(model.slopeDeg, 0.0);
    DiscreteEffects.set(model.driveStatus, end);
  }
}
