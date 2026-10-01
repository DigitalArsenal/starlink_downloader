# Operator ephemeris GETTER + PROCESS prototype

```sh
npm ci --prefix test-retriever
node test-retriever/bin/retrieve.mjs --limit 10 --out /tmp/operator-od-run
node --test test-retriever/test/*.test.mjs
```

Node 22+; this folder has its own lockfile and uses only published npm packages:
SDK 0.8.24, SDS 1.228.0, FlatBuffers 25.9.23, and fflate 0.8.3 (in-memory ZIP containers). It does not import the legacy host
or its file-linked SDK dependency. No native module build is necessary.

CLI: `--source <id>` is repeatable; omitted selects all twelve anonymous sources.
Default `--limit 50` is per source; `--all` removes the limit. `--no-supgp`
disables comparison. Default output is `/opt/data/operator-od/runs/<UTC timestamp>/`;
use `--out` for a writable external directory. Outputs inside any Git worktree
(including symlink aliases) are refused. Runs using one output directory are
exclusive. Reusing a directory replaces derived products while retaining the
CelesTrak ledger and cache; do not delete its ledger to bypass the three-hour rule.

## Data and compute rules

Operator response bytes live only in memory, including discovery, decompression,
and WASM invocation. There is no raw-response filesystem API, cache, temp file,
or archival path. Getter buffers are scrubbed after processing; copies in the JS
and WASM heaps are released, not promised to be cryptographically erased. This
application makes no claim about operating-system swap. Never commit run data.

The host performs networking, bounded scheduling, hashing, FlatBuffer
serialization, file output and metric reporting. It performs no orbital math,
propagation, fitting, frame conversion, or time-system conversion. Starlink uses
32 concurrent Range GETs of the first 128 KiB; missing range support fails closed.
429 responses honor Retry-After with bounded retries. Discovery is ported from
`src/host/sources/`; Planet's TLE file and EUMETSAT are deliberately excluded.

WASM comes read-only from `TEST_RETRIEVER_MODULES_ROOT`, default:
`/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-modules`.
Every loaded full artifact's SHA-256 appears in `summary.md`. The SDK removes
publication trailers in memory with `toLoadableWasmBytes` before creating its
worker harness. No host network/filesystem capabilities are supplied to OD.

- `analysis/od/dist/isomorphic/module.wasm`, plugin `orbit-determination`,
  method `fit`: `meme` carries MEME or OEM KVN bytes; `options` carries JSON
  labels (`dataSource`, `objectName`, `objectId`, `noradCatId`) and `ref*` scoring
  values. The text path emits JSON `result`, not `omm`/`ocm`; the latter ports
  belong to the binary OEM path. The host serializes returned values to SDS
  OMM, a metadata/mean-element OCM, and OBD. OCM does not claim covariance or
  Cartesian states. The artifact's built-in window/subsampling is retained;
  the inspected JSON parser accepts maxIterations and ref/label options, **not
  window/subsample overrides**. Default fit window is 11,520 s.
- `flows/supplemental-omm/nodes/od/dist/isomorphic/module.wasm`: direct `fit`
  consumes ordered SHA-256-protected SDS FSB chunks and emits OMM/OCM/OBD record
  streams. It is used for GLONASS SP3, Intelsat ECF, and CPF. Decompression is
  in memory. One object can emit several epochs; only its first is retained.
  Pending objects beyond the limit are discarded when the worker is destroyed.
  The 1,000,000 km propagation-failure sentinel is rejected, not counted as a fit.
  GLONASS/Intelsat parsers do not supply NORAD identity: internal 99999/99999A
  seed labels are cleared to unknown, never joined to SupGP.

## Coverage and current contract gaps

| Source | GETTER | WASM PROCESS |
|---|---|---|
| spacex-starlink | manifest + 128 KiB ranges | MEME fit and reference RMS |
| iss | NASA OEM | OEM KVN fit and reference RMS |
| glonass-precise | ESA SP3.gz | supplemental node, R records only |
| intelsat | public listing + ECF | supplemental node |
| cpf | newest ESA file per target | supplemental node |
| gps-precise | BKG SP3.gz | no G-record parser in supplied artifacts |
| esa-pod | ESA GNSS/Swarm/CryoSat | no generic SP3 parser in supplied artifacts |
| eutelsat-oneweb | LTEF CSV | no WASM parser |
| planet | .states | no WASM parser |
| ses | I11 | no WASM parser |
| telesat | center-of-box CSV | no WASM parser; not full state vectors |
| css-tiangong | weekly OEM ZIP | first OEM member decompressed in memory, then standalone OEM fit/reference score |

