# PlanDev ↔ Cosmolabe (prototype)

A 3D mission view inside PlanDev: the Cosmolabe workspace is mounted directly in a PlanDev plan panel
(`mountCosmolabe` from `@cosmolabe/viewer`, no iframe), loads the scene for the plan's mission model, follows
PlanDev's time and activities, and lets the operator find and propose an observation back to PlanDev.
**Cosmolabe proposes; PlanDev evaluates.** A proposal is only staged into a mission scheduling goal's arguments;
the goal, with the mission model's own kernels, decides whether an observation can be planned.

The PlanDev side is the `CosmolabePanel` grid panel ("3D Mission View") on the `plandev-ui` branch
`feat/cosmolabe-panel`. This directory holds everything mission-specific.

| Path | What |
| --- | --- |
| `missions/index.json` | Mission model name → catalog + adapter. The only mission lookup PlanDev does. |
| `missions/mro/catalog.json` | MRO scene: Mars, MRO from `mro_psp.bsp`, the kernels `examples/05-orbiter` loads. No CK, FK or IK: MRO has no attitude or instrument geometry here, and the scene says so. |
| `missions/mro/pck00011_n0066.tpc` | NAIF's N0066-compatible form of `pck00011.tpc` (same Mars data). See [Mars orientation](#mars-orientation). |
| `missions/mro/adapter.js` | Which scene object PlanDev activities belong to (MRO), and how a proposal becomes a `ScheduleTargetObservations` target (GeoJSON Point + `properties.window` + provenance). |
| `serve.mjs` | Zero-dep static server (CORS) for `missions/`, `spice-kernels/` and Cosmolabe's shared scene data (Mars texture, place names). |
| `test/mro.test.mjs` | Adapter, catalog and server tests: `node --test integrations/cosmolabe/test/*.test.mjs`. |

## Run it

1. PlanDev stack with the MRO model, SPICE kernels mounted (see `integrations/mmgis/README.md`), then upload the
   goal revision and create the demo plan *MRO orbit ops (Cosmolabe demo)* (the 48 h MarsSat plan + the goal):

   ```sh
   ./gradlew :examples:05-orbiter:scheduling:buildSchedulingProcedureJar_ScheduleTargetObservations
   UPDATE_GOALS=1 PLANDEV_ROLE=aerie_admin PLANDEV_GATEWAY_URL=… PLANDEV_HASURA_URL=… \
     PLANDEV_USERNAME=… PLANDEV_PASSWORD=… node integrations/mmgis/scripts/setup-plandev.js mro
   ```

2. Mission scene server (`:8890`). It also serves Cosmolabe's shared scene data (Mars texture, place names) from
   a Cosmolabe checkout; the one the UI build step below creates will do:

   ```sh
   COSMOLABE_DATA=<plandev-ui>/.cosmolabe/<commit>/apps/viewer/test-catalogs node integrations/cosmolabe/serve.mjs
   ```

