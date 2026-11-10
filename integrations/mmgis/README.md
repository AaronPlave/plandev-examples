# MMGIS ↔ PlanDev integration (prototype)

Use **MMGIS** to draw spatial targets. **PlanDev** then plans and simulates a candidate plan for them, using a mission's own procedural goal. Results appear in MMGIS:

- **Standalone:** the MMGIS PlanDev tool creates and compares candidates.
- **Embedded:** MMGIS runs in a PlanDev plan's *External Application* panel, kept in step with the timeline's time cursor, activity selection and the plan or simulation dataset on screen.

The same code drives two missions:

- **`mro`**: radar observations of Mars targets (`examples/05-orbiter`).
- **`hopper`**: a lunar hop-and-image traverse (`examples/04-hopper`).

```
MMGIS Draw ──GeoJSON──▶ PlanDev tool ──/api/plandev──▶ backend plugin (MMGIS server, holds PlanDev credentials)
                                                         │  lib/candidates.js  (generic: duplicate → goal args → schedule → simulate → read)
                                                         │  missions/<key>.js  (mission: goal args, metrics, map features, position)
                                                         ▼
                              PlanDev (Hasura + gateway), role "user"

PlanDev plan page ── postMessage plandev.embed.v1 (ids + time only) ──▶ MMGIS in the IFrame panel
                 ◀── setTime / select ─────────────────────────────────
```

| Path | What |
|---|---|
| `backend/PlanDev/` | MMGIS backend plugin. Holds the PlanDev credentials (env only) and mounts `/api/plandev/*` behind MMGIS sign-in (`draw.use`). |
| `lib/plandev.js` | Minimal server-side PlanDev client (gateway login, GraphQL, file upload, plan import). |
| `lib/candidates.js` | **Mission-independent.** Creates candidates (duplicate plan, set goal arguments, copy constraint specs, schedule, simulate) and assembles the *plan view* for any plan of a configured model. Also reads directives, spans, profiles and constraint results. |
| `lib/util.js` | Pure helpers: intervals, profile evaluation, GeoJSON validation, great-circle distance. |
| `missions/mro.js`, `missions/hopper.js` | **Mission adapters.** Each one defines its goal arguments and parameters, how it reads the goal's outputs, its metrics and table, its map features, and the position track. |
| `tools/PlanDev/PlanDevTool.js` | MMGIS tool panel. Generic: forms, tables and metrics are rendered from what the adapter returns. Selects the adapter with the tool variable `mission`. |
| `tools/PlanDev/PlanDevEmbed.js` | Embedded mode: the MMGIS end of the `plandev.embed.v1` bridge. |
| `scripts/setup-plandev.js` | Uploads each mission's model, goal and constraint, and creates or imports its base plan. |
| `scripts/setup-mmgis.js` | Creates the `Mars-PlanDev` and `Moon-PlanDev` MMGIS missions (`mission/*.config.json`). |
| `deploy/plandev-spice.override.yml` | Compose override that mounts `spice-kernels/` into merlin and its workers, and into the scheduler workers (MRO only). |

## The adapter contract

`lib/candidates.js` calls these members of an adapter, and nothing else:

| Member | Used for |
|---|---|
| `key`, `label`, `help`, `conventions` | Identity, and the body/frame/coordinate/time conventions recorded in each view's provenance. |
| `targets: {types, max, ordered}` | Validating the targets the browser sends. |
| `params: [{key, label, unit, type, min, max, options, default}]` | Validating parameters and rendering the form. |
| `goalArguments(targets, params)` / `inputsFromGoalArguments(args)` | Converting to and from the spec-goal arguments stored in PlanDev, which remain the record of what was asked. |
| `interpret(ctx)` → `{features, position, table, notes}` | Map features, position track, per-activity table and notes for one simulation dataset. |
| `metrics(ctx)` → `[{key, name, value, unit, digits}]` | Summary metrics. The generic code also computes them on the base plan and adds `base` to each. |

`ctx` holds the plan, the simulation dataset, the goal arguments, plan-relative time helpers, and `ops`, which offers cached `profiles`, `spans` and `directives` reads.

Feature properties that the generic map code relies on:

- `spanId`, `directiveId`, `startMs`, `endMs`, `name`.
- `primary`: the feature that stands for its activity, used when selecting.
- `context`: geometry left out when fitting the map.

The generic layer adds `fid`, `planId` and `simulationDatasetId` to every feature.

## Embedded mode (PlanDev UI side)

The plan page's *External Application* panel (`IFrame.svelte` in plandev-ui) posts `plandev.embed.v1` context to its iframe:

- `planId`, `planRevision`, `simulationDatasetId`.
- `timeMs`, the timeline time cursor.
- `selectedActivityDirectiveId`, `selectedSpanId`.

