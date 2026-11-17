package rover;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.BooleanValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.DoubleValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.EnumValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.StringValueMapper;
import gov.nasa.ammos.plandev.contrib.streamline.core.MutableResource;
import gov.nasa.ammos.plandev.contrib.streamline.core.Resource;
import gov.nasa.ammos.plandev.contrib.streamline.core.Resources;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.Registrar;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.Discrete;
import gov.nasa.ammos.plandev.data.Data;
import gov.nasa.ammos.plandev.data.DataMissionModel;
import gov.nasa.ammos.plandev.power.BatteryModel;
import gov.nasa.ammos.plandev.power.GenericSolarArray;
import gov.nasa.ammos.plandev.power.PowerSource;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;

import java.time.Instant;
import java.util.Optional;

import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentValue;
import static gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteResources.add;
import static gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteResources.discreteResource;
import static gov.nasa.ammos.plandev.contrib.streamline.modeling.polynomial.PolynomialResources.asPolynomial;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.delay;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.spawn;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.threaded;

/**
 * A Mars rover that drives over real Jezero-crater slopes: location, drive energy from terrain slope
 * ({@link DriveModel}, {@link Terrain}), the Sun in the rover's sky ({@link MarsSun}), battery and a
 * horizontal solar array (power library), and science data storage (data library).
 *
 * <p>Sunlight is geometric: the array's output follows the Sun's elevation above the local horizontal,
 * and is zero with the Sun below it. No atmosphere, dust, terrain horizon or shadowing. The drive
 * window ({@code rover.driveWindowOpen}) is a flight rule on that geometric elevation; the model does
 * not enforce it ({@code DriveDaylight} reports driving outside it), as with the slope limit.
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

  // The Sun at the rover (MarsSun), updated every SUN_STEP and exactly when it crosses the drive limit.
  public static final Duration SUN_STEP = Duration.of(10, Duration.MINUTES);
  public final MutableResource<Discrete<Double>> sunElevationDeg = discreteResource(0.0);
  public final MutableResource<Discrete<Double>> localSolarTimeHours = discreteResource(0.0);
  public final MutableResource<Discrete<Boolean>> driveWindowOpen = discreteResource(false);
  private final MutableResource<Discrete<Double>> solarDistanceAu = discreteResource(1.52);
  private final MutableResource<Discrete<Double>> sunZenithDeg = discreteResource(90.0);
  private final MutableResource<Discrete<Double>> sunlit = discreteResource(0.0);
  public final double driveMinSunElevationDeg;
  private final Instant planStart;

  public Mission(final gov.nasa.ammos.plandev.merlin.framework.Registrar registrar,
                 final Instant planStart,
                 final Configuration config) {
    final var reg = new Registrar(registrar, Registrar.ErrorBehavior.Log);
    final var dvm = new DoubleValueMapper();

    this.planStart = planStart;
    this.driveMinSunElevationDeg = config.driveMinSunElevationDeg();
    this.totalLoad = add(discreteResource(DriveModel.IDLE_W), driveLoad, instrumentLoad, telecomLoad);
    // A horizontal array: the array-to-Sun angle is the solar zenith angle; no output with the Sun down.
    this.powerSource = new GenericSolarArray(config.powerConfig().powerSourceConfig(), solarDistanceAu, sunZenithDeg, sunlit);
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

    reg.discrete("rover.sunElevationDeg", sunElevationDeg, dvm);
    reg.discrete("rover.localSolarTimeHours", localSolarTimeHours, dvm);
    reg.discrete("rover.driveWindowOpen", driveWindowOpen, new BooleanValueMapper());
    // Published so the scheduling goal plans with the mission's limits and array, not copies of them.
    reg.discrete("rover.driveMinSunElevationDeg", discreteResource(config.driveMinSunElevationDeg()), dvm);
    reg.discrete("rover.driveDaylightMarginMin", discreteResource(config.driveDaylightMarginMin()), dvm);
    final var array = config.powerConfig().powerSourceConfig();
    reg.discrete("rover.arrayZenithW1AU", discreteResource(DriveModel.arrayZenithW1AU(
        array.arrayMechArea() * array.packingFactor(), array.cellEfficiency() * array.conversionEfficiency() * array.otherLosses())), dvm);
    spawn(threaded(this::trackSun));
  }

  /** UTC milliseconds now. */
  public long nowMs() {
    return planStart.toEpochMilli() + Resources.currentTime().in(Duration.MILLISECONDS);
  }

  private void trackSun() {
    while (true) {
      final long now = nowMs();
      final double lat = currentValue(latitude), lon = currentValue(longitude);
      final MarsSun.Sky sky = MarsSun.sky(now);
      final double e = MarsSun.elevationDeg(sky, lat, lon);
      final boolean open = e >= driveMinSunElevationDeg;
      DiscreteEffects.set(sunElevationDeg, e);
      DiscreteEffects.set(localSolarTimeHours, MarsSun.localTrueSolarTimeHours(now, lon));
      DiscreteEffects.set(driveWindowOpen, open);
      DiscreteEffects.set(solarDistanceAu, sky.au());
      DiscreteEffects.set(sunZenithDeg, 90 - e);
      DiscreteEffects.set(sunlit, e > 0 ? 1.0 : 0.0);
      final long step = SUN_STEP.in(Duration.MILLISECONDS);
      final long flip = MarsSun.nextCrossing(now + 1, now + step, lat, lon, driveMinSunElevationDeg, !open, step);
      delay(Duration.of(Math.min(flip, now + step) - now, Duration.MILLISECONDS));
    }
  }

  @Override
  public Data getData() {
    return data;
  }
}
