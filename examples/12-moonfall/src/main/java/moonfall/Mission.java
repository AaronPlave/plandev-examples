package moonfall;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.DoubleValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.IntegerValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.StringValueMapper;
import moonfall.generated.AutoValueMappers;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.Registrar;

import gov.nasa.ammos.plandev.contrib.streamline.core.Resources;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import static gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteResources.discreteResource;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.delay;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.spawn;
import static gov.nasa.ammos.plandev.merlin.framework.ModelActions.threaded;

/**
 * Four fictional MoonFall-like propulsive drones at the lunar south pole. A hop's trajectory is computed by
 * {@link HopSolver} over {@link MoonTerrain}, from the drone's simulated position and propellant when the hop starts;
 * the drone's resources then follow that trajectory sample by sample.
 */
public class Mission {
  public final Instant planStart;
  public final MoonTerrain terrain = MoonTerrain.get();
  public final HopSolver solver = new HopSolver(terrain);
  public final Vehicle vehicle;
  public final Map<String, Drone> drones = new LinkedHashMap<>();

  public Mission(final gov.nasa.ammos.plandev.merlin.framework.Registrar registrar, final Instant planStart, final Configuration config) {
    final var reg = new Registrar(registrar, Registrar.ErrorBehavior.Log);
    this.planStart = planStart;
    this.vehicle = config.vehicle();
    for (final DroneStart d : config.drones()) {
      final double[] site = terrain.surfacePoint(Vec.direction(d.latitude(), d.longitude()));
      if (site == null) throw new IllegalArgumentException(d.name() + " starts outside the terrain pack");
      final double[] n = terrain.normal(site, vehicle.landingSlopeBaselineM());
      // Landed attitude: +Z along the terrain normal, +X toward grid north (toward the pole's 0° meridian).
      final double[] q = HopSolver.landedAttitude(n != null ? n : Vec.unit(site), Vec.of(1, 0, 0));
      final Drone drone = new Drone(d.name(), site, q, d.propellantKg(), terrain);
      drone.register(reg);
      drones.put(d.name(), drone);
    }
    // The vehicle, terrain and solver this simulation flew with; goals evaluate hops with the same ones.
    final var d = new DoubleValueMapper();
    reg.discrete("mission.vehicle", discreteResource(vehicle),
        AutoValueMappers.moonfall_Vehicle(d, d, d, d, d, d, d, d, d, d, d, d, d, d, new IntegerValueMapper(), d, d, d));
    reg.discrete("mission.terrain", discreteResource(terrain.id), new StringValueMapper());
    reg.discrete("mission.hopSolver", discreteResource(HopSolver.VERSION), new StringValueMapper());
    LunarSky.ensureKernels();
    spawn(threaded(this::trackSky));
  }

  /** Sky resources step: the Sun's elevation at the pole changes by well under 0.1° in it. */
  public static final Duration SKY_STEP = Duration.of(10, Duration.MINUTES);

  // ponytail: fixed 10-min step, so a drone's sky values lag a landing by up to that; sample on Drone.set if a
  // goal ever needs the exact value at touchdown.
  private void trackSky() {
    while (true) {
      final Instant now = planStart.plusMillis(Resources.currentTime().in(Duration.MILLISECONDS));
      for (final Drone d : drones.values()) d.updateSky(now, terrain);
      delay(SKY_STEP);
    }
  }

  public Drone drone(String name) {
    final Drone d = drones.get(name);
    if (d == null) throw new IllegalArgumentException("unknown drone " + name + "; drones are " + drones.keySet());
    return d;
  }
}