Posts go to the iframe src's origin only, at most one every 100 ms.

The panel accepts three requests, and only from that iframe at that origin: `ready`, `setTime` and `select`. No credentials or simulation results cross the bridge; MMGIS fetches the view with its own session.

On the MMGIS side the bridge runs only when MMGIS is framed by an origin listed in the PlanDev tool's `embedOrigins` variable. MMGIS's `FRAME_ANCESTORS` must allow that origin too.

What MMGIS shows:

- **Position:** the latest simulated sample at or before the cursor. It is not interpolated.
  - MRO: 30 s `subSCBodies_MARS_*` samples, with a ±45 min sampled-track window.
  - Hopper: `hopper.latitude/longitude`, which change when a hop lands.
- **Timeline → map:** a selection in the timeline selects the activity's `primary` feature in MMGIS.
- **Map → timeline:** clicking a feature selects its span or directive in PlanDev and moves the cursor to the activity's start. Clicking near a shown position sample moves the cursor to that sample.
- **Plan or dataset change:** the map reloads. The pill on the map shows the plan, its revision, the simulation dataset and its status. Features carry `simulationDatasetId`, and map clicks on a stale dataset's features are ignored.

## Data conventions

- **Mars:**
  - IAU_MARS body-fixed, with planetocentric latitude and east-positive longitude.
  - Basemap: Viking MDIM 2.1.
- **Moon:**
  - Body-fixed, with planetocentric latitude and east-positive longitude.
  - Basemap: OpenPlanetaryMap hillshaded albedo. It is native only to zoom 6 (about 0.7 km/px), so hop-scale views are blurry.
- **Targets:** GeoJSON Point or Polygon features (MRO), or Point features (hopper). Their ids are `draw-<fileId>-<featureId>`, and `properties.source` keeps the MMGIS mission, the Draw file and the feature id.
- **Association:**
  - MRO: the goal names each directive `TargetObs <featureId>`, and the adapter turns that name into `targetId`.
  - Hopper: the goal writes the site id into the `toSiteId` and `siteId` activity arguments.
  - From then on, everything is keyed by span and directive ids.
- **Times:** UTC. Constraint windows are converted from microsecond plan offsets.

### What each mission computes (from simulation)

