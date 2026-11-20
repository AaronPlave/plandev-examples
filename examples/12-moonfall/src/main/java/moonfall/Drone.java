package moonfall;

import gov.nasa.ammos.plandev.contrib.serialization.mappers.BooleanValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.DoubleValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.IntegerValueMapper;
import gov.nasa.ammos.plandev.merlin.protocol.types.Duration;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.EnumValueMapper;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.StringValueMapper;
import gov.nasa.ammos.plandev.contrib.streamline.core.MutableResource;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.Registrar;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.Discrete;
import gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteEffects;
import moonfall.HopSolver.Phase;
import moonfall.generated.AutoValueMappers;

import java.util.Optional;

import static gov.nasa.ammos.plandev.contrib.streamline.core.Resources.currentValue;
import static gov.nasa.ammos.plandev.contrib.streamline.modeling.discrete.DiscreteResources.discreteResource;

/**
 * One drone's simulated state. Resources are named {@code <name>.<resource>}, e.g. {@code Polaris-A.flightPhase}.
 *
 * <ul>
 *   <li>{@code state}: position, velocity, attitude and phase ({@link DroneState}) for the 3D view;</li>
 *   <li>{@code flightPhase}, {@code latitude}, {@code longitude} (planetocentric degrees, MOON_ME_DE421),
 *       {@code heightAboveTerrainM} (radial, above the terrain under the drone), {@code propellantKg}.</li>
 * </ul>
 * All change together at each trajectory sample; they never show the landing site before touchdown.
 */
public final class Drone {
  public final String name;
  public final MutableResource<Discrete<DroneState>> state;
  public final MutableResource<Discrete<Phase>> flightPhase;
  public final MutableResource<Discrete<Double>> latitude;
  public final MutableResource<Discrete<Double>> longitude;
  public final MutableResource<Discrete<Double>> heightAboveTerrainM;
  public final MutableResource<Discrete<Double>> propellantKg;
  public final MutableResource<Discrete<Boolean>> cameraOn = discreteResource(false);
  public final MutableResource<Discrete<Double>> dataStoredMbit = discreteResource(0.0);
  public final MutableResource<Discrete<Integer>> imagesTaken = discreteResource(0);
  /** Sun / Earth elevation above the reference-sphere horizon at the drone, and whether the terrain pack hides them. */
  public final MutableResource<Discrete<Double>> sunElevationDeg = discreteResource(Double.NaN);
  public final MutableResource<Discrete<Double>> earthElevationDeg = discreteResource(Double.NaN);
  public final MutableResource<Discrete<LunarSky.TerrainView>> sunTerrainView = discreteResource(LunarSky.TerrainView.BELOW_HORIZON);
  public final MutableResource<Discrete<LunarSky.TerrainView>> earthTerrainView = discreteResource(LunarSky.TerrainView.BELOW_HORIZON);
  /** The hop being flown and when it started (simulation time), for exact states between published samples. */
  public final MutableResource<Discrete<Optional<Flying>>> flight = discreteResource(Optional.empty());

  public record Flying(HopSolver.Hop hop, Duration start) {}

  Drone(String name, double[] siteM, double[] attitude, double propellantKg, MoonTerrain terrain) {
    this.name = name;
    this.state = discreteResource(DroneState.of(siteM, Vec.of(0, 0, 0), attitude, Phase.LANDED, ""));
    this.flightPhase = discreteResource(Phase.LANDED);
    this.latitude = discreteResource(Vec.latDeg(siteM));
    this.longitude = discreteResource(Vec.lonDeg(siteM));
    this.heightAboveTerrainM = discreteResource(terrain.clearanceM(siteM));
    this.propellantKg = discreteResource(propellantKg);
  }

  void register(Registrar reg) {
    final var dvm = new DoubleValueMapper();
    final var svm = new StringValueMapper();
    reg.discrete(name + ".state", state, AutoValueMappers.moonfall_DroneState(dvm, dvm, dvm, dvm, dvm, dvm, dvm, dvm, dvm, dvm, svm, svm));
    reg.discrete(name + ".flightPhase", flightPhase, new EnumValueMapper<>(Phase.class));
    reg.discrete(name + ".latitude", latitude, dvm);
    reg.discrete(name + ".longitude", longitude, dvm);
    reg.discrete(name + ".heightAboveTerrainM", heightAboveTerrainM, dvm);
    reg.discrete(name + ".propellantKg", propellantKg, dvm);
    reg.discrete(name + ".cameraOn", cameraOn, new BooleanValueMapper());
    reg.discrete(name + ".dataStoredMbit", dataStoredMbit, dvm);
    reg.discrete(name + ".imagesTaken", imagesTaken, new IntegerValueMapper());
    reg.discrete(name + ".sunElevationDeg", sunElevationDeg, dvm);
    reg.discrete(name + ".earthElevationDeg", earthElevationDeg, dvm);
    reg.discrete(name + ".sunTerrainView", sunTerrainView, new EnumValueMapper<>(LunarSky.TerrainView.class));
    reg.discrete(name + ".earthTerrainView", earthTerrainView, new EnumValueMapper<>(LunarSky.TerrainView.class));
  }

  /** Updates the sky resources for the drone's current position at simulation instant {@code t}. */
  void updateSky(java.time.Instant t, MoonTerrain terrain) {
    final double[] r = current().positionM();
    final double[] sun = LunarSky.direction("SUN", t, r), earth = LunarSky.direction("EARTH", t, r);
    DiscreteEffects.set(sunElevationDeg, LunarSky.elevationDeg(r, sun));
    DiscreteEffects.set(earthElevationDeg, LunarSky.elevationDeg(r, earth));
    DiscreteEffects.set(sunTerrainView, LunarSky.terrainBlocked(terrain, r, sun));
    DiscreteEffects.set(earthTerrainView, LunarSky.terrainBlocked(terrain, r, earth));
  }

  public DroneState current() {
    return currentValue(state);
  }

  /** Puts the drone at one trajectory state. */
  public void set(HopSolver.State s, String trajectoryId, double dryMassKg, MoonTerrain terrain) {
    DiscreteEffects.set(state, DroneState.of(s.r(), s.v(), s.q(), s.phase(), s.phase() == Phase.LANDED ? "" : trajectoryId));
    DiscreteEffects.set(flightPhase, s.phase());
    DiscreteEffects.set(latitude, Vec.latDeg(s.r()));
    DiscreteEffects.set(longitude, Vec.lonDeg(s.r()));
    DiscreteEffects.set(heightAboveTerrainM, Math.max(0, terrain.clearanceM(s.r())));
    DiscreteEffects.set(propellantKg, s.massKg() - dryMassKg);
  }
}