3. PlanDev UI (`plandev-ui`, branch `feat/cosmolabe-panel`). `@cosmolabe/viewer` is not published; the UI pins
   it to a Cosmolabe commit and builds it from the public repository:

   ```sh
   scripts/cosmolabe-viewer.sh   # clones AaronPlave/cosmolabe at the pinned commit into .cosmolabe/, builds the
                                 # embed package, packs it to vendor/cosmolabe-viewer-0.1.0.tgz (both gitignored)
   npm ci                        # package-lock.json pins that tarball's sha512: a different build is refused
   echo 'PUBLIC_COSMOLABE_MISSIONS_URL=http://localhost:8890/missions/index.json' >> .env.local
   npm run dev
   ```

   The build is deterministic for a commit (two clean builds give the same tarball). To move to another
   Cosmolabe commit, change `COSMOLABE_COMMIT` in the script, rerun it and `npm install` (which updates the
   lockfile's integrity). `COSMOLABE_SRC=<checkout>` builds from an existing clean checkout instead of cloning.

4. Open the plan, pick **3D Mission View** from any panel menu.

## Workflow (operator)

1. **Explore.** The scene follows PlanDev's time cursor and shows the selected simulation's activities (host
   activities `plandev:plan/<plan>/dataset/<dataset>/span/<span>`). Time moved in the 3D view moves PlanDev's cursor.
2. **Location.** Pin a point with the point probe. The panel shows it as planetocentric lat / east lon in
   `IAU_MARS`, converted from the body-fixed point. A terrain hit reports geodetic latitude.
3. **Find a pass.** *Find MRO passes* searches an explicit UTC range (default: the plan) for local closest
   approaches of MRO's ground track to the pin: `getObjectState` of the vehicle in the body frame from the scene's
   own kernels, sampled every 30 s and refined to 1 s, distances on the goal's sphere. Up to five candidates,
   closest first, labelled exploratory. Ranges without MRO position say so and produce no candidates. Choosing a
   candidate moves both clocks there (the camera stays put; *Show* looks at the pin) and makes the window
   *pass ± N min*. An Event Finder result selected in the 3D view can be the window instead, labelled as not
   specific to the location.
4. **Propose.** Known-invalid input cannot be staged: window outside, partly outside (with an explicit *Fit
   window to plan*), empty or reversed, a missing ± duration, a location the adapter rejects, or no goal in the
   plan. *Propose to PlanDev* appends the target to the goal arguments with `rejectUnscheduled: true` and
   provenance (how the location and window were chosen). No exploratory distance is sent.
5. **Evaluate.** *Run scheduling* (or PlanDev's Scheduling panel). The goal searches the window itself with the
   model's kernels: accepted → a `TakeRadarObservation` named `TargetObs <id>`; rejected → the run fails with the
   goal's reason and commits nothing. *Edit* loads a staged target back (its location, its window) to choose
   another pass or window; *Update in PlanDev* replaces it under the same id. *Remove* takes it out.

## What the target states mean (outcome provenance)

From data PlanDev already keeps; nothing new is stored.

| State | Meaning |
| --- | --- |
| Staged | Not evaluated: no scheduling run of the current scheduling specification revision, and no observation. |
| Changed since last run | An observation from this goal exists, but the specification changed after the run that made it, so it came from earlier inputs. |
| Evaluating | The latest run evaluated the current revision and is still running. |
| Planned in run #N | The latest run evaluated exactly the current revision, succeeded, and an observation named for the target from this goal invocation exists. |
| Not planned in run #N | Same run, succeeded, no observation (the goal skipped it; with `rejectUnscheduled` it fails instead). |
| Rejected in run #N | Same run failed and its reason names this target; the existing observation, if any, is unchanged. |
| Run #N failed, not because of this target | Same run failed for another target or an error (e.g. a worker out of memory); this target was not evaluated individually. |

"Evaluated the current inputs" is exact: any goal edit bumps `scheduling_specification.revision`, and every
request records `specification_revision`. It is conservative too: an edit to *another* target also marks this
one as changed. Limits: procedural goal runs store no argument snapshot (`scheduling_goal_analysis.arguments` is
`{}`), so the panel cannot show which earlier inputs produced an existing observation; the observation ↔ target
link is the goal's directive name plus `source_scheduling_goal_invocation_id`; a rejection is attributed by the
reason text naming the target.

## Mars orientation

Cosmolabe's cspice-wasm is CSPICE **N0066**. `pck00011.tpc`'s Mars model needs **N0067** (its header says so):
loaded into N0066 it puts the Mars pole 2.25° off (Dec 55.12° instead of 52.87°). The globe, probe coordinates
and every body-fixed position were then ~2° from the coordinates PlanDev's N0067 goal uses. The catalog loads
NAIF's `pck00011_n0066.tpc` instead: its Mars data equal `pck00011.tpc` (only Phobos is reduced), and
cspice-wasm then matches N0067 exactly (verified against spiceypy, and pass times/distances now match the goal
to the second and 0.1 km). It lives here, not in `spice-kernels/`: the model furnishes **every** `.tpc` in that
directory, and it would override `pck00011.tpc` there (Mars orientation then fails with
`SPICE(INSUFFICIENTANGLES)`). Cosmolabe should move to N0067; until then any Cosmolabe scene with
`pck00011.tpc` has the same Mars error.

## Generic vs mission-specific

- **Generic PlanDev panel** (`plandev-ui`): mission lookup by model name, viewer lifecycle, expand/restore,
  UTC↔ET, cursor/activity/selection sync, the pass search (any vehicle over any body, from the adapter's names),
  window validation, staging/editing into a named goal's arguments, outcome states.
- **Cosmolabe** (unchanged, pinned commit): rendering, navigation, probe, Event Finder, geometry and availability.
- **Mission adapter** (here): catalog and kernels, vehicle/body, goal name, mean radius, GeoJSON encoding,
  coordinate convention, directive naming. **Mission goal**: the authoritative search and rejection.

## Adapters run in PlanDev's page

`missions/index.json` and the adapters are fetched from `PUBLIC_COSMOLABE_MISSIONS_URL` and imported as
JavaScript into the PlanDev UI's context, with the user's session. Only a deliberately configured, trusted URL is
used; there is no way for a user to supply one. A production deployment would need the adapters packaged and
versioned with the UI or the mission model (reviewed like code, not served loose), a check that adapter, catalog,
kernels and goal revision agree (e.g. the directive prefix and radius tests in `test/mro.test.mjs`), and a
pinned Cosmolabe version shared by the UI build and the scene data.

## Limitations

- MRO's attitude, instrument pointing and footprints are not available (no CK/IK); nothing is drawn as a
  stand-in. Both the exploratory search and the goal are closest sub-spacecraft passes, not footprint coverage.
- The exploratory search samples geometric positions every 30 s, so it can miss a pass shorter than a step; the
  goal uses LT+S and its own sampling, so they can differ by a second or a few hundred metres.
- The 3D trajectory is from the kernels, not from the simulation.
- One rejected target fails the whole run (procedural goals cannot report "unsatisfied" with a reason), so it
  blocks the others until it is fixed or removed.
- The embedded viewer hides its timeline (its activity picker), so activities are selected from PlanDev;
  Escape in the 3D view clears the selection in both.