| | MRO | Hopper |
|---|---|---|
| Goal | `ScheduleTargetObservations`: closest SPICE sub-spacecraft pass per target, if within `maxGroundDistanceKm`. It does not check footprint coverage. | `ScheduleHopTraverse`: hop to each site, in the drawn order or nearest-next. Each hop is followed by a rest and an image. |
| Map | Targets; observation track; ±15 min track; target ↔ closest-sample line | Sites; the location at plan start; hop legs as straight segments between the simulated take-off and landing locations; image points |
| Table | Per observation: target, start, closest 30 s sample distance, SOC at end, data written | Per leg: destination, start, distance (from the odometer), hop duration, SOC after |
| Metrics | Min SOC, final onboard data, observation count | Distance hopped, traverse duration, hops, images, min SOC, data onboard, storage capacity |
| Constraints | None configured | `MinBatterySOC` at 80 % (the base plan's spec, copied into each candidate) |

Hopper hop timing is **illustrative**: 60 s plus the distance at 50 m/s. It is implemented once, in `hopper.HopModel`, and both `PerformHop` and the goal call it.

The hopper base plan uses an illustrative power configuration: a 2 m² array and a 10 Ah battery. With the model defaults, the array out-produces the 1000 W hop load.

## Local setup

The steps below are what this prototype was verified with. Ports belong to the `pd` stack `mmgis`; substitute your own.

1. **Build** (from the plandev-examples root):
   ```bash
   git lfs pull
   ./gradlew :examples:05-orbiter:build :examples:05-orbiter:scheduling:compileJava :examples:04-hopper:build \
             :examples:04-hopper:scheduling:compileJava :examples:04-hopper:constraints:compileJava
   ./gradlew :examples:05-orbiter:scheduling:buildSchedulingProcedureJar_ScheduleTargetObservations \
             :examples:04-hopper:scheduling:buildSchedulingProcedureJar_ScheduleHopTraverse \
             :examples:04-hopper:constraints:buildAllConstraintProcedureJars
   ```
2. **PlanDev v4.5.0** with the kernels mounted. Pass `-f deploy/plandev-spice.override.yml` on top of plandev's `docker-compose.yml`, with `SPICE_KERNELS_PATH=<abs path>/spice-kernels`. With `pd`:
   ```bash
   pd stack new mmgis --plandev <plandev v4.5.0 checkout> --build --empty
   # add "extraComposeFiles": ["<override with absolute path>"] to the stack in ~/.pd/registry.json
   pd stack up mmgis
   pd new mmgis-ui --from v4.5.0 --backend mmgis && pd up mmgis-ui     # PlanDev UI on :3111
   ```
   Embedded mode needs the plandev-ui branch `feat/embedded-app-bridge` in that UI checkout.
3. **Seed PlanDev** (uploading a model needs `aerie_admin`; nothing else does):
   ```bash
   PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=http://localhost:31021 PLANDEV_HASURA_URL=http://localhost:31020 \
   PLANDEV_USERNAME=mmgis-planner PLANDEV_PASSWORD=… node integrations/mmgis/scripts/setup-plandev.js   # [mro] [hopper]
   ```
   The script prints `PLANDEV_<MISSION>_BASE_PLAN_ID` and `PLANDEV_<MISSION>_GOAL_ID`.
4. **MMGIS** (≥ 5.5, Node 22) with PostGIS. Also apply the `mmgisAPI.addLayer` fix (branch `fix/mmgisapi-addlayer-resetconfig`).
   ```bash
   docker run -d --name mmgis-postgis -e POSTGRES_USER=mmgis -e POSTGRES_PASSWORD=mmgis -e POSTGRES_DB=mmgis -p 35432:5432 postgis/postgis:16-3.4
   cd MMGIS && cp sample.env .env    # set DB_PORT=35432, DB_NAME/USER/PASS=mmgis, SECRET, SETUP_CODE
   npm install && (cd configure && npm install && npm run build)
   npm run plugins -- install <plandev-examples>/integrations/mmgis --container plandev
   ```
   Add the following to MMGIS `.env`, then run `npm start` (UI on :8889):
   ```
   FRAME_ANCESTORS='["http://localhost:3111"]'
   PLANDEV_GATEWAY_URL=http://localhost:31021
   PLANDEV_HASURA_URL=http://localhost:31020
   PLANDEV_USERNAME=mmgis-planner
   PLANDEV_PASSWORD=…
   PLANDEV_MRO_BASE_PLAN_ID=…
   PLANDEV_MRO_GOAL_ID=…
   PLANDEV_HOPPER_BASE_PLAN_ID=…
   PLANDEV_HOPPER_GOAL_ID=…
   PLANDEV_UI_URL=http://localhost:3111
   ```
5. **Missions:** `MMGIS_ADMIN=admin MMGIS_ADMIN_PASSWORD='…' MMGIS_SETUP_CODE=… node integrations/mmgis/scripts/setup-mmgis.js`. The PlanDev tool's `embedOrigins` in `mission/*.config.json` must list the PlanDev UI origin.
6. **Standalone:** open `http://localhost:8889/?mission=Mars-PlanDev` (or `Moon-PlanDev`) and sign in.
   1. In the **Draw** tool, create a file and place points.
   2. In the **PlanDev** tool, pick the file, tick targets and set parameters, then click **Create candidate**.
   3. Toggle a plan's eye icon to show its layer.
7. **Embedded:** in a PlanDev plan, set a grid panel to *External Application* with `http://localhost:8889/?mission=Mars-PlanDev` (or `Moon-PlanDev`), then save the view.
   1. Sign in to MMGIS once in the same browser.
   2. Click the timeline's time-cursor lane (under the time axis) to place the cursor, and drag it to scrub.
   3. Select activities in the timeline or tables, or click features on the map.

   PlanDev views hold their timeline rows and their iframe URL, so in practice each mission needs its own view.

The installed plugin is a copy: after editing the plugin, run `npm run plugins -- uninstall plandev` and then install again. Restart MMGIS for backend changes.

Tests:
- `node --test integrations/mmgis/test/*.test.js`
- `./gradlew :examples:05-orbiter:scheduling:test`: the MRO pass search against the real kernels.
- `./gradlew :examples:04-hopper:scheduling:test`: route ordering and `HopModel`.

## Prototype limits

- **Identity:** a single service identity (`PLANDEV_USERNAME`) owns every candidate. The MMGIS username is recorded only in the plan description.
- **Authorization:** planning is gated on `draw.use`, which any signed-in MMGIS user has.
- **Process:** scheduling and simulation run in a promise inside the MMGIS process. Status is re-read from PlanDev, so a restart mid-run leaves a candidate showing *scheduled, not simulated*.
- **Layers:** result layers are session-only (`mmgisAPI.addLayer`).
- **Selection in MMGIS:** fires MMGIS's click pipeline, so the Info panel updates too.
- **Positions:** the map shows positions only where the model simulates them:
  - MRO: 30 s samples.
  - Hopper: landing locations only, with no in-flight position.
