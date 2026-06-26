# Configuration

YAML, validated with zod. Pass with `--config <path>`; omit for built-in
defaults. See `config/ephem.yaml` for a complete annotated example.

## Top level

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `dataDir` | string | `./data` | SQLite db (`ephem.db`) + raw files (`raw/`). |
| `concurrency` | int | `8` | Max concurrent resources in flight. |
| `storage.adapter` | `flatsql` \| `postgres` | `flatsql` | Storage backend (FlatSQL FlatBuffer archive; no SQL). |
| `interpolation.defaultInterpolator` | string | `hermite` | Interpolator module tag for `getState`. |
| `interpolation.defaultOrder` | int | `8` | Default interpolation order. |
| `sources.<id>` | object | — | Per-source overrides (below). |

## Per-source (`sources.<id>`)

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | Include this source in `refresh`. |
| `limit` | int \| null | `null` | Cap resources discovered per refresh (null = all). |
| `timeoutMs` | int | `60000` | Per-request timeout. |
| `retryCount` | int (≥5) | `5` | Retries after the first attempt. Minimum 5. |
| `rateLimitPerSec` | number | `0` | Requests/second to the source host (0 = unlimited). |
| `pollIntervalSec` | number | `0` | Scheduled polling interval (0 = manual only). |

A source omitted from `sources` uses these defaults.

## Environment variables

| Variable | Effect |
| --- | --- |
| `EPHEM_LOG_LEVEL` | pino level (`debug`, `info`, `warn`, …). Default `info`. |
| `EPHEM_JSON=1` | Force JSON logs (disables pretty output and progress bars). |
| `EPHEM_WASMEDGE` | Path to the `wasmedge` binary (default: `wasmedge` on PATH). |
| `EPHEM_WASMEDGE_LIB` | WasmEdge library dir (default: `~/.wasmedge/lib` + Homebrew). Restored into `DYLD_/LD_LIBRARY_PATH` for spawned `wasmedge` children — needed because npm strips `DYLD_*` on macOS. |

## Credentials (`.env`)

Optional. Copy `.env.example` to `.env` (git-ignored) and fill in. Only the two
authenticated sources need these; all other sources are anonymous. Real
environment variables take precedence over `.env`.

| Variable | For | Notes |
| --- | --- | --- |
| `SPACETRACK_IDENTITY` / `SPACETRACK_PASSWORD` | `space-track` source | Free account at space-track.org. |
| `SPACETRACK_GROUPS` | `space-track` | Object-name patterns (default `KUIPER,IRIDIUM,ORBCOMM,BLUEWALKER,BLUEBIRD`). |
| `SPIRE_API_KEY` | `spire` source | Bearer key from Spire (commercial; no self-serve signup). |
| `SPIRE_ENDPOINTS` | `spire` | Paths to fetch (default `/ephemeris,/tle`). |

When a credential is absent the corresponding source's `discover()` returns
nothing and is skipped — no error.

## CLI overrides

- `--limit N` overrides `sources.<id>.limit` for the refresh.
- `--source <id>` refreshes a single source.
- `--no-progress` forces structured-log output instead of the progress UI.
