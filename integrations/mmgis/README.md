# MMGIS ↔ PlanDev integration (prototype)

Draw targets on Mars in **MMGIS**. Plan observations for them in **PlanDev** with a mission procedural goal, simulate the result, and view what came back on the MMGIS map. Iterate without touching the original plan.

```
MMGIS Draw tool ──GeoJSON──▶ PlanDev tool (browser) ──/api/plandev──▶ PlanDev backend plugin (MMGIS server)
                                                                          │  gateway login + Hasura GraphQL, role "user"
                                                                          ▼
          duplicate_plan(base) → scheduling_specification_goals.arguments = {targets: GeoJSON, …}
          → schedule → simulate → activities, spans, resource profiles
                                                                          │
MMGIS vector layer (mmgisAPI.addLayer) ◀──GeoJSON + metrics────────────────┘
```

| Path | What |
|---|---|
| `backend/PlanDev/` | MMGIS backend plugin. Holds the PlanDev credentials (env only) and mounts `/api/plandev/*` behind MMGIS sign-in (`draw.use`). |
| `tools/PlanDev/` | MMGIS tool panel. Picks Draw features, sets goal parameters, lists candidates, shows results, and toggles result layers. |
| `lib/plandev.js` | Minimal server-side PlanDev client (gateway login, GraphQL, file upload, plan import). |
| `lib/workflow.js` | The candidate workflow and the GeoJSON/metric read-back. It has no MMGIS dependencies. |
| `scripts/setup-plandev.js` | One-time setup: uploads the 05-orbiter model and the `ScheduleTargetObservations` goal, imports the base plan, and simulates it. |
| `scripts/setup-mmgis.js` | One-time setup: creates the first MMGIS admin and the `Mars-PlanDev` mission (`mission/Mars-PlanDev.config.json`). |
| `deploy/plandev-spice.override.yml` | Compose override that mounts `spice-kernels/` into merlin, the merlin workers and the scheduler workers. |
| `../../examples/05-orbiter/scheduling/.../ScheduleTargetObservations.java` | The mission-specific goal. |

## Data conventions

- **Body and frame:** Mars, IAU_MARS body-fixed. **Coordinates:** planetocentric latitude and east-positive longitude, in degrees. The goal wraps longitudes into [-180, 180). The basemap (Viking MDIM 2.1) uses the same convention.
- **Targets:** a GeoJSON FeatureCollection of `Point` or `Polygon` features. A polygon is reduced to the mean of its vertices. Feature ids are `draw-<fileId>-<featureId>`, and `properties.source` keeps the MMGIS mission, the Draw file and the feature id.
- **Association:** each scheduled `TakeRadarObservation` is named `TargetObs <featureId>`.
- **Times:** UTC ISO-8601. PlanDev offsets are converted against the plan's `start_time`.
- **Distances:** great-circle distances on a sphere with the Mars mean radius (3389.5 km).
- **What the goal computes:** the closest pass of the MRO sub-spacecraft point (SPICE `sincpt` toward the body centre, `LT+S`), searched at 30 s steps and refined at 1 s within the plan bounds. A target is scheduled only if that pass comes within `maxGroundDistanceKm`. This is **not** instrument-footprint coverage, because the model has no radar pointing or footprint.

## Local setup

The steps below are what this prototype was verified with. Ports belong to the `pd` stack `mmgis`; substitute your own.

1. **Build** (from the plandev-examples root):
   ```bash
   git lfs pull
   ./gradlew :examples:05-orbiter:build :examples:05-orbiter:scheduling:compileJava
   ./gradlew :examples:05-orbiter:scheduling:buildSchedulingProcedureJar_ScheduleTargetObservations
   ```
2. **PlanDev v4.5.0** with the kernels mounted. Pass `-f deploy/plandev-spice.override.yml` on top of plandev's `docker-compose.yml`, with `SPICE_KERNELS_PATH=<abs path>/spice-kernels`. With `pd`:
   ```bash
   pd stack new mmgis --plandev <plandev v4.5.0 checkout> --build --empty
   # add "extraComposeFiles": ["<override with absolute path>"] to the stack in ~/.pd/registry.json
   pd stack up mmgis
   pd new mmgis-ui --from v4.5.0 --backend mmgis && pd up mmgis-ui     # PlanDev UI on :3111
   ```
