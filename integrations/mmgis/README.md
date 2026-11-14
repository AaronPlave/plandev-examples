# MMGIS ↔ PlanDev integration (prototype)

Work on **existing PlanDev plans** from a map. In **MMGIS**, pick a plan (or follow the one PlanDev has open), then:

- **Inspect** its simulated spatial result, metrics and constraint results, compared with the plan it was derived from.
- **Evaluate** it read-only against features drawn in MMGIS. Nothing is created in PlanDev.
- **Explore** an alternative on a working branch: an ordinary PlanDev plan, duplicated once from the plan. Each update writes the map's inputs into the branch's goal arguments and re-runs the branch's whole scheduling specification, then simulates it. The goals replace their own earlier output there; every other activity is kept. The source plan never changes. *Keep as plan* ends the exploration; *Explore another* starts a separate branch.
- **Compare** plans, and earlier simulations of one branch: metrics and constraint violations side by side, with map overlays.

Candidates are ordinary PlanDev plans, linked by `parent_id`. The tool runs in two modes:

- **Standalone:** plans are chosen in the tool.
- **Embedded:** MMGIS runs in a PlanDev plan's *External Application* panel, kept in step with the timeline's time cursor, activity selection and the plan or simulation dataset on screen.

The same code drives three missions:

- **`mro`**: radar observations of Mars targets (`examples/05-orbiter`).
- **`hopper`**: a lunar hop-and-image traverse (`examples/04-hopper`).
- **`rover`**: a Jezero crater traverse planned over real terrain slope (`examples/11-rover`). Its plans are made in PlanDev, not from the map; embedded MMGIS shows them as soon as they are opened.

