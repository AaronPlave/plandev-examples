# SPICE Kernels

Shared SPICE kernel set used by both [libraries/geometry](../libraries/geometry/) (for tests) and [examples/05-orbiter](../examples/05-orbiter/) (for simulation).

All kernel files are tracked via Git LFS (`*.bsp`, `*.tls`, `*.tpc`, `*.tf`, `*.ck`, `*.bpc`). Cloning the repo without LFS will leave you with pointer files — install Git LFS and `git lfs pull` to get the actual binaries.

## Loaded kernels (~238 MB total)

`latest_meta_kernel.tm` is the entry point — it lists which kernels load and in what order:

| File | Size | Purpose |
|---|---|---|
| `mro_psp.bsp` | 157 MB | MRO spacecraft ephemeris |
| `mar097_2020_2040.bsp` | 44 MB | Mars long-period ephemeris (2020–2040) |
| `de440s.bsp` | 31 MB | Solar-system planetary ephemeris (small variant) |
| `earth_070425_370426_predict.bpc` | 5.5 MB | Earth orientation (predict, 2007–2370) |
| `pck00011.tpc` | 128 KB | Planetary constants (shapes, rotations) |
| `earthstns_itrf93_201023.bsp` | 25 KB | DSN ground-station positions |
| `gm_de440.tpc` | 12 KB | Gravitational constants (paired with DE440) |
| `naif0012.tls` | 5 KB | Leap-second table |
| `moon_pa_de421_1900_2050.bpc` | 1.7 MB | Lunar orientation, DE421 principal axes (LRO PDS archive lrosp_1000) — examples/12-moonfall |
| `moon_080317.tf` | 22 KB | Lunar frames incl. `MOON_ME_DE421` (LRO PDS archive lrosp_1000) — examples/12-moonfall |
| `latest_meta_kernel.tm` | 1 KB | Meta-kernel (load order) |

## Usage

Code that needs these kernels reads `SPICE_DIRECTORY` (env var) or falls back to `spice-kernels` relative to the JVM working directory. Both [libraries/geometry/.../SpiceConstants.java](../libraries/geometry/src/main/java/gov/nasa/ammos/plandev/geometry/spice/SpiceConstants.java) and [examples/05-orbiter/.../Mission.java](../examples/05-orbiter/src/main/java/examples/orbiter/Mission.java) follow this convention.

## Copy-pasting libraries/geometry/ out of this repo

If you extract `libraries/geometry/` to use elsewhere, take this directory along with it — the geometry library's tests will not pass without these kernels. Either copy `spice-kernels/` to a sibling path and the relative `spice-kernels` fallback will resolve, or set `SPICE_DIRECTORY` to wherever you place them.
