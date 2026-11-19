# PlanDev ↔ Cosmolabe (prototype)

A 3D mission view inside PlanDev: the Cosmolabe workspace is mounted directly in a PlanDev plan panel
(`mountCosmolabe` from `@cosmolabe/viewer`, no iframe), loads the scene for the plan's mission model, follows
PlanDev's time and activities, and lets the operator propose a target location and time window back to
PlanDev. **Cosmolabe explores; PlanDev decides.** A proposal is only staged into a mission scheduling goal's
arguments; the goal, with the mission model's own kernels, decides whether an observation can be planned.

The PlanDev side is the `CosmolabePanel` grid panel ("3D Mission View") on the `plandev-ui` branch
`feat/cosmolabe-panel`. This directory holds everything mission-specific.

| Path | What |
| --- | --- |
| `missions/index.json` | Mission model name → catalog + adapter. The only mission lookup PlanDev does. |
| `missions/mro/catalog.json` | MRO scene: Mars, MRO from `mro_psp.bsp` — the kernel files `examples/05-orbiter` itself loads (`spice-kernels/`). No CK, FK or IK: MRO has no attitude or instrument geometry here, and the scene says so. |
| `missions/mro/adapter.js` | Which scene object PlanDev activities belong to (MRO), and how a proposal becomes a `ScheduleTargetObservations` target (GeoJSON Point + `properties.window` + provenance). |
| `serve.mjs` | Zero-dep static server (CORS) for `missions/`, `spice-kernels/` and Cosmolabe's shared scene data (Mars texture, place names). |
| `test/mro.test.mjs` | Adapter and server tests: `node --test integrations/cosmolabe/test/*.test.mjs`. |

## Run it

1. PlanDev stack with the MRO model, SPICE kernels mounted (see `integrations/mmgis/README.md`), then upload the
   goal revision and create the demo plan *MRO orbit ops (Cosmolabe demo)* (the 48 h MarsSat plan + the goal):

   ```sh
   ./gradlew :examples:05-orbiter:scheduling:buildSchedulingProcedureJar_ScheduleTargetObservations
   UPDATE_GOALS=1 PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=… PLANDEV_HASURA_URL=… \
     PLANDEV_USERNAME=… PLANDEV_PASSWORD=… node integrations/mmgis/scripts/setup-plandev.js mro
   ```

2. `COSMOLABE_DATA=<cosmolabe>/apps/viewer/test-catalogs node integrations/cosmolabe/serve.mjs` (`:8890`).
3. Cosmolabe embed package: `npm run build:embed && (cd apps/viewer && npm pack)` in a Cosmolabe checkout; the
   UI branch depends on that tarball by path (`package.json`), so adjust the path for your checkout.
4. PlanDev UI: `PUBLIC_COSMOLABE_MISSIONS_URL=http://localhost:8890/missions/index.json` in `.env.local`.
   Open the plan, pick **3D Mission View** from any panel menu.

## Workflow

1. PlanDev → 3D: the time cursor, the selected simulation's activities (as Cosmolabe host activities, ids
   `plandev:plan/<plan>/dataset/<dataset>/span/<span>`) and the selected activity (also moves the cursor to it).
2. 3D → PlanDev: viewer-driven time (keys, playback, Event Finder results) moves PlanDev's cursor; selecting a
   PlanDev activity in the 3D view selects it in PlanDev. Selecting Mars or MRO selects nothing in PlanDev.
3. Pin a surface point (point probe). The panel shows it as planetocentric lat / east lon in `IAU_MARS`
   (converted from the body-fixed point; a terrain hit reports geodetic latitude). The window is the cursor
   ± N minutes, or the selected Event Finder result (e.g. an eclipse from the viewer's own GF search).
4. **Stage** appends the target to the plan's `ScheduleTargetObservations` arguments, with
   `rejectUnscheduled: true` and provenance (`source.app`, how the location/window were chosen, plan and dataset).
5. **Run scheduling** (or PlanDev's own Scheduling panel). The goal searches that window with the model's
   kernels. Accepted: a `TakeRadarObservation` named `TargetObs <id>` (it shows in the 3D view after the
   scheduler's simulation). Rejected: the run fails with the goal's reason (out of plan, no ephemeris coverage,
   or the closest pass and the limit), and the plan is unchanged.

Goal extension (`ScheduleTargetObservations`): a feature's optional `properties.window {start, end}` narrows
its search (must lie inside the plan), and `rejectUnscheduled` (default false, so MMGIS behaviour is unchanged)
fails the run on any target it cannot schedule.

## Generic vs mission-specific

- **Generic PlanDev panel** (`plandev-ui`): mission lookup by model name, viewer lifecycle (one mount, dispose on
  panel removal/navigation, refusal of a second concurrent panel), expand/restore via the existing grid
  expansion, UTC↔ET with Cosmolabe's leap-second conversion, cursor/activity/selection sync, proposal display,
  staging into a named goal's arguments, outcome from the plan's directives and latest scheduling request.
- **Cosmolabe** (unchanged `main`): rendering, navigation, probe, Event Finder, coverage/availability.
- **Mission adapter** (here): catalog and kernels, vehicle/body, goal name, GeoJSON encoding, coordinate
  convention, directive naming. **Mission goal**: the authoritative geometry and rejection.

## Limitations

- MRO's attitude, instrument pointing and footprints are not available (no CK/IK loaded); nothing is drawn as a
  stand-in. The goal is a closest sub-spacecraft pass search, not footprint coverage.
- The 3D trajectory is from the kernels, not from the simulation. The simulation's `subSCBodies_MARS_*`
  resources are not shown in 3D.
- Outcome matching relies on the goal's directive naming and on the reason text naming the target.
- The goal reports a rejection by failing the whole run (procedural goals cannot report "unsatisfied" with a
  reason), so one bad target blocks the others until it is removed.
- The UI depends on a locally packed `@cosmolabe/viewer` tarball (~2 MB; scene load ~10 s, dominated by the
  157 MB `mro_psp.bsp`).
