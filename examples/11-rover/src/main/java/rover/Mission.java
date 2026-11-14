package rover;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.DoubleValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.EnumValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.StringValueMapper;
import gov.nasa.ammos.plandev.contrib.streamline.core.MutableResource;
import gov.nasa.ammos.plandev.contrib.streamline.core.Resource;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.Registrar;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.Discrete;
import gov.nasa.ammos.plandev.data.Data;
import gov.nasa.ammos.plandev.data.DataMissionModel;
import gov.nasa.ammos.plandev.power.BatteryModel;
import gov.nasa.ammos.plandev.power.GenericSolarArray;
import gov.nasa.ammos.plandev.power.PowerSource;

import java.time.Instant;
import java.util.Optional;

import static gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteResources.add;
import static gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteResources.discreteResource;
import static gov.nasa.ammos.plandev.contrib.streamline.modeling.polynomial.PolynomialResources.asPolynomial;

/**
 * A Mars rover that drives over real Jezero-crater slopes: location, drive energy from terrain slope
 * ({@link DriveModel}, {@link Terrain}), battery and solar array (power library), and science data
 * storage (data library).
 *
 * <p>Illustrative simplifications: the array produces constant power (no day/night cycle, dust or
 * tilt), and the rover can drive at any time of day.
 */
public class Mission implements DataMissionModel {
  public enum DriveStatus { IDLE, DRIVING, HALTED_LOW_BATTERY, OFF_ROUTE }

  // Power: loads in W, summed into the battery model's demand.
  public final MutableResource<Discrete<Double>> driveLoad = discreteResource(0.0);
  public final MutableResource<Discrete<Double>> instrumentLoad = discreteResource(0.0);
  public final MutableResource<Discrete<Double>> telecomLoad = discreteResource(0.0);
  public final Resource<Discrete<Double>> totalLoad;
  public final PowerSource powerSource;
  public final BatteryModel battery;

  // Data
  public final MutableResource<Discrete<Double>> dataRate;
  public final MutableResource<Discrete<Double>> maxVolume;
  public final Data data;

  // Location: planetocentric latitude / east-positive longitude, degrees, IAU_MARS. It changes each
  // time a Drive reaches one of its waypoints; position between waypoints is not modeled.
  public final MutableResource<Discrete<Double>> latitude;
  public final MutableResource<Discrete<Double>> longitude;
  public final MutableResource<Discrete<Double>> odometerKm = discreteResource(0.0);
  /** Terrain slope of the leg being driven; 0 when not driving. */
  public final MutableResource<Discrete<Double>> slopeDeg = discreteResource(0.0);
  public final MutableResource<Discrete<DriveStatus>> driveStatus = discreteResource(DriveStatus.IDLE);

  public final Terrain terrain = Terrain.get();

  public Mission(final gov.nasa.ammos.plandev.merlin.framework.Registrar registrar,
                 final Instant planStart,
                 final Configuration config) {
    final var reg = new Registrar(registrar, Registrar.ErrorBehavior.Log);
    final var dvm = new DoubleValueMapper();

    this.totalLoad = add(discreteResource(DriveModel.IDLE_W), driveLoad, instrumentLoad, telecomLoad);
    // Mars' mean distance from the Sun, array facing the Sun, never in shadow.
    this.powerSource = new GenericSolarArray(
        config.powerConfig().powerSourceConfig(), discreteResource(1.52), discreteResource(0.0), discreteResource(1.0));
    this.battery = new BatteryModel("mainbattery", config.powerConfig().batteryConfig(),
        totalLoad, powerSource.getPowerProduction());
    powerSource.registerStates(reg);
    battery.registerStates(reg);
    reg.discrete("/pel/driveLoad", driveLoad, dvm);
    reg.discrete("/pel/instrumentLoad", instrumentLoad, dvm);
    reg.discrete("/pel/telecomLoad", telecomLoad, dvm);
    reg.discrete("/pel/totalLoad", totalLoad, dvm);
    // Published so a scheduling goal can plan against the configured battery, not a copy of its size.
    reg.discrete("rover.batteryCapacityWh", discreteResource(battery.batteryCapacityWH), dvm);

    this.dataRate = discreteResource(config.initialDataRate());
    this.maxVolume = discreteResource(config.initialMaxVolume());
    this.data = new Data(Optional.of(asPolynomial(dataRate)), 2, asPolynomial(maxVolume));
    data.registerStates(reg);

    this.latitude = discreteResource(config.startLatitude());
    this.longitude = discreteResource(config.startLongitude());
    reg.discrete("rover.latitude", latitude, dvm);
    reg.discrete("rover.longitude", longitude, dvm);
    reg.discrete("rover.odometerKm", odometerKm, dvm);
    reg.discrete("rover.slopeDeg", slopeDeg, dvm);
    reg.discrete("rover.driveStatus", driveStatus, new EnumValueMapper<>(DriveStatus.class));
    // Which terrain grid this simulation drove on.
    reg.discrete("rover.terrainDataset", discreteResource(terrain.id), new StringValueMapper());
  }

  @Override
  public Data getData() {
    return data;
  }
}
