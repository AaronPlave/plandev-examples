# 12-moonfall: plan-driven lunar drone hops

Four fictional MoonFall-like propulsive drones (Polaris-A to -D) at the lunar south pole. A hop's trajectory is
**computed by the mission model** from the drone's simulated position and propellant, over real terrain, when the
hop is planned and again when it is simulated. Changing a destination changes the flight, its duration, its
propellant and what its camera sees.

**Nothing here describes JPL's MoonFall vehicles.** The vehicle, engine, guidance and camera are assumptions made
for this demo (public descriptions give roughly 250 kg, 2.1 m across; this drone is 100 kg wet). It is not flight
software or an EDL tool.

| Path | What |
|---|---|
| `src/main/java/moonfall/HopSolver.java` | The hop: dynamics, guidance, candidate search, rejections. Called by the goal and by the simulation. |
| `src/main/java/moonfall/MoonTerrain.java` | Terrain: Cosmolabe's pinned cube-sphere height product, its own tiles in the jar. |
| `src/main/java/moonfall/Camera.java` | The fictional survey camera, footprints on the terrain, area coverage. |
| `src/main/java/moonfall/Vehicle.java` | Vehicle parameters (fictional), part of the model configuration. |
| `src/main/java/moonfall/activities/PerformHop.java` | Flies a hop computed at its start; infeasible hops do not move the drone. |
| `src/main/java/moonfall/activities/AcquireSurveyImages.java` | Images at exact simulated states; skipped outside the coast attitude. |
| `scheduling/.../PlanHop.java` | Goal: evaluate a hop, schedule it only if feasible (optionally with a coast survey), verify the simulation flew the same trajectory. |
| `data/build-terrain-pack.mjs` | Fetches and packs the terrain (not committed: ~21 MB). |
| `data/terrain-reference.mjs` | Reference heights from Cosmolabe's own sampler, for `MoonTerrainTest`. |

## Architecture: who computes the trajectory

```
PlanHop goal ──┐                          ┌── PerformHop effect model (simulation)
  reads drone state from plan.simulate()  │     reads drone state from the simulation
               └──► HopSolver.solve(start, propellant, destination, profile, vehicle) ◄──┘
                      deterministic Java in the mission model jar (also packed into the goal jar)
                      + MoonTerrain (pinned product revision, pack SHA-256 in its id)
                                │
         Hop: status/reason, trajectoryId = hash(solver version, terrain id, vehicle, inputs),
              1 s samples (+ every phase boundary), dense 0.05 s steps, phases, propellant
                                │
   simulation resources  <drone>.state = {x,y,z km; vx,vy,vz km/s; quaternion; phase; trajectoryId}
                         <drone>.flightPhase, latitude, longitude, heightAboveTerrainM, propellantKg, ...
   activity result       PerformHop computed attributes: trajectoryId, duration, propellant, Δv, clearance, ...
                         AcquireSurveyImages: per-frame status, footprints (GeoJSON), area coverage
                                │
   Cosmolabe panel: <drone>.state profile → MissionStateSource (planned) ;  MMGIS: computed attributes (planned)
```

- **One calculation, two callers.** Like `11-rover`'s `DriveModel`/`Terrain`, the solver is plain Java shared by
  the goal and the effect model. The goal evaluates candidates *before* creating anything; the simulation
  recomputes from its own state; the goal then re-simulates and fails if the trajectory ids, durations or
  propellant differ (`Sim.checkFlown`). Same inputs give the same result bit for bit (tests, and the live check
  below gets the same ids as the local tests).
- **The exact trajectory is retrievable.** The simulation's `<drone>.state` profile *is* the published trajectory
  (each sample with its velocity, so Cosmolabe's Hermite interpolation reproduces the integrated path to < 5 cm,
  `HopSolverTest.publishedSamplesInterpolateToTheIntegratedPath`). No separate store, no network call per tick.
