# 04 - Hopper (Lunar Hopper)

A small, complete **lunar hopper** mission model that composes the `power` and `data`
building blocks. This is the next step after [03-power-and-data](../03-power-and-data/):
where 03 shows the bare composition pattern, hopper is a realistic little model — with its own
activities, constraints, external events, and an external dataset — that you can read end to
end and imitate for your own mission. 

## What it models

A surface hopper that images a site, hops to a new location, and downlinks its data during
ground contacts:

- **Power** — a `SimplePEL` (power equipment list) tracks three load states and sums them into
  a total load that drives the library `BatteryModel`, fed by a library `GenericSolarArray`:

  | State | OFF | ON |
  |-------|-----|----|
  | `cameraState` | 0 W | 48 W |
  | `hopState` | 80 W (idle) | 1000 W (hopping) |
  | `telecomState` | 0 W | 25 W |

  Geometry is intentionally simplified (constant 1 AU from the Sun, array Sun-facing, no
  eclipse). The orbiter (next example) adds real SPICE geometry.

- **Data** — two prioritized onboard storage bins (library `Data`), a 10 Gb default storage
  limit, and a 10 Kbps default playback rate (both `Configuration` parameters).

- **Location** — `hopper.latitude` / `hopper.longitude` (Moon, planetocentric degrees, starting at the
  `landingLatitude` / `landingLongitude` configuration) and `hopper.odometerKm`. They change only when a
  `PerformHop` with a destination lands. Hop timing is **illustrative** — `HopModel`: 60 s + distance at
  50 m/s — with no terrain, illumination or propellant model.

## What's new vs. 03-power-and-data

- A real mission flavor with three activities that each drive **both** subsystems.
- A **constraints** subproject (`MinBatterySOC`; `OnboardStorageFull`, violated while storage is at or above a fraction of capacity).
- A **scheduling** subproject: `ScheduleHopTraverse` takes GeoJSON sites (in order, or nearest-next) and
  plans a hop + rest + `TakePicture` per site from the simulated start location, using the same
  `HopModel` as the simulation. Images are written at an illustrative 20 Mbit/s and hops at 0.2 Mbit/s.
  Its `ActivityAutoDelete` replaces the traverse that the same goal invocation created on an earlier run.
  Used by [integrations/mmgis](../../integrations/mmgis/).
- **External events** (DSN ground contacts) and an **external dataset** (lunar Sun/Earth
  elevation) — the kinds of real-world inputs a mission planner schedules against.

## Activities

| Activity | Power effect | Data effect |
|----------|--------------|-------------|
| `TakePicture` | camera ON for the duration | writes science data into an onboard bin at `dataRateBps` |
| `PerformHop` | hop ON (1000 W) for the duration; with `toSiteId` set, flies to (`toLatitude`, `toLongitude`) and the duration comes from `HopModel` | writes telemetry data into an onboard bin |
| `Downlink` | telecom ON for the duration | spawns the library `PlaybackData`, then `DeleteData` on all bins when done |

`TakePicture` and `PerformHop` use `Bucket.receive(rate, duration)` — a blocking call that
turns the bin's receive rate on, accumulates data for the duration, then turns it off
(so it both produces data and provides the activity's delay). `Downlink` reuses the library's
`PlaybackData` / `DeleteData` activities directly.

## External events & datasets

- `external-events/` — example DSN ground-contact windows (`dss24_source.json`,
  `comms_pass_schema.json`) you can upload as external events and schedule `Downlink`s against.
- `external-datasets/` — a lunar Sun/Earth elevation profile computed from SPICE
  (`generate_lunar_elevation.py` → `lunar_elevation_dataset.json`). See
  [external-datasets/README.md](external-datasets/README.md) for the math and how to regenerate.
- `hopperplan1.json` — a sample plan; `views/lunar_elevation_view.json` — a sample view.

## Build

```bash
# Mission model JAR
./gradlew :examples:04-hopper:build

# Constraint procedure JAR -- compile first, then build the per-procedure JAR
./gradlew :examples:04-hopper:constraints:compileJava
./gradlew :examples:04-hopper:constraints:buildAllConstraintProcedureJars
```

**Artifacts:**

- `build/libs/hopper.jar` — the mission model; upload directly to PlanDev.
- `constraints/build/libs/MinBatterySOC.jar`, `OnboardStorageFull.jar` — the constraint procedures.
- `scheduling/build/libs/ScheduleHopTraverse.jar` — the traverse goal
  (`./gradlew :examples:04-hopper:scheduling:compileJava` then
  `:examples:04-hopper:scheduling:buildSchedulingProcedureJar_ScheduleHopTraverse`).

> `constraints:build` alone produces a thin `constraints.jar` without bundled dependencies —
> not the artifact you upload. Use `buildAllConstraintProcedureJars` as shown above.

## Try it

1. Upload `hopper.jar` as a mission model and import `hopperplan1.json` as a plan.
2. Add a `TakePicture` (camera on, data into a bin), then a `Downlink` after it.
3. Simulate. Watch `mainbattery.batterySOC` dip during the picture and again during the hop,
   and `onboard.volume` climb then drain as `Downlink` spawns `PlaybackData` and then
   `DeleteData`.
4. Add a `PerformHop` between them — it is the 1000 W load, so its effect on SOC dominates.
5. Upload `MinBatterySOC.jar` as a constraint and run it to see where the plan violates the
   battery floor.
6. Load `views/lunar_elevation_view.json` and upload the external dataset to see the Sun/Earth
   elevation profile alongside the plan.

`./gradlew :examples:04-hopper:scheduling:test` covers the traverse ordering and `HopModel`; for model testing patterns see [10-testing-patterns](../10-testing-patterns/).