```
MMGIS Draw ──GeoJSON──▶ PlanDev tool ──/api/plandev──▶ backend plugin (MMGIS server, holds PlanDev credentials)
                                                         │  lib/candidates.js  (generic: branch → goal args → schedule → simulate → read)
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
| `lib/candidates.js` | **Mission-independent.** Explores alternatives of any plan of a configured model, which means:<br>• branching the plan once (`duplicate_plan`) and tagging the branch as a working branch;<br>• writing the map's inputs into the adapter goals' arguments;<br>• running the plan's own scheduling specification, then simulating.<br>It also assembles the revision-consistent *plan view* and runs read-only evaluations. Directives, spans, profiles and constraint results are read here. |
| `lib/util.js` | Pure helpers: intervals, profile evaluation, GeoJSON validation, great-circle distance, planar point/segment-in-polygon. |
| `missions/mro.js`, `missions/hopper.js` | **Mission adapters.** Each one defines its goal arguments and parameters, how it reads the goal's outputs, its metrics and table, its map features, and the position track. |
| `tools/PlanDev/PlanDevTool.js` | MMGIS tool panel. Generic: forms, tables and metrics are rendered from what the adapter returns. Selects the adapter with the tool variable `mission`. |
| `tools/PlanDev/PlanDevEmbed.js` | Embedded mode: the MMGIS end of the `plandev.embed.v1` bridge. |
| `scripts/setup-plandev.js` | Uploads each mission's model, goal and constraints, and creates or imports its plans. For the hopper this includes *Reiner Gamma ops (existing plan)*, built the way a PlanDev user would build it. |
| `scripts/setup-mmgis.js` | Creates the `Mars-PlanDev` and `Moon-PlanDev` MMGIS missions (`mission/*.config.json`). |
| `deploy/plandev-spice.override.yml` | Compose override that mounts `spice-kernels/` into merlin and its workers, and into the scheduler workers (MRO only). |

## The adapter contract

`lib/candidates.js` calls these members of an adapter, and nothing else:

| Member | Used for |
|---|---|
| `key`, `label`, `help`, `conventions` | Identity, and the body/frame/coordinate/time conventions recorded in each view's provenance. |
| `targets: {types, max, ordered, keep?, roles?, priority?}` | Validating the targets the browser sends. `keep` names the feature properties passed through (the rover's `priority`). `roles` and `priority` label the embedded editor's tools. |
| `params: [{key, label, unit, type, min, max, options, default}]` | Validating parameters and rendering the form. |
| `goals: [{name, arguments(targets, params)}]` / `inputsFromGoalArguments({name: args})` | The scheduling goals (by PlanDev goal name) that take the map's inputs, and converting to and from their spec-goal arguments. The plan's scheduling specification decides their order and simulate-after settings; other goals in it run untouched. |
| `interpret(ctx)` → `{features, position, overlays?, table, notes}` | Map features, position track, per-activity table and notes for one simulation dataset. A position sample is `[ms, lon, lat, capDeg?]`, where `capDeg` is an optional circle that moves with the entity (MRO: where it is in view). `overlays: [{id, name, datasetId, url, usedByPlan, usedBySimulation, source}]` are gridded data products the map can draw. |
| `interpretsPlanOnly` | *Optional.* `interpret` can draw a plan from its directives alone (`ctx.dataset` is null), so an unsimulated plan still shows its planned geometry (rover). |
| `data: {name: async () => grid}` | *Optional.* Data products served at `missions/:key/data/:name`, such as the rover's terrain. |
| `metrics(ctx)` → `[{key, name, value, unit, digits, headline?, better?}]` | Summary metrics. The generic code also computes them on the plan this one was derived from (`parent_id`), and adds that value to each metric as `base`. The embedded card leads with `headline` metrics. `better` (`low` or `high`) colours a difference as an improvement or not. |
| `evaluation: {help, targets, params}` + `evaluate(ctx, targets, params)` → `{features, table, summary, notes}` | *Optional.* A read-only spatial question about one plan's simulation (hopper, rover). |

`ctx` holds:

- the plan and the simulation dataset;
- `stale`;
- the goal arguments;
- plan-relative time helpers;
- `ops`, which offers cached `profiles`, `spans` and `directives` reads.

When the dataset simulated an older plan revision (`stale`), current plan state no longer describes it: `ops.directives` returns nothing and `goalArgs` is null. `goalArgs` is also null unless the last scheduling run succeeded with the specification as it is now, because PlanDev does not record which arguments a run used. The adapter then sees only what the dataset recorded.

Feature properties that the generic map code relies on:

- `spanId`, `directiveId`, `startMs`, `endMs`, `name`.
- `primary`: the feature that stands for its activity, used when selecting.
- `context`: geometry left out when fitting the map.
- `basis`: `simulated` (a modelled state), `planned` (geometry a plan's activities carry, e.g. route waypoints), `illustrative` (an assumed path or area), `input`, `analysis` or `violation`. The generic layer turns this into a per-feature style: solid; a wide faint band; dashed; white dotted; yellow dashed; red.
- `details: [[label, value]]`: shown when the feature is selected in the embedded card.
- `label`: a permanent map label.

The generic layer also adds a `violation` feature per constraint window: the simulated positions held during it.

The generic layer adds `fid`, `planId` and `simulationDatasetId` to every feature.

### Working on existing plans

| Step | Generic behaviour (`lib/candidates.js`) |
|---|---|
| Choose the plan | The mission comes from the plan's mission model. The request carries the caller's mission, and a plan of another mission is refused, for example a Moon map asked to revise a Mars plan. Embedded, the panel follows PlanDev's `planId` and `simulationDatasetId`. |
| Revision consistency | A view names the plan revision and the dataset's `plan_revision`. A dataset of an older revision is reported as `stale`. Only what it recorded is shown, never mixed with current directives or goal inputs. A dataset id belonging to another plan is refused. |
| Explore | The client sends the revision it was looking at (`expectedRevision`); a plan that has changed since is refused. Then:<ol><li>`duplicate_plan` copies the plan, including its scheduling and constraint specifications, and points each goal-created directive at the branch's own goal invocation (needs the plandev fix below).</li><li>The branch gets the `mmgis-exploring` plan tag.</li><li>The adapter goals' arguments are merged with the map's inputs. A goal the spec lacks is appended; two invocations of one goal are refused.</li><li>The whole scheduling specification runs; each goal's `ActivityAutoDelete` replaces its own earlier output. Then the branch is simulated.</li></ol>The source plan is never written. |
| Update | Only for a plan with the `mmgis-exploring` tag, and not while a run is in flight; the same steps 3–4 on the same plan. Its earlier simulations stay listed by dataset id and plan revision. |
| Keep | Removes the tag. The plan stays an ordinary plan and can still be branched from, but is never changed again by the integration. |
| Lineage | The plan's `parent_id`, plus the revision of the snapshot `duplicate_plan` took (the source revision at derivation). |
| Evaluate | Reads the plan's dataset, calls the adapter's `evaluate`, and writes nothing. |

Routes are mounted under `/api/plandev/`:

| Route | Purpose |
|---|---|
| `missions/:key/config` | Mission configuration. |
| `missions/:key/plans` | Every plan of the mission's model: lineage, working-branch flag, latest simulation. Clients poll it to refresh views and layers when a plan's simulation changes. |
| `plans/:id?simulationDatasetId&mission` | The plan view. |
| `plans/:id/geojson` | The plan's features as GeoJSON. |
| `POST plans/:id/explore {mission, targets, params, label, expectedRevision}` | New working branch from the plan. |
| `POST plans/:id/update {mission, targets, params, expectedRevision}` | Re-run a working branch with new inputs. |
| `POST plans/:id/keep` | Stop treating a plan as a working branch. |
| `POST plans/:id/evaluate {mission, simulationDatasetId, targets, params}` | Read-only evaluation. |

To revise a plan's spatial inputs, use *Copy the plan's goal inputs to a new Draw file*, then edit the file with the Draw tool. Each copied feature keeps the plan's target id in `properties.targetId`, so a site that is kept or moved keeps its id across revisions.

## Embedded mode (PlanDev UI side)

The plan page's *External Application* panel (`IFrame.svelte` in plandev-ui) posts `plandev.embed.v1` context to its iframe:

- `planId`, `planRevision` (the live revision subscription), `simulationDatasetId`.
- `timeMs`, the timeline time cursor.
- `selectedActivityDirectiveId`, `selectedSpanId`.

Posts go to the iframe src's origin only, at most one every 100 ms.

The panel accepts four requests, and only from that iframe at that origin: `ready`, `setTime`, `select`, and `openPlan`. `openPlan` navigates to another plan and keeps the current view; the iframe and the MMGIS tool's state survive the navigation. No credentials or simulation results cross the bridge; MMGIS fetches the view with its own session.

On the MMGIS side the bridge runs only when MMGIS is framed by an origin listed in the PlanDev tool's `embedOrigins` variable. MMGIS's `FRAME_ANCESTORS` must allow that origin too.

What MMGIS shows, with no tool panel opened:

- **The map and one card.** MMGIS's own interface (top bar, toolbar, coordinates, tool panel) is hidden while embedded; *Map tools* on the card brings it back. The card shows:
  - the plan, and whether it is an alternative;
  - where each tracked entity is at the cursor, with *follow*;
  - the selected feature's details and any constraint window it overlaps;
  - the headline metrics, with differences from a compared plan;
  - constraint violations (click one to move the cursor there);
  - the mission's data overlays (rover: the terrain grid, with legend and a value under the pointer);
  - *Compare with* (default: the plan it was derived from), whose route is drawn in orange;
  - *Try a change…* (below).
- **Time:** features dim until they start. The position is the latest simulated sample at or before the cursor, not interpolated:
  - MRO: 30 s `subSCBodies_MARS_*` samples, with a ±45 min sampled-track window and the in-view circle.
  - Hopper: `hopper.latitude/longitude`, which change when a hop lands.
  - Rover: `rover.latitude/longitude`, which change at each waypoint.
- **A second plan's entities:** add `plandevAlso=<plan id>` to the iframe URL, for example a rover plan with the MRO plan. The plan must be on the same body.
- **Timeline → map:** a selection in the timeline selects the activity's `primary` feature.
- **Map → timeline:** clicking a feature selects its span or directive in PlanDev and moves the cursor to the activity's start. Clicking near a shown position sample moves the cursor to that sample.
- **Plan or dataset change:** the features reload. The map fits once per plan; it never recentres while you explore unless *follow* is on.
- **Try a change…** edits the open plan's goal inputs on the map: drag sites, add sites or regions to avoid, set priorities and the goal parameters.
  - *Check current plan* is read-only (the adapter's `evaluate`).
  - *Plan alternative* branches the plan (`explore`), and PlanDev opens the branch. On a branch, *Re-plan* updates it in place.
  - When the run's simulation is ready, the card asks PlanDev to show it (`showSimulation`). *Keep as plan* ends the exploration.

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
| Goals | `ScheduleTargetObservations`: closest SPICE sub-spacecraft pass per target, if within `maxGroundDistanceKm`. It does not check footprint coverage. | In spec order: `ScheduleHopTraverse` hops to each site, in the drawn order or nearest-next; each hop is followed by a rest and an image. Then `ScheduleStorageDownlinks` simulates the plan and adds `Downlink` passes in free contact windows wherever onboard storage would pass its limit (the latest free window before the overflow, repeated). Contact windows are an explicit assumption: 1 h every 4 h from 02:00. |
| Map | Targets (input); observation track; ±15 min track; target ↔ closest-sample line (analysis) | Sites (input); the location at plan start; hop legs (illustrative: straight segments between simulated take-off and landing locations); image points |
| Table | Per observation: target, start, closest 30 s sample distance, SOC at end, data written | Per leg: destination, start, distance (from the odometer), hop duration, SOC after |
| Metrics | Min SOC, final onboard data, observation count | Distance hopped, traverse duration, hops, images, min SOC, peak storage (% full), data written, downlink passes, data downlinked (`onboard.removedVolume`), data still onboard |
| Constraints | None configured | `MinBatterySOC` at 80 %, and `OnboardStorageFull` at 99 % (data beyond capacity is lost). Both come from the plan's spec, which `duplicate_plan` copies to each branch. |
| Read-only evaluation | — | For Draw points: was a simulated landing within *r* km, and was the site imaged? For polygons: simulated landings inside, and hop legs that cross. Leg crossings assume straight legs and are labelled as an assumption. |

Hopper hop timing is **illustrative**: 60 s plus the distance at 50 m/s. It is implemented once, in `hopper.HopModel`, and both `PerformHop` and the goal call it.

The hopper's sizing is also illustrative, set as plain sim configuration and goal constants, so that route choices change simulated outcomes:

- **Power:** a 2 m² array and a 10 Ah battery. With the model defaults, the array would out-produce the 1000 W hop load.
- **Downlink:** 2 Mbit/s playback during a Downlink pass.
- **Data rates:** 20 Mbit/s imaging and 0.2 Mbit/s hop telemetry.
- **Storage:** 10 Gbit.

On *Reiner Gamma ops (existing plan)*, which has hand-placed DSN passes at 06:00 and 30:00, adding a fourth site fills onboard storage before the first pass (an `OnboardStorageFull` violation). Two revisions avoid it at different costs:

- dropping a site: shorter route, fewer images;
- shorter imaging: all sites, less data per site.

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
   # rover (see examples/11-rover/README.md); its plans also use the hopper's MinBatterySOC and OnboardStorageFull jars
   ./gradlew :examples:11-rover:build :examples:11-rover:scheduling:compileJava :examples:11-rover:constraints:compileJava
   ./gradlew :examples:11-rover:scheduling:buildSchedulingProcedureJar_ScheduleTraverse :examples:11-rover:constraints:buildAllConstraintProcedureJars
   ```
2. **PlanDev v4.5.0** with the kernels mounted. Pass `-f deploy/plandev-spice.override.yml` on top of plandev's `docker-compose.yml`, with `SPICE_KERNELS_PATH=<abs path>/spice-kernels`. With `pd`:
   ```bash
   pd stack new mmgis --plandev <plandev v4.5.0 checkout> --build --empty
   # add "extraComposeFiles": ["<override with absolute path>"] to the stack in ~/.pd/registry.json
   pd stack up mmgis
   pd new mmgis-ui --from v4.5.0 --backend mmgis && pd up mmgis-ui     # PlanDev UI on :3111
   ```
   Embedded mode needs the plandev-ui branch `feat/embedded-app-bridge` in that UI checkout.

   **Two plandev fixes are needed** (both on top of v4.5.0):
   - `fix/procedural-directives-skip-children`: on stock v4.5.0, a procedural goal that calls `plan.simulate()` fails with `id(...) must not be null` on any plan with an activity that spawns children (the hopper's Downlink spawns PlaybackData and DeleteData). Build the scheduler worker from it, for example with `pd stack rebuild mmgis sw1`.
   - `fix/duplicate-plan-scheduling-provenance`: `duplicate_plan` copies the scheduling and constraint specifications and remaps goal provenance, so goals replace their own output on a branch. It is database-only (migration 41): apply its `up.sql` to the stack's database.
3. **Seed PlanDev** (uploading a model needs `aerie_admin`; nothing else does):
   ```bash
   PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=http://localhost:31021 PLANDEV_HASURA_URL=http://localhost:31020 \
   PLANDEV_USERNAME=mmgis-planner PLANDEV_PASSWORD=… node integrations/mmgis/scripts/setup-plandev.js   # [mro] [hopper] [rover]
   ```
   The script prints `PLANDEV_<MISSION>_BASE_PLAN_ID`; goals are found by name. The base plan identifies the mission model and is the default plan to show; any plan of that model can be used. Setup is idempotent by name. To upload a rebuilt goal jar as a new goal version, run it with `UPDATE_GOALS=1`.
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
   PLANDEV_HOPPER_BASE_PLAN_ID=…
   PLANDEV_ROVER_BASE_PLAN_ID=…     # optional: PLANDEV_ROVER_DATA_DIR if the plugin is installed away from this repo (default: examples/11-rover resources)
   PLANDEV_UI_URL=http://localhost:3111
   ```
5. **Missions:** for the Jezero basemap, cut the USGS CTX orthomosaic into tiles first: `examples/11-rover/data/build-jezero-data.sh <MMGIS>/Missions/Jezero-PlanDev/Layers/CTX`. Then run `MMGIS_ADMIN=admin MMGIS_ADMIN_PASSWORD='…' MMGIS_SETUP_CODE=… node integrations/mmgis/scripts/setup-mmgis.js`. The PlanDev tool's `embedOrigins` in `mission/*.config.json` must list the PlanDev UI origin.
6. **Standalone:** open `http://localhost:8889/?mission=Mars-PlanDev` (or `Moon-PlanDev`, `Jezero-PlanDev`) and sign in. In the **PlanDev** tool, choose a plan, then:
   1. **Explore:** click *Copy … goal inputs to a new Draw file*. Move, add or delete points in that file with the **Draw** tool, then reload the file in the PlanDev tool. Tick the inputs, set the parameters, and click **Explore alternative from #N**. On the working branch, change inputs and click **Update exploration #N** as often as needed; **Keep #N as plan** ends it, and **Explore another** starts a second branch. Embedded, PlanDev opens the new branch and switches to each new simulation.
   2. **Evaluate:** pick a Draw file with points or polygons, tick them, and click **Evaluate**.
   3. **Compare:** tick plans to compare them, and use the eye icons to overlay their routes.
7. **Embedded:** in a PlanDev plan, set a grid panel to *External Application* with `http://localhost:8889/?mission=Mars-PlanDev` (or `Moon-PlanDev`, `Jezero-PlanDev`), then save the view. `mission/Jezero-PlanDev.view.json` is such a view for the rover.
   1. Sign in to MMGIS once in the same browser.
   2. Click the timeline's time-cursor lane (under the time axis) to place the cursor, and drag it to scrub.
   3. Select activities in the timeline or tables, or click features on the map.
   4. The PlanDev tool inside MMGIS follows the open plan. *Open in PlanDev* on a compared plan switches PlanDev to it.

   PlanDev views hold their timeline rows and their iframe URL, so in practice each mission needs its own view.

The installed plugin is a copy: after editing the plugin, run `npm run plugins -- uninstall plandev` and then install again. Restart MMGIS for backend changes.

Tests:
- `node --test integrations/mmgis/test/*.test.js`
- `./gradlew :examples:05-orbiter:scheduling:test`: the MRO pass search against the real kernels.
- `./gradlew :examples:04-hopper:scheduling:test`: route ordering and `HopModel`.
- `./gradlew :examples:11-rover:scheduling:test`: routing over terrain, slope limit, avoid regions, recharge splits, deadline trade-offs, and the shipped grid separating the objectives.

## Prototype limits

- **Identity:** a single service identity (`PLANDEV_USERNAME`) owns every branch. The MMGIS username is recorded only in the plan description.
- **Authorization:** planning is gated on `draw.use`, which any signed-in MMGIS user has.
- **Process:** scheduling and simulation run in a promise inside the MMGIS process. Status is re-read from PlanDev, so a restart mid-run leaves a branch scheduled but not simulated (shown *stale*). The working-branch flag is a plan tag, so it survives restarts; the panel's own state survives page reloads in the tab only.
- **Revising directives the user edited:** directives keep their source goal invocation after manual edits. A goal-created directive that was edited by hand is therefore still replaced on the next update.
- **Historical inputs:** an earlier simulation of a branch shows what it simulated (spans, profiles, metrics, constraints), not the goal inputs that produced it: `scheduling_goal_analysis.arguments` exists but the scheduler leaves it empty.
- **Revision check:** the source revision is checked just before `duplicate_plan`, not atomically with it.
- **Evaluation geometry:** planar lon/lat, which suits site-scale regions away from the poles and the antimeridian.
- **Layers:** result layers are session-only (`mmgisAPI.addLayer`).
- **Selection in MMGIS:** fires MMGIS's click pipeline, so the Info panel updates too.
- **Positions:** the map shows positions only where the model simulates them:
  - MRO: 30 s samples.
  - Hopper: landing locations only, with no in-flight position.
