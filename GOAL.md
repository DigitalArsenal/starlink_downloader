# Goal

Build a **production-quality, plugin-based satellite ephemeris system** whose entire compute/IO core is a set of **isomorphic C++ → WebAssembly modules** built to **DigitalArsenal/space-data-module-sdk**, orchestrated by a thin **Node.js 22+ / TypeScript host harness**. The system automatically **fetches, normalizes, validates, archives, and serves** high-accuracy public satellite ephemerides from major operator sources, producing artifacts suitable for downstream **Tudat propagation, covariance generation, and VCM creation**.

This supersedes the existing `starlink_downloader` repo (Node `.mjs` scripts that download Starlink MEME ephemeris `.txt` files and convert them to spacedatastandards.org OEM FlatBuffers). Preserve the working Starlink fetch/parse logic, but reimplemented as a WASM module plugin — do not regress its behavior.

## Core principle: WASM-only compute, isomorphic, maximally modular

**There is no TypeScript reimplementation of any compute logic. Each functional unit is implemented once, in C++, compiled once to a single isomorphic WASM artifact, and run via the SDK harness.** The same `dist/isomorphic/module.wasm` runs unchanged in **browser, Node, and WasmEdge** (server) — no per-environment builds, no parallel TS/WASM versions to keep in sync.

Pluggable module types (each is its own standalone SDK module with manifest + canonical ABI):

- **Fetchers** (one per data source) — perform downloads via the SDK's **isomorphic `http` capability** (host shims, not raw WasmEdge sockets)
- **Parsers** (one per format: OEM, OMM, OPM, SP3, CPF, CSV, JSON, XML, TXT, …)
- **Validators** (each validation check is its own composable module)
- **Normalizers** (frame transforms, time-system conversions, unit conversions)
- **Interpolators** (Lagrange, Hermite, cubic spline, …)
- **Exporters** (json, csv, oem, …)

Requirements for the plugin system:

- A **registry/loader** discovers and registers modules by capability + declared input/output FlatBuffer types; nothing is hard-wired. Adding a provider, parser, validator, or interpolator means dropping in a new WASM module + manifest and registering it — no edits to the host or other modules.
- Each compute stage (parse / validate / normalize / interpolate / export, and fetch) is resolved from the registry at runtime. Interpolators specifically are pluggable: `getState(satelliteId, epoch, { interpolator, order })` resolves the interpolator module from the registry; new schemes plug in as standalone modules without touching the engine.
- Keep coupling minimal: stable typed FlatBuffer contracts (from spacedatastandards.org / SDK schemas), dependency-injected registry, no provider/format/algorithm names baked into the host.

## The two layers

### 1. WASM compute/IO modules (the only implementation of the logic)

Portable **C/C++** compiled to WASM via the SDK's `npx space-data-module compile` (embedded Emscripten; `single-thread` for browser/WasmEdge pairing, `emscripten-pthreads` for WasmEdge server targets). Each module:

- Treats **spacedatastandards.org as the upstream schema authority** — does **not** shadow schemas locally; generates FlatBuffer bindings from official SDS sources (e.g. via `SPACE_DATA_STANDARDS_ROOT`).
- Ships a valid **`manifest.json`** declaring `runtimeTargets: ["browser", "wasmedge", "node"]`, `invokeSurfaces` (`"direct"` and/or `"command"`), `capabilities` (e.g. `http`, `clock`, `logging`, `filesystem`), and `inputPorts`/`acceptedTypes` describing its FlatBuffer I/O contract.
- Exports the **canonical module ABI**: `plugin_get_manifest_flatbuffer()`, `plugin_get_manifest_flatbuffer_size()`, and for the direct surface `plugin_invoke_stream(req_ptr, req_len)`, `plugin_alloc(size)`, `plugin_free(ptr)`, plus output-frame setters; supports the `command` surface via the WASI `_start` entry point reading a **PIV** envelope from stdin and writing the response to stdout.
- Uses the SDK's **PIV (Plugin Invoke)** request/response envelope and **StateVector.fbs** / OEM / OMM FlatBuffer payloads as its I/O contract; supports size-prefixed FlatBuffer streaming per the SDK's FlatSQL streaming standard.
- Passes `npx space-data-module check --manifest ./manifest.json --wasm ./module.wasm`, and publishes via the `"sdn-module"` descriptor in `package.json` with the canonical artifact at **`dist/isomorphic/module.wasm`** (plus optional `dist/browser/`).

### 2. Node.js / TypeScript host harness (thin orchestrator — no compute)

Loads and invokes the WASM modules through the SDK's **isomorphic loader** — **`loadModule(...)` from `src/host/isomorphicLoader.js`** — which auto-detects command- vs. direct-surface modules and drives WasmEdge via the raw stdin/stdout command harness for standalone `_start` artifacts. All host services reach the modules through the SDK's unified async capability-adapter boundary (the same **`capabilityAdapters`** boundary shared by `NodeHost`, `BrowserHost`, `createRuntimeHost()`, `loadModule(...)`, and `createBrowserModuleHarness(...)`), keyed by canonical capability ids. The host:

