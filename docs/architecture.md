# Architecture

Two layers, one compute implementation.

## 1. WASM compute/IO modules (the only implementation of the logic)

Each module is portable **C/C++** compiled to a single isomorphic WASM artifact
via the SDK (`space-data-module compile`). A module:

- includes the SDK-generated `space_data_module_invoke.h` and defines one
  `extern "C" int <methodId>(void)` per manifest method;
- reads inputs with `plugin_get_input_count()` / `plugin_get_input_frame(i)` /
  `plugin_find_input_index(port, ordinal)` and emits outputs with
  `plugin_push_output(port, schema, file_id, ptr, len)`;
- reports failure with `plugin_set_error(code, message)` and a non-zero return;
- declares both invoke surfaces — `direct` (`plugin_invoke_stream`) and
  `command` (WASI `_start` reading a **PIV** envelope from stdin, writing the
  PIV response to stdout) — and `runtimeTargets: [wasmedge, node, browser]`.

The host invokes modules over the **command surface**: it encodes a
`PluginInvokeRequest` (`space-data-module-sdk/invoke`), runs the artifact under
WasmEdge, and decodes the `PluginInvokeResponse` from stdout. This is exactly
what the SDK's `loadModule(...)` does internally; the host drives WasmEdge
directly so it can run the **AOT-compiled** artifact (`wasmedge compile`), which
turns ~19 s interpreted invocations into ~0.2 s.

### Wire contract

To avoid FlatBuffer/JSON codegen on the hot path, compute frames use a compact
convention (`src/host/wire.ts`):

- `meta` — UTF-8 JSON (small): frame, time system, validity, counts, confidence.
- `states` — raw little-endian `f64`, 7 doubles per state vector:
  `[epoch_unix_seconds, x, y, z (m), vx, vy, vz (m/s)]`.
- `query` (interpolators) — `f64 [order, t1, t2, …]`.

The host serializes to CCSDS at the boundary (OEM today; FlatBuffer OEM/OMM via
`spacedatastandards.org` is the documented extension point).

### The manifest is generated

Module authors write a compact `module.json`; the strict SDK `PluginManifest`
is generated from it at build time (`src/host/modules/manifest.ts`) and
validated with `space-data-module check`.

## 2. Node.js / TypeScript host harness (orchestration only)

- **Registry** (`modules/registry.ts`) — discovers `src/modules/<id>/`,
  (re)builds stale artifacts, resolves modules by kind and `provides` tag.
- **Runner** (`modules/runner.ts`) — encodes PIV, runs WasmEdge, decodes PIV.
- **Network** (`http.ts`) — the SDK **isomorphic `http` capability**
  (`createNodeHost` → `http.request`, mapped to fetch/undici/host-shim) wrapped
  with **≥5 retries, exponential backoff + jitter**, rate limiting, timeouts.
- **Pipeline** (`pipeline.ts`) — the `EphemerisFetcher` contract:
  `discover → fetch → parse(module) → validate(module) → normalize → store`,
  with a bounded concurrency pool and a typed progress event stream.
- **Storage** (`storage/`) — versioned, never-overwriting **FlatSQL** archive of
  FlatBuffer records behind a `StorageAdapter` interface (no SQL).
- **API / CLI** (`api.ts`, `cli/`) — the public surface and the live UI.

The host does **not** parse, validate, normalize, interpolate, or perform raw
networking itself — all of that is WASM, and networking is the SDK capability.

## Storage adapter (FlatSQL → PostgreSQL)

`StorageAdapter` (`src/host/storage/index.ts`) is the seam. `FlatSqlStorage`
implements it on **FlatSQL** with **no SQL**:

- Rows are FlatBuffers described by an `EphemRecord` schema, encoded/decoded with
  a `FlatcAccessor` driven by the DigitalArsenal **`flatc-wasm`**.
- A parsed ephemeris is stored as a genuine **spacedatastandards CCSDS OEM**
  FlatBuffer (`writeFB`) in the record's `oem` field; `load()` reconstructs SI
  state vectors via `readFB`. Raw fetches (sources without a parser) are written
  to `data/raw/` with a provenance record (kind = "raw").
- The archive is an append-only `StackedFlatBufferStore`; writes `append`, reads
  `iterateTableRecords` + decode in JS (no `SELECT`). It persists as a
  self-describing stacked-FlatBuffer file (`getData()` → `data/archive.fsb`) and
  reloads via `StackedFlatBufferStore.fromData`. `version` increments per
  `(source, noradId)`; `(source, checksum)` de-duplicates.

A PostgreSQL adapter can implement the same `StorageAdapter` methods (`store`,
`storeRaw`, `hasChecksum`, `getVersions`, `latest`, `load`, …); select it via
`storage.adapter: postgres` and wire it in `api.ts`.

## Why AOT, and the isomorphism guarantee

The portable `module.wasm` is the isomorphic artifact (browser / Node / WasmEdge
via the SDK loader). For server throughput the host runs `module.aot.wasm`
(WasmEdge native codegen) — same inputs, byte-identical PIV responses. The
`module.wasm` remains the thing you ship to a browser or another host unchanged.
