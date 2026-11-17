# 11-rover: a Mars rover traverse over real terrain

A rover in Jezero crater that drives between science sites. A procedural scheduling goal plans the route over a terrain slope grid and creates the plan's activities. The mission model simulates the same drive on the same grid.

| Path | What |
|---|---|
| `src/main/java/rover/Terrain.java` | The slope grid, loaded from the jar. Its identity is `<dataset>@<first 12 hex of SHA-256>`. |
| `src/main/java/rover/DriveModel.java` | Speed and drive power as a function of slope. **Illustrative**; both the goal and the simulation call it. |
| `src/main/java/rover/activities/Drive.java` | Drives the planned `waypoints` leg by leg. The simulated location changes on arrival at each waypoint. The rover stops early when the battery falls below 10 % (`HALTED_LOW_BATTERY`), and does not start if it is not at the first waypoint (`OFF_ROUTE`). |
| `src/main/java/rover/activities/Observe.java` | Instrument power and science data. It records the planned site but does not move the rover. |
| `src/main/java/rover/MarsSun.java` | The Sun in the rover's sky: Mars24 (Allison and McEwen 2000), no kernels. Geometric elevation above the ellipsoid normal, local true solar time, solar distance. The model and the goal both call it. Agrees with SPICE to 0.003° (`MarsSunTest`, references from `data/spice-sun-reference.py`). |
| `src/main/java/rover/activities/Wait.java` | The rover idles, for a night or a recharge, with its `reason`. It changes nothing; it makes the planned pause visible on the timeline. |
| `scheduling/.../TraversePlanner.java` | The planning algorithm, pure and unit-tested:<ul><li>A* search over 8-connected terrain cells, minimizing distance, time or energy;</li><li>a slope limit and avoid-polygons make cells impassable;</li><li>an exhaustive search over visiting orders (up to 8 sites) maximizes site priority before the plan end;</li><li>drives are split for recharge stops to keep the estimated battery above a reserve.</li></ul> |
| `scheduling/.../ScheduleTraverse.java` | The goal. It reads the start location, battery and array output from a simulation, then creates `Drive` activities (with waypoints, the terrain id and the objective) and `Observe` activities. Blank `sites` means the catalog in `src/main/resources/rover/sites.geojson`. |
| `constraints/.../DriveSlopeLimit.java` | A violation while `rover.slopeDeg` is above a limit. |
| `constraints/.../DriveDaylight.java` | A violation while the rover drives with its drive window closed (`rover.driveStatus` = `DRIVING` and `rover.driveWindowOpen` false). |
| `data/build-jezero-data.sh` | Rebuilds the grid, and optionally MMGIS basemap tiles, from USGS products (below). |

## Data

- **Terrain.** The slope of the USGS Astrogeology Mars 2020 TRN CTX DTM (`JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m`, 20 m/px), averaged over 200 m cells. The grid is 160 × 151 cells, in planetocentric degrees, east-positive, on the Mars 2000 sphere. The equirectangular source understates east-west slope components by about 5 %; this is not corrected.
- **Sites.** Approximate positions near features of the crater, for illustration. They are not mission coordinates.
- **Vehicle.** All numbers are illustrative:
  - 0.2 m/s on level ground, half speed at 10°;
  - 100 W plus 30 W per degree of slope while driving, 60 W idle;
  - a 1680 Wh battery;
  - a horizontal 6.5 m² array. Its output follows the Sun's elevation and distance: about 730 W with the Sun overhead near aphelion, nothing at night, and about 240 W averaged over a sol at Jezero in February 2027.

The slope numbers are real. What the rover does with them is not a vehicle model.

## Sunlight and the drive window

The model tracks the Sun at the rover (`rover.sunElevationDeg`, `rover.localSolarTimeHours`) every 10 minutes, and exactly when it crosses the drive limit. Three things are kept apart:

| | What | Where |
|---|---|---|
| Geometric solar elevation | The Sun's centre above the local horizontal of a smooth Mars ellipsoid. No refraction, atmosphere or dust. | `MarsSun`, `rover.sunElevationDeg` |
| Mission drive rules | **Example values, not a mission's.** The rover may drive only with the Sun at least 10° high (`driveMinSunElevationDeg`), and a drive starts only with at least 45 min of that left (`driveDaylightMarginMin`). They are model configuration; the goal reads them from a simulation. | `Configuration`, `rover.driveWindowOpen`, `DriveDaylight` |
| Terrain shadowing | **Not modeled.** “Sun above 10°” does not mean the rover is lit: crater walls can hide it. | — |

The model does not enforce the drive window, just as it does not enforce the slope limit: a plan that drives in the dark simulates (on battery alone) and the `DriveDaylight` constraint reports it.

`ScheduleTraverse` takes `driveWindow`:

- `DAYLIGHT` (default): every candidate visiting order is played forward in time. Drives start only inside the window with the margin left, stop at the last waypoint reachable before it closes, and resume the next morning; the pause is a `Wait` (“night: …”). A multi-hour drive is split across sols.
- `ANY_TIME`: drives whenever the battery allows; the rover still stops to recharge (a `Wait`, “recharge to 95 %”) when its estimated charge would drop below the reserve.

In both, the planner's state of charge integrates the same array output as the model, in 10-minute steps. It is an estimate.

### What the rule changes

The demo plans start on 2027-02-01 at 00:00 UTC, mid-afternoon at Jezero, with about two hours of drive window left. Same sites, objective and goal; only `driveWindow` differs. These are the simulated outcomes:

| | `ANY_TIME` | `DAYLIGHT` |
|---|---|---|
| Sites observed (priority) | 5 (13) | 5 (13) |
| Traverse finishes at | 94.6 h | 93.0 h |
| Driving with the drive window closed | 13.3 h (4 `DriveDaylight` windows) | 0 h |
| Lowest battery | 3 % (4 `MinBatterySOC` windows) | 42 % |
| Waiting (nights, recharge) | 53.8 h | 52.2 h |

Driving through the night does not get the rover there sooner. A solar rover that drives on its battery after dark has to repay that energy in daylight, and the night's idle load then takes the battery below the reserve before the next sunrise. The planner's reserve check only covers the drive itself, not the night that follows. That is a weakness of the any-hour policy, not something to patch in the planner.

## Build and test

```bash
./gradlew :examples:11-rover:build :examples:11-rover:scheduling:compileJava :examples:11-rover:constraints:compileJava
./gradlew :examples:11-rover:scheduling:test
./gradlew :examples:11-rover:scheduling:buildSchedulingProcedureJar_ScheduleTraverse :examples:11-rover:constraints:buildAllConstraintProcedureJars
```

`integrations/mmgis/scripts/setup-plandev.js rover` uploads the model, goal and constraints, and creates these plans:

- *Jezero daylight traverse* (`driveWindow` `DAYLIGHT`);
- *Jezero traverse, driving at any hour* (`ANY_TIME`).

Both use the least-energy objective. The model is uploaded as `rover-mmgis` version 2. Plans of version 1 (constant array output, no Sun) still show in the map, without solar data.

On the shipped grid the objectives choose different routes. To the west rim, the shortest route is 12.0 km and needs 8957 Wh; the least-energy route is 15.7 km and needs 7152 Wh.