- **Failures are explicit.** An infeasible hop returns a status and reason, no trajectory; the drone stays put.
- **PlanDev limitation met:** no activity "blob" output exists, so samples travel as a discrete struct resource
  (fine at this size: ~170 segments per hop). Activity durations are only known after simulation, so the goal
  relies on its own (identical) solution to place dependent activities (the survey is anchored to the hop).

## The hop model

Point mass in the rotating Moon-fixed frame **MOON_ME_DE421**, metres and seconds, Cartesian throughout (no
latitude/longitude in the dynamics: no polar singularity). Gravity GM = 4902.800118 km³/s² (gm_de440), point mass;
centrifugal and Coriolis terms for a uniform rotation about +Z (sidereal month); thrust; mass flow = thrust /
(Isp g0). RK4, fixed 0.05 s step, thrust held over each step.

Phases: **LIFTOFF** (full thrust straight up, 15 m) → **ASCENT** (full thrust, fixed direction, pitch γ toward the
target, duration t1 found by bisection so the coast reaches the gate's radius at the target's downrange angle) →
**COAST** (ballistic) → **BRAKING** (ZEM/ZEV feedback guidance to a gate 30 m above the site, descending 2 m/s,
thrust clamped to 25–100 %) → **TERMINAL** (1 m/s vertical-speed hold with horizontal position hold to
touchdown) → **LANDED**. For each pitch in the profile (`MIN_PROPELLANT` 20–75°, `LOW_ARC` 15–25°,
`HIGH_ARC` 60–80°) braking start and duration are searched; the feasible candidate using least propellant wins.
That is the least-propellant *tested* candidate, not a fuel-optimal trajectory.

Attitude policy (body +Z = thrust axis): powered phases +Z along thrust, +X toward the target; coast +Z radial up
(camera at nadir), +X along the horizontal velocity; landed +Z along the terrain normal. Switches are instantaneous
(no attitude dynamics); imaging waits 3 s into the coast.

Rejections (`HopSolver.Status`): `OUTSIDE_TERRAIN_COVERAGE` (destination, flight or landing-site slope area not in
the pack; landing sites need level ≥ 11 terrain, ~27 m posts), `UNSUPPORTED_RANGE` (< 50 m or > 20 km),
`UNREACHABLE` (thrust/weight ≤ 1.05, or a 200 s ascent cannot reach), `INSUFFICIENT_PROPELLANT` (exhausted, or
< 1 kg reserve at touchdown), `TERRAIN_CLEARANCE` (< 5 m above the terrain plus its stated tile uncertainty,
lift-off to gate), `LANDING_SLOPE` (> 12° over ±15 m), `LANDING_SPEED` (> 2 m/s vertical or 0.5 m/s horizontal),
`NO_CONVERGENCE` (braking misses the gate by > 2 m or 0.3 m/s).

Validity limits: hops ≤ 20 km inside the packed terrain (22 km around the pole). Not modelled: gravity field
harmonics and mascons, libration, third bodies, engine transients, attitude dynamics and slew time, navigation
error, plume/dust, thermal and power during flight, illumination of the imaged ground.

### Example numbers (Polaris-A from its base -89.55°, -45°, 40 kg propellant)

| Destination | Range | Pitch | Duration | Propellant | Max height |
|---|---|---|---|---|---|
| -89.62°, -30° (rim plain) | 3.9 km | 45° | 119.2 s | 9.89 kg | 918 m |
| -89.70°, 0° (into Shackleton) | 9.7 km | 50° | 171.8 s | 13.91 kg | 2476 m |
| -89.72°, -5° with `LOW_ARC` | 9.0 km | — | rejected `TERRAIN_CLEARANCE` (the rim) | | |
| -89.45°, -60° | 5.0 km | — | rejected `LANDING_SLOPE` 15.8° | | |

## Terrain