`spire`, `vimpel`, `cpf-edc`, `space-track` are explicit inert phase-1 getters,
including when credentials exist: zero objects, a note, no credential access.
There is no scheduling, HPOP or single-row OEM output in this phase.

## SupGP policy and comparison

Group names follow the [current SupGP page](https://celestrak.org/NORAD/elements/supplemental/).
ESA POD has no dedicated group; available GPS, GLONASS and CPF references are
considered only by exact NORAD identity. A zero/unknown identity is never guessed.

The policy is cited in `lib/celestrak.mjs`:
`space-data-network-modules/analysis/conjunction-assessment/scripts/CELESTRAK_FETCH_POLICY.md`.
Requests are serial and at least 2.5 seconds apart. A URL-keyed ledger is written
before requests and refuses repeats for three hours, including failed attempts.
Successful SupGP JSON (GP, not operator ephemeris) is cached and reused. Missing
cache does not override the ledger. A 429/503 allows one retry after 60 seconds;
30 consecutive failures halt further CelesTrak requests. There is no bypass flag.
Keep one output/cache directory when repeating a run inside three hours.

CSS ZIP expansion is bounded to 128 MiB; only the first OEM KVN member is
used. The standalone parser reads its own frame/time header; the ISS-specific
supplemental parser is not used for CSS.

For MEME/OEM, the closest SupGP epoch for the same NORAD must be within 11,520 s.
While the same operator bytes remain in memory, the module refits with `refEpoch`,
`refMeanMotion`, `refEccentricity`, `refInclination`, `refRaan`,
`refArgPericenter`, `refMeanAnomaly`, `refBstar`, `refMeanMotionDot`, and
`refMeanMotionDdot`. It scores the reference on the identical fit samples;
reference scoring must not change our RMS. SupGP's advertised RMS is never used
as a substitute for this score.

AGREE means RMS difference ≤ **1 km**, a provisional engineering threshold:
the checked-in fixture fits at approximately 0.101 km, and the text port rounds
to 0.001 km. DISAGREE names the worse model. This is not a statistical validation
of the threshold or a claim of trajectory coincidence. Summary includes paired
medians separately from all-fit medians to avoid mismatched sample populations.

Current artifacts return **no maximum residuals or element deltas**. Those fields
are null, with reasons. The supplemental node exposes neither reference-scoring
options nor its parsed states, so its results are NOT_COMPARED. These are explicit
phase-1 capability gaps; the host does not replace missing WASM with JS physics.

## Declared outputs

- `omm.fsb`, `ocm.fsb`, `obd.fsb`: size-prefixed SDS records, ours.
- `supgp-omm.fsb`: only the SupGP OMMs actually scored.
- `comparison.jsonl`: **interim JSON exception**, version 1. OBD describes one OD
  solution but has no paired-model verdict/provenance slots. Each record contains
  identity, fetch provenance, both scores, epoch difference, verdict, and explicit
  metric gaps. Failed inputs have provenance and a reason, never their bytes.
- `summary.md`: counts, medians, disagreements, notes, timings and artifact hashes.
- `celestrak-ledger.json`, `supgp-<URL sha256>.json`: policy state and permitted GP cache.
- `.retriever.lock` and `celestrak-ledger.json.tmp`: transient coordination files.

Counts distinguish fetched files from identified objects. A fleet without a
WASM parser has an unknown object count, never an invented successful count.

## CelesTrak through Tor (firewall recovery)

Celestrak is currently blocked by this network's firewall: TCP 443 times out, for reasons unrelated to our request behavior. `--celestrak-via tor` sends only the CelesTrak supplemental-GP requests through a local Tor SOCKS proxy (`brew services start tor`; override the address with `TEST_RETRIEVER_TOR_SOCKS`). Operator sources are always fetched directly.

Tor restores reachability. It is **not** a way around rate limits. Every rule in `CELESTRAK_FETCH_POLICY.md` applies unchanged:

- requests are serial, at least 2.5 s apart;
- the same URL is never requested twice within 3 hours;
- on 429 or 503, back off 60 s and retry at most once;
- the run stops after 30 consecutive failures.