- **Uses the SDK's isomorphic network callouts — it does not implement its own HTTP stack.** Networking is the SDK's canonical **`http` capability, implemented as host shims (not raw WasmEdge socket imports)**: `http` → `fetch` in the browser, fetch/undici in Node, host shim under WasmEdge. Fetcher modules make every network callout through this capability, so the **same artifact downloads identically across browser, Node, and WasmEdge**. The host supplies the default capability adapters (and may override the `http` adapter via `capabilityAdapters` only to inject policy/observability — never to replace the isomorphic mechanism).
- Wires the remaining capabilities the modules consume from the SDK's standard set: **`filesystem`**, **`clock`**, **`logging`**, and a **storage** capability.
- Runs the orchestration pipeline realizing the `EphemerisFetcher` contract (below) by invoking the registry-resolved WASM module for each stage.
- Owns infrastructure that is not ephemeris compute: the **CLI**, the **live progress UI**, **YAML config**, the **scheduler** (parallelism/polling/incremental), the **public API**, and **storage** (better-sqlite3 + Postgres adapters behind the storage capability).
- Does **not** parse, validate, normalize, interpolate, or perform raw networking itself — all of that is in WASM, and networking is the SDK's isomorphic `http` capability.

## Hard requirements / stack (host layer)

- **Node.js 22+**, **TypeScript**, `strict` type checking, ESM, `async/await` throughout.
- The Node-side adapter behind the SDK's isomorphic `http` capability uses **native `fetch`** or **undici**; the host wires the SDK's default adapters rather than building a parallel HTTP stack.
- **zod** for validating config + host-boundary data, **commander** for the CLI, **pino** for structured logging, **yaml** for config.
- Storage capability backed by **better-sqlite3** with an interchangeable **PostgreSQL** adapter behind one interface.
- **vitest** for tests.
- **`spacedatastandards.org` (latest from npm, currently 1.99.0)** for reading/writing CCSDS FlatBuffer messages at the host boundary (`writeFB`/`readFB`, `standards` namespace) — and as the shared schema authority for the WASM modules.
- **Every network file download retries at least 5 times with exponential backoff + jitter**, implemented **inside the fetcher modules around their isomorphic `http` callouts** (so retry behavior is portable across browser/Node/WasmEdge), honoring per-source rate limits and timeouts.
- **No placeholders, no TODOs, no mocked parsers, no "fill-in-later" stubs.** Complete, type-safe, production-ready, clear error handling, structured logs.

## Data sources (one fetcher module each)

SpaceX Starlink, Eutelsat OneWeb, Amazon Kuiper, Planet Labs, Spire Global, Iridium, SES, Intelsat, Telesat, ORBCOMM, AST SpaceMobile, ISS, CSS/Tiangong, GPS precise ephemerides, GLONASS precise ephemerides, CelesTrak Supplemental GP — plus any additional public operator ephemeris sources discovered during implementation. Public/unauthenticated sources work out of the box; sources needing credentials read them from config and receive them through the host.

## Architecture — `EphemerisFetcher` contract

Abstract pipeline contract (all `Promise`-returning), realized by the host invoking the appropriate WASM modules per stage:
`discover(): DiscoveredResource[]` · `fetch(resource): RawEphemerisFile` · `parse(raw): ParsedEphemeris` · `validate(parsed): ValidationResult` · `normalize(parsed): NormalizedEphemeris` · `store(normalized, raw): StoredEphemerisRecord` · `refresh(): RefreshResult`. `parse`/`validate`/`normalize` delegate to registry-resolved WASM modules; `store` uses the storage capability.

**Supported input formats (parser modules):** CCSDS OEM, OMM, OPM, (VCM future), SP3, CPF, CSV, JSON, XML, TXT, plus `zip`/`gzip` container handling.

**Internal model — `SatelliteEphemeris`:** `satelliteName, noradId, cosparId, operator, source, referenceFrame, timeSystem, interpolationType, validityStart, validityEnd, creationDate, publicationDate, version, states[]`.
**`StateVector`:** `epoch, positionMeters: [x,y,z], velocityMetersPerSecond: [vx,vy,vz]`. **Store SI units internally**; preserve original metadata alongside the normalized form.

**Frames:** GCRF, ICRF, J2000, TEME, ITRF, EME2000. **Time systems:** UTC, TAI, TT, GPS, TDB. Normalize internally, preserving the source's declared frame/time system.

## Storage

The storage capability persists, for every record: raw downloaded file, normalized JSON, metadata, checksum, source URL, fetch timestamp. Keep **historical versions** — **never overwrite previous versions**; support **multiple versions per satellite**. SQLite and Postgres adapters implement the same interface.

