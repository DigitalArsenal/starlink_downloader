# Reused orbpro-stack modules

Interpolation and propagation are **not** reimplemented here — the host invokes
the existing SDN modules from `orbpro-stack` (sibling repo). They're registered
as external modules (`src/host/modules/external.ts`), AOT-compiled into
`.external-cache/`, and invoked over the standard PIV protocol like any module.

| Our role | orbpro-stack module | method | contract |
| --- | --- | --- | --- |
| interpolator (`bspline`, default) | `foundation/math-bspline` | `interpolate_bspline` | `$BSP` — waypoints (T, X1/X2/X3) → resampled position + first derivative (velocity) |
| interpolator (`linear`) | `foundation/numerics` | `interpolate_scalar` | `$NUM` — linear/bilinear scalar |
| propagator (`sgp4`) | `propagator/sgp4` | `ingest_omm` → `propagate_state` | OMM/TLE → `PropagatorState` (TEME, m, m/s) |

`getState(noradId, epoch)` builds a local window of state-vector waypoints, asks
math-bspline for a dense resample, and reads the value+velocity nearest the query
epoch (verified ~1 m / 0.001 m/s at a node on Starlink data).

## SDK version alignment

orbpro-stack's prebuilt modules use the **`$PIV`** invoke envelope (SDK **0.8.5**);
npm's 0.8.4 uses `PINQ`/`PINS` and is wire-incompatible. So this package depends
on orbpro-stack's local SDK:

```json
"space-data-module-sdk": "file:../orbpro-stack/repos/ancillary-packages/space-data-module-sdk"
```

Our own C++/WASM modules are compiled against the same 0.8.5, so everything
speaks one protocol. Point `ORBPRO_MODULES_DIR` at the modules directory if your
checkout differs. The `$BSP` FlatBuffer bindings are vendored from orbpro-stack's
`spacedatastandards.org` into `src/host/vendor/sds-bsp/` (npm
spacedatastandards@1.99.0 doesn't ship `$BSP`).

## Notes

- math-bspline and numerics AOT-compile cleanly (fast). `sgp4` currently fails
  WasmEdge AOT (`malformed section id`) and runs interpreted (slow but
  functional) — it's used only for TLE/OMM propagation.
- If orbpro-stack isn't checked out, these modules are skipped with a warning;
  `getState` then needs an interpolator and will report one is unavailable.
