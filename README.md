# ephem — public satellite ephemeris archive (isomorphic WASM compute)

`ephem` automatically **fetches, normalizes, validates, archives, and serves**
high-accuracy public satellite ephemerides, producing artifacts suitable for
downstream **Tudat propagation, covariance generation, and VCM creation**.

Its defining property: **all compute lives in isomorphic C++ → WebAssembly
modules** built to [`space-data-module-sdk`](https://github.com/DigitalArsenal/space-data-module-sdk).
The same compiled `.wasm` runs under WasmEdge here, and unchanged in a browser
or any other WasmEdge host — there is **no separate TypeScript implementation**
of the parsing, validation, interpolation, or export logic. A thin Node.js /
TypeScript **host harness** does only orchestration: discovery, scheduling,
the SDK's isomorphic `http` capability, storage, config, the CLI, and the live
progress UI.

```
            ┌──────────────────────── host harness (TypeScript) ────────────────────────┐
 sources →  │  discover → fetch(http capability) → [WASM] → [WASM] → normalize → store   │
            │                                       parse    validate          (SQLite)  │
            └───────────────────────────────────────────────────────────────────────────┘
                                                     │            │
                                        AOT-compiled WasmEdge modules (also browser-ready)
```

## Requirements

- **Node.js 22+**
- **emscripten** (`emcc`) — to compile the C++ modules to WASM (via the SDK)
- **WasmEdge** (`wasmedge`) — the module runtime + AOT compiler

Storage needs no native build: it uses **FlatSQL + FlatBuffers** via the
DigitalArsenal `flatc-wasm` (pure WASM/JS).

The SDK bundles its own Emscripten (`sdn-emception`); a system `emcc` also works.

> **WasmEdge / macOS note.** WasmEdge's AOT compiler loads LLVM via the dynamic
> linker, but `npm`/`npx` strip `DYLD_*` on macOS — which silently degrades AOT
> output to a slow, broken artifact. `ephem` restores the WasmEdge library path
> (`~/.wasmedge/lib`, Homebrew lib dirs) for every `wasmedge` child it spawns, so
> `npm run build:modules` works regardless. Override with `EPHEM_WASMEDGE`
> (binary) and `EPHEM_WASMEDGE_LIB` (lib dir) if your install lives elsewhere.

## Install & build

```sh
npm install
npm run build:modules   # compile + validate + AOT-compile every C++/WASM module
npm run build           # compile the TypeScript host
```

`npm run build:all` does both. Module artifacts land at
`src/modules/<id>/dist/isomorphic/module.wasm` (the portable, isomorphic
artifact) and `module.aot.wasm` (the WasmEdge AOT artifact used at runtime — it
makes each invocation ~100× faster than interpreting the emscripten module).

## Quickstart

```sh
# Download, parse, validate, and archive 50 live Starlink ephemerides
npx tsx src/host/cli/index.ts refresh --limit 50

# What is registered / archived
npx tsx src/host/cli/index.ts list-plugins
npx tsx src/host/cli/index.ts list-sources
npx tsx src/host/cli/index.ts list-satellites | head

# Interpolate a state vector at an arbitrary epoch
npx tsx src/host/cli/index.ts state --satellite 60309 \
  --epoch 2026-06-26T12:00:00Z --interpolator hermite

# Export the latest archived ephemeris
npx tsx src/host/cli/index.ts export --satellite 60309 --format oem
npx tsx src/host/cli/index.ts export --satellite 60309 --format csv -o sat.csv
```

After `npm run build`, the `ephem` bin is available (`dist/host/cli/index.js`).

## CLI

| Command | Description |
| --- | --- |
| `ephem refresh [--source <id>] [--limit N] [--no-progress]` | Discover, download, parse, validate, archive. Live per-source progress bars + aggregate totals. |
| `ephem list-sources` | Configured sources and what is archived. |
| `ephem list-satellites [--source <id>]` | Archived satellites. |
| `ephem latest --satellite <NORAD> [--source <id>]` | Latest archived record. |
| `ephem state --satellite <NORAD> --epoch <ISO> [--interpolator hermite\|lagrange] [--order N]` | Interpolated state vector. |
| `ephem validate --satellite <NORAD>` | Re-run the WASM validator over the latest ephemeris. |
| `ephem export --satellite <NORAD> --format json\|csv\|oem [-o file]` | Export the latest ephemeris. |
| `ephem list-plugins` | Registered compute modules and build status. |

All commands accept `-c, --config <path>` (see [docs/configuration.md](docs/configuration.md)).

### Live progress UI

`refresh` renders one progress bar per source plus an aggregate **TOTAL** bar
(files done/remaining/total, %, ✓ stored / ⤳ skipped / ✗ failed, MB, ETA). On a
non-TTY (CI, pipes) or with `--no-progress`/`EPHEM_JSON=1` it falls back to
structured log lines driven by the same typed event stream.

## Internal model

Everything is stored in **SI units** (metres, m/s); epochs are Unix seconds in
the source's declared time system. Original metadata is preserved.

- `SatelliteEphemeris`: identity, `referenceFrame`, `timeSystem`,
  `interpolationType`, validity window, creation/publication dates, `version`,
  `states[]`, `originalMetadata`.
- `StateVector`: `epoch`, `positionMeters [x,y,z]`, `velocityMetersPerSecond [vx,vy,vz]`.

**Frames:** GCRF, ICRF, J2000, EME2000, TEME, ITRF · **Time systems:** UTC, TAI,
TT, GPS, TDB. (Starlink ephemerides are J2000 / UTC; cross-frame normalizer
modules can be added — see below.)

## Storage / archive

The archive is a **FlatSQL** append-only store of **FlatBuffer** records
(`data/archive.fsb`) plus raw files under `data/raw/` — no SQLite, no
hand-written SQL. Rows are encoded with the DigitalArsenal `flatc-wasm`, and a
parsed ephemeris is stored as a genuine **spacedatastandards CCSDS OEM**
FlatBuffer (`writeFB`/`readFB`). Each `refresh` **appends a new version and never
overwrites** a prior one; identical content (source + SHA-256) is de-duplicated.
Sources without a format parser yet are fetched and archived **raw** with full
provenance (source, URL, checksum, fetch timestamp). The whole archive persists
as a self-describing stacked-FlatBuffer file (`StackedFlatBufferStore`) and
reloads on startup. A PostgreSQL adapter can implement the same `StorageAdapter`
interface (see [docs/architecture.md](docs/architecture.md)).

## Compute modules

| Module | Kind | What it does |
| --- | --- | --- |
| `starlink-parser` | parser | SpaceX Starlink MEME `.txt` → SI state vectors + metadata |
| `validator` | validator | monotonic/duplicate epochs, NaN, altitude, velocity, orbital energy, velocity continuity |
| `interpolator-lagrange` | interpolator | windowed Lagrange of configurable order |
| `interpolator-hermite` | interpolator | cubic Hermite (position+velocity), analytic velocity |
| `exporter-csv` | exporter | state vectors → CSV (Unix + ISO epochs) |

Adding a module is purely additive — see [docs/adding-a-module.md](docs/adding-a-module.md).
Adding a data source — see [docs/adding-a-source.md](docs/adding-a-source.md).

## Programmatic API

```ts
import { EphemerisArchive } from 'ephem';

const archive = await EphemerisArchive.open({ configPath: 'config/ephem.yaml' });
await archive.refreshSource('spacex-starlink');
const state = await archive.getState(60309, '2026-06-26T12:00:00Z', { interpolator: 'hermite' });
const oem = await archive.export(60309, 'oem');
await archive.close();
```

## Testing

```sh
npm test          # vitest: wire contract, storage, http retry/backoff, WASM modules
```

The module tests invoke the **real compiled WASM modules** through the WasmEdge
harness against a checked-in Starlink fixture and golden physical checks (the
WASM module is the single source of truth). See
[docs/architecture.md](docs/architecture.md) for the SDK / WasmEdge integration
details and the `GOAL.md` for the full specification.

## Data sources

**Thirteen anonymous upstream** operator/producer feeds are wired (no
CelesTrak/Space-Track aggregators) and verified via
`npx tsx scripts/verify-fetchers.ts`: SpaceX Starlink, Eutelsat OneWeb, Planet
Labs, ISS (NASA), SES, Intelsat, Telesat, CSS/Tiangong, GPS + GLONASS precise
SP3, **ESA POD** (multi-GNSS + Swarm + CryoSat-2), **EUMETSAT** (Metop/NOAA/
Sentinel), and **CPF** laser-ranging predictions — none require a login. Plus
four **credentialed** sources, inert until their `.env` keys are set:
**Spire** (API key), **Space-Track** (login — covers Kuiper/Iridium/ORBCOMM/AST,
which have no upstream feed), **JSC Vimpel** (login), and **EDC** (login — full
ILRS CPF laser-target set). This covers the full CelesTrak Supplemental operator
set via upstream feeds — see [docs/sources.md](docs/sources.md).

## Roadmap

The architecture is built for breadth along established, documented patterns:
format parser modules for the already-fetched sources (CCSDS OEM, SP3, OneWeb
LTEF, SES I11, Intelsat ECF — OMM/TLE needs an SGP4 propagator module), so those
flow through the full parse → validate → normalize pipeline; cross-frame
normalizer modules (e.g. TEME→GCRF); covariance retention; and the PostgreSQL
storage adapter.