## Validation (validator modules → `ValidationResult`)

Monotonic epochs, duplicate-epoch detection, NaN detection, unit sanity, frame consistency, reasonable altitude, reasonable orbital energy, reasonable velocity magnitude, velocity continuity, file checksum, parser confidence score. Each check is a composable WASM module; the host runs the registered set and aggregates results.

## Interpolation API (interpolator modules)

Lagrange, Hermite, cubic spline; configurable interpolation order; `getState(satelliteId, epoch, { interpolator, order })`. Interpolators are resolved from the registry as standalone isomorphic WASM modules; new schemes plug in without engine changes.

## Public API (host)

`getEphemeris()`, `getLatest()`, `getState(epoch)`, `listSatellites()`, `listSources()`, `getVersions()`, `refresh()`, `refreshSource(sourceName)`.

## CLI (`ephem`)

`refresh` · `refresh --source spacex` · `list-sources` · `list-satellites` · `latest --satellite NORAD_ID` · `state --satellite NORAD_ID --epoch ISO_TIME` · `validate` · `export --format json|csv|oem`. Add `list-plugins` to enumerate registered modules (fetchers/parsers/validators/normalizers/interpolators/exporters) with their manifest id, version, and loaded WASM artifact.

**Live terminal progress UI.** The CLI renders a rich, real-time display during `refresh` (and any long-running op): **one progress bar per source**, updating concurrently, showing per-source files done / remaining / total, percent, throughput (files/sec or bytes/sec), ETA, retry/backoff state, and final per-source status (✓ done, ⟳ retrying, ✗ failed). Above the per-source bars, show **aggregate live counters**: sources active/complete, total files downloaded vs. remaining, total bytes, validation pass/fail tallies, overall elapsed/ETA. Use a multibar terminal renderer (e.g. `cli-progress` multibar, `ora`, or `listr2`) with graceful fallback to plain structured logging when stdout is not a TTY (CI, pipes) or when `--no-progress`/`--json` is passed. Progress events flow from the scheduler/host via a typed event stream so the UI stays decoupled from the core (and the same events drive non-TTY logs).

## Config (YAML)

Per-source: `enabled`, `pollInterval`, `timeoutMs`, `retryCount` (≥5 default), `outputDirectory`, `rateLimit`, `authentication` (when required). Plus a modules section to enable/disable modules and pin module ids/versions/artifact paths, and a storage section selecting the SQLite or Postgres adapter.

## Scheduler

Manual refresh, scheduled polling, incremental updates, parallel downloads, retry logic (≥5, backoff implemented inside the fetcher modules around their isomorphic `http` callouts), rate limiting, exponential backoff. The host scheduler controls concurrency/polling/cadence; the per-file retry/backoff is portable inside the modules.

## Testing

- **vitest** host tests: registry/loader, scheduler, config, storage (SQLite + Postgres), CLI, public API, progress event stream.
- **Module tests via the SDK harness:** invoke each compiled WASM module through `loadModule(...)` against **real public files** and **golden fixtures** (incl. the existing Starlink MEME samples), asserting exact FlatBuffer / normalized output. No TS reimplementation to diff against — the WASM module is the single source of truth, validated against checked-in golden outputs.
- **Isomorphism check:** the same artifact passes its fixtures under both the Node and WasmEdge harness paths.
- `npx space-data-module check` runs for **every** module in CI; include a WasmEdge runtime smoke test.

## Documentation

README; per-source documentation; parser documentation; configuration reference; "how to add a new provider/module (fetcher/parser/validator/normalizer/interpolator/exporter)"; and a "how to build, compile, and run the C++/WASM modules" guide covering compilation via `space-data-module compile`, the manifest, the canonical ABI, host capabilities, isomorphic loading via `loadModule(...)`, and SDK compatibility/publication.

## Definition of done

A complete Node.js/TypeScript **host harness** that maintains a local, versioned archive of public high-accuracy satellite ephemerides (SI units, normalized frames/time systems, full provenance) suitable for Tudat propagation, covariance estimation, and VCM generation — where **all fetch/parse/validate/normalize/interpolate/export logic lives exclusively in isomorphic C++/WASM `space-data-module-sdk` modules** loaded via `loadModule(...)` and runnable unchanged in browser, Node, and WasmEdge. All network access goes through the SDK's **isomorphic `http` capability** (host shims, not raw sockets), with **≥5 retries + backoff implemented inside the fetcher modules** so the same artifact downloads identically in browser, Node, and WasmEdge. Each module passes `space-data-module check` and golden-fixture tests through the SDK harness. The host provides only orchestration: registry, scheduler, the SDK's standard capability adapters (`http`/`filesystem`/`clock`/`logging`/`storage`), storage, YAML config, public API, CLI, and the live progress UI. No placeholders, fully typed, structured logging.