3. **Seed PlanDev** (uploading a model needs `aerie_admin`; nothing else does):
   ```bash
   PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=http://localhost:31021 PLANDEV_HASURA_URL=http://localhost:31020 \
   PLANDEV_USERNAME=mmgis-planner PLANDEV_PASSWORD=… node integrations/mmgis/scripts/setup-plandev.js
   ```
   The script prints `PLANDEV_BASE_PLAN_ID` and `PLANDEV_GOAL_ID`.
4. **MMGIS** (≥ 5.5, Node 22) with PostGIS:
   ```bash
   docker run -d --name mmgis-postgis -e POSTGRES_USER=mmgis -e POSTGRES_PASSWORD=mmgis -e POSTGRES_DB=mmgis -p 35432:5432 postgis/postgis:16-3.4
   cd MMGIS && cp sample.env .env    # set DB_PORT=35432, DB_NAME/USER/PASS=mmgis, SECRET, SETUP_CODE
   npm install && (cd configure && npm install && npm run build)
   npm run plugins -- install <plandev-examples>/integrations/mmgis --container plandev
   ```
   Append the following to MMGIS `.env`, then run `npm start` (UI on :8889):
   ```
   PLANDEV_GATEWAY_URL=http://localhost:31021
   PLANDEV_HASURA_URL=http://localhost:31020
   PLANDEV_USERNAME=mmgis-planner
   PLANDEV_PASSWORD=…
   PLANDEV_BASE_PLAN_ID=1
   PLANDEV_GOAL_ID=1
   PLANDEV_UI_URL=http://localhost:3111
   ```
5. **Mission:** `MMGIS_ADMIN=admin MMGIS_ADMIN_PASSWORD='…' MMGIS_SETUP_CODE=… node integrations/mmgis/scripts/setup-mmgis.js`
6. Open `http://localhost:8889/?mission=Mars-PlanDev` and sign in.
   1. In the **Draw** tool, create a file and place points.
   2. In the **PlanDev** tool, pick the file, tick targets and set parameters, then click **Create candidate**.
   3. When the status reaches *complete*, toggle the eye icon to show the layer. **Open plan in PlanDev** opens the same candidate in the PlanDev UI.

The installed plugin is a copy: after editing the plugin, run `npm run plugins -- uninstall plandev` and then install again. Restart MMGIS for backend changes.

Tests: `node --test integrations/mmgis/test/*.test.js` and `./gradlew :examples:05-orbiter:scheduling:test`. The second runs the goal's pass search against the real kernels and asserts that different targets give different passes.

## Metrics shown (all read from the candidate's PlanDev simulation dataset)

| Metric | Source |
|---|---|
| Observation start/end | `span` of the `TakeRadarObservation` (falls back to the directive) |
| Min sampled distance | closest 30 s sample of `subSCBodies_MARS_latitude/longitude` during the observation |
| SOC at observation end, vs. base | `cbebattery.batterySOC` in the candidate and in the base plan's latest dataset |
| Data written | change in `scBin<bin>.volume` over the observation |
| Plan min SOC; final onboard volume, vs. base | `cbebattery.batterySOC`, `onboard.volume` |
| Ground-track layer | `subSCBodies_MARS_*` profiles, ±15 min around each observation |

The plan-level `onboard.volume` change is larger than the data the observations write. Adding activities shifts the model's seeded bin choice for later `ChangeRadarDataMode` activities. That effect is deterministic (re-simulation reproduces it exactly) but it is a model interaction, so the per-observation column is the direct effect.

## Prototype limits

- A single service identity (`PLANDEV_USERNAME`) owns every candidate. The MMGIS username is recorded only in the plan description.
- MMGIS has no plugin-defined capabilities, so planning is gated on `draw.use`, which any signed-in user has.
- Scheduling and simulation run in a promise inside the MMGIS process. Status is always re-read from PlanDev, so a restart mid-run leaves a candidate that shows *scheduled, not simulated*.
- Result layers are session-only (`mmgisAPI.addLayer`). They are not written to GeoDatasets or the mission config.
- The goal handles only `Point` and `Polygon` targets. One base plan and one goal come from env.