`MoonTerrain` reads the native float32 tiles of Cosmolabe's `moon-terrain-cube` revision
`cube-fused-79895697c6b6-g3-m12-b6747ec9d` (LOLA 118 m global + south-pole LOLA 10 m residual; heights in metres
above the 1737.4 km sphere, radial, MOON_ME_DE421) — the product the Cosmolabe scene renders. Only each location's
finest tile is packed; a coarser ancestor is never substituted. Heights use the same lattice triangles as
Cosmolabe's `CubeSphereSampler` and agree with it to 1e-6 m at 300 points (`MoonTerrainTest`). Its id
(`mission.terrain` resource, every hop result) is `<revision>@<pack SHA-256>`.

```bash
node examples/12-moonfall/data/build-terrain-pack.mjs            # from https://data.aaronplave.com (pinned build)
node examples/12-moonfall/data/build-terrain-pack.mjs --verify   # check against the committed index.json
```

## Camera

Fictional: one downward survey camera, 40° × 30°, 2048 × 1536 px, 9.4 Mbit per compressed image, boresight body
−Z, image up +X. Footprints are the centre and corner rays intersected with `MoonTerrain`; a ray leaving the terrain
gives no footprint. Coverage of a survey area is evaluated on a 10 m grid in a south-polar stereographic plane.
Images are taken only in the coast attitude; others are recorded as skipped with the reason and make no data.

## Sun and Earth (SPICE)

`LunarSky` gives the Sun and Earth from a drone's position with SPICE (`spkpos`, LT+S, observer parallax applied) in
MOON_ME_DE421, from the shared `spice-kernels/` (DE440s, naif0012, and the DE421 lunar orientation
`moon_pa_de421_1900_2050.bpc` + `moon_080317.tf`, the LRO archive files Cosmolabe loads). Per drone, every 10 min:
`sunElevationDeg` / `earthElevationDeg` above the **reference-sphere** horizon, and `sunTerrainView` /
`earthTerrainView` (BLOCKED_BY_TERRAIN, CLEAR_WITHIN_TERRAIN_PACK, BELOW_HORIZON) from the terrain pack only (22 km
around the pole; farther massifs are not represented). `LunarSkyTest` checks JNISpice against Cosmolabe's
independent cspice-wasm build on the same kernels (`data/lunar-sky-reference.mjs`). Not yet used for power or comms.

## Build, test, run

```bash
node examples/12-moonfall/data/build-terrain-pack.mjs
./gradlew :examples:12-moonfall:test :examples:12-moonfall:scheduling:test     # 40 tests
./gradlew :examples:12-moonfall:build :examples:12-moonfall:scheduling:buildSchedulingProcedureJar_PlanHop
node integrations/mmgis/scripts/setup-plandev.js moonfall          # model "moonfall" v3, goal, three demo plans, saved View
node integrations/mmgis/scripts/verify-moonfall.js <hop plan> <survey plans...>
./gradlew :examples:12-moonfall:probe --args="startLat startLon destLat destLon ..."  # dev: print solutions
```

Tests check the solver against independent arithmetic: each 0.05 s step re-integrated with the test's own gravity
and a 10× finer integrator (position < 1 µm), mass loss = |T|/(Isp g0) every step, total impulse vs propellant and
the rocket equation, the Jacobi integral over the coast, clearance re-sampled from the terrain, Hermite
reconstruction of the published samples, attitude axes, determinism, chaining from a previous landing, and every
rejection. Simulation tests (local Merlin) check that the simulation flies the solved trajectory sample for sample,
that the drone is not at the site before touchdown, that a destination edit replaces the trajectory, that a failed
hop does not move the drone, that concurrent drones do not disturb each other, imaging footprints, and the goal.

## Not done yet

Power/battery and comms windows from the Sun/Earth resources, downlink,
a multi-drone campaign goal with shared constraints, MMGIS layers for paths and footprints. See the report in
`claude-plans/plandev/moonfall/`.
