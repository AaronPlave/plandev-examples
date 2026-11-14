# 11-rover: a Mars rover traverse over real terrain

A rover in Jezero crater that drives between science sites. A procedural scheduling goal plans the route over a terrain slope grid and creates the plan's activities. The mission model simulates the same drive on the same grid.

| Path | What |
|---|---|
| `src/main/java/rover/Terrain.java` | The slope grid, loaded from the jar. Its identity is `<dataset>@<first 12 hex of SHA-256>`. |
| `src/main/java/rover/DriveModel.java` | Speed and drive power as a function of slope. **Illustrative**; both the goal and the simulation call it. |
| `src/main/java/rover/activities/Drive.java` | Drives the planned `waypoints` leg by leg. The simulated location changes on arrival at each waypoint. The rover stops early when the battery falls below 10 % (`HALTED_LOW_BATTERY`), and does not start if it is not at the first waypoint (`OFF_ROUTE`). |
| `src/main/java/rover/activities/Observe.java` | Instrument power and science data. It records the planned site but does not move the rover. |
| `scheduling/.../TraversePlanner.java` | The planning algorithm, pure and unit-tested:<ul><li>A* search over 8-connected terrain cells, minimizing distance, time or energy;</li><li>a slope limit and avoid-polygons make cells impassable;</li><li>an exhaustive search over visiting orders (up to 8 sites) maximizes site priority before the plan end;</li><li>drives are split for recharge stops to keep the estimated battery above a reserve.</li></ul> |
| `scheduling/.../ScheduleTraverse.java` | The goal. It reads the start location, battery and array output from a simulation, then creates `Drive` activities (with waypoints, the terrain id and the objective) and `Observe` activities. Blank `sites` means the catalog in `src/main/resources/rover/sites.geojson`. |
| `constraints/.../DriveSlopeLimit.java` | A violation while `rover.slopeDeg` is above a limit. |
| `data/build-jezero-data.sh` | Rebuilds the grid, and optionally MMGIS basemap tiles, from USGS products (below). |

## Data

- **Terrain.** The slope of the USGS Astrogeology Mars 2020 TRN CTX DTM (`JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m`, 20 m/px), averaged over 200 m cells. The grid is 160 × 151 cells, in planetocentric degrees, east-positive, on the Mars 2000 sphere. The equirectangular source understates east-west slope components by about 5 %; this is not corrected.
- **Sites.** Approximate positions near features of the crater, for illustration. They are not mission coordinates.
- **Vehicle.** All numbers are illustrative:
  - 0.2 m/s on level ground, half speed at 10°;
  - 100 W plus 30 W per degree of slope while driving, 60 W idle;
  - a 1680 Wh battery;
  - an array that makes about 254 W, constantly (no day/night cycle);
  - drives at any hour.

The slope numbers are real. What the rover does with them is not a vehicle model.

## Build and test

```bash
./gradlew :examples:11-rover:build :examples:11-rover:scheduling:compileJava :examples:11-rover:constraints:compileJava
./gradlew :examples:11-rover:scheduling:test
./gradlew :examples:11-rover:scheduling:buildSchedulingProcedureJar_ScheduleTraverse :examples:11-rover:constraints:buildAllConstraintProcedureJars
```

`integrations/mmgis/scripts/setup-plandev.js rover` uploads the model, goal and constraints, and creates these plans:

- *Jezero traverse (least energy)*
- *(shortest distance)*
- *(alongside the MRO plan)*, which spans the same days as the MRO demo plan.

On the shipped grid the objectives choose different routes. To the west rim, the shortest route is 12.0 km and needs 8957 Wh; the least-energy route is 15.7 km and needs 7152 Wh.
