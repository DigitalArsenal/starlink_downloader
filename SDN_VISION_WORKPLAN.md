# SDN Full-Vision Workplan (loop-executable)

Goal: installable WASM modules + a decentralized dependency package-manager, with
**Go/Kubo node ⇄ browser/Helia node parity**, dual-curve identity, real composition,
and PNM+streaming data. Context + audit facts live in memory `sdn-full-vision-plan`.

## LOOP PROTOCOL (read every iteration)
1. Read memory `sdn-full-vision-plan` (+ `sdn-module-delivery-pki-map`) for context.
2. **WORKSTREAM ORDER (user reprioritization 2026-07-01): WS7 → WS2b → WS5 → WS3 → WS6 → WS8.** Do the independent, iteration-sized tasks (WS7 storage routing, WS2b ECIES) before the large novel builds (WS5/WS3/WS6). Within the current workstream, take the **first** unchecked `[ ]` task top-to-bottom. Do **only that one task**. (WS4 is complete.)
3. Acceptance for EVERY task: relevant package **builds clean** + **tests green** + **committed & pushed** to the component repo, then mark the box `[x]` in this file and commit this file. One task = one iteration; then stop. **Push every task** (no batching; the user reviews after pushes). Browser/Helia tasks (WS6, and any browser E2E) require **REAL in-browser verification** — drive an actual browser via the `chrome-devtools` MCP (navigate_page/evaluate_script/list_console_messages), not a jsdom/node stub. A task that can only be unit-tested is NOT done until its in-browser E2E passes.
4. If a task is genuinely blocked, mark it `[!]` with a one-line reason, and take the next unblocked task.
5. Env: WasmEdge CGO — `export CGO_CFLAGS="-I$HOME/.wasmedge/include"; export CGO_LDFLAGS="-L$HOME/.wasmedge/lib -lwasmedge -Wl,-rpath,$HOME/.wasmedge/lib"; export DYLD_FALLBACK_LIBRARY_PATH="$HOME/.wasmedge/lib"`. Go pushes: `SKIP_LOCAL_CI=1` (pre-existing webui test fails). Canonical module repo = **space-data-network-modules** (not the stale -plugins). secp256k1 sig scheme = ECDSA-DER over sha256(canonical JCS content), default ed25519.
6. When a component repo commit lands, bump its submodule pin (OrbPro/orbpro-stack) as part of the same task if applicable.

Repos: `space-data-network` (Go `sdn-server` + `sdn-js`), `space-data-network-modules` (WASM modules), `space-data-module-sdk`, `hd-wallet-wasm`, `spacedatastandards.org`, `flatsql`, `space-data-network-closed-modules`.

---

## WS4 — Dependency resolver (decentralized package manager)
- [x] **4.1** Emit `PLG.DEPENDENCIES` on the wire (Go): add a `Dependencies []PluginDependency` field to `PluginCatalogEntry`/`PluginAsset`/`EncryptedPluginUpload`/`ModulePublishEntry` (internal/license), and `PLGAddDEPENDENCIES(...)` in `buildPublicationDescriptorFrame` (internal/node/licensing_bootstrap.go); normalize + PLG round-trip test. [space-data-network]
- [x] **4.2** Go dependency **resolver** lib: `ResolveClosure(plg, registry)` — read `PLG.DEPENDENCIES()`, diff vs installed registry, semver MIN/MAX satisfaction, cycle detection, topo order. Unit tests. [space-data-network new `internal/deps`]
- [x] **4.3a** Go delivery consumer — **LCH challenge codec**: `EncodeChallengeRequest` + `DecodeChallengeResponse` on generated LCH types, matching sdn-js `encodeChallengeRequest`/`decodeChallengeResponse` wire layout; RawBytes preserved verbatim for proof signing; round-trip + negative tests. [space-data-network `internal/deliveryclient`]  *(split from 4.3 — full consumer is 3-part; codec first)*
- [x] **4.3b** Go delivery consumer — **LPF proof + LGR grant decode + signing**: sign challenge RawBytes → LPF proof frame; decode + validate LGR grant (bundle descriptor, granted domain/timeout, verifier sig, wrapped-content-key envelope). Round-trip vs a Go in-process provider. [space-data-network `internal/deliveryclient`]
- [x] **4.3c** Go delivery consumer — **end-to-end orchestration**: `Transport` (dial module-delivery + CID fetch) + `SignFunc` + pluggable `ContentKeyUnwrapper`/`BundleDecryptor` interfaces; `Consumer.RequestGrant` (challenge→sign RawBytes→proof→grant→validate) + `FetchAndDecrypt` + `PullModule`. Tested end-to-end against a fake in-process provider transport + fake crypto. [space-data-network `internal/deliveryclient`]  *(split from 4.3c — crypto isolated as 4.3d)*
- [x] **4.3d** Go delivery consumer — **concrete content-key crypto**: ENC/KMF content-key unwrap (X25519 ECDH + KDF + AEAD per the grant's ENC header) + AEAD bundle decrypt, implementing the 4.3c interfaces. Authoritative producer is the C++/JS provider, so **cross-validate against a JS/SDK-produced grant vector** (Node script emitting {client X25519 priv, grant bytes, expected content key, encrypted+plaintext bundle}) — not a Go-vs-Go echo — before marking done. [space-data-network `internal/deliveryclient`]
- [x] **4.4a** **Installer algorithm** (`internal/deps`): `Install(root, installed, catalog, installFn)` — resolve the transitive closure, install each not-yet-installed module dependency-first then the root, skip installed (recurse-to-fixpoint via the closure), abort cleanly on failure. Transport/registry-agnostic (reused by node 4.4b + browser 4.5); unit-tested with fakes. [space-data-network `internal/deps`]  *(split from 4.4 — algorithm core)*
- [x] **4.4b** **Node wiring + integration test**: registry-backed `deps.Catalog` (reads `PLG.DEPENDENCIES` from `PluginAsset`) + `assetManifest` + `catalogInstallOrder`/`catalogRegistrationOrder`; `registerCatalogPlugins` now registers dependency-first (fallback to listing order). 4 tests over a test registry (deps-first, transitive, missing-dep, fallback). *(Deferred, needs live-node smoke test: flipping on eager `registerCatalogPlugins` at startup + the consumer-backed `installFn` that remote-pulls an absent dep via the grant flow.)* [space-data-network `internal/node`]
- [x] **4.5** Browser resolver: `sdn-js` `module-dependency-resolver.ts` (resolveClosure/installClosure — Go `deps` mirror) + `installed-module-registry.ts` (InstalledModuleRegistry + persistence + `createModuleInstaller` fetch→decrypt→register→record). 17 vitest tests incl. end-to-end install + persistence. Exported from index. *(Full in-browser E2E via Helia = WS6.7.)* [sdn-js]

## WS5 — Executable data-source WASM module (reference: spacex-starlink)
- [ ] **5.1** Manifest + skeleton: a `spacex-starlink-source` WASM module (C++, in space-data-network-modules) — manifest declares PLUGIN_TYPE=DataSource, `TIMERS` (a `pull` method), host-caps HTTP/STORAGE_WRITE/PUBSUB/CRYPTO_SIGN, and DEPENDENCIES on starlink-parser/validator. Build the empty module, structural test.
- [ ] **5.2** Implement discover+fetch in the module's `pull` (port `starlink-parser`/JS-provider discover logic; HTTP host-cap for MANIFEST + files; hash). Build; run under the Go node once; assert resources discovered.
- [ ] **5.3** Wire store + sign + publish in `pull`: STORAGE_WRITE the fetched records, CRYPTO_SIGN a PNM, PUBSUB publish + stream. Build; test.
- [ ] **5.4** Run under the Go node **cron** (TIMERS-driven); assert it pulls→stores→signs-PNM→publishes on schedule. Commit the module + declare it in closed-modules with its dependency graph.

## WS3 — Composition (shared-mem aligned-binary via flowrt)
- [ ] **3.1** Build a Go **flow artifact** linking `spacex-starlink-source → starlink-parser → validator` via `flowrt` linked-direct (zero host-copy, aligned-binary shared memory); test on the Go node. [space-data-network internal/flowrt + modules]
- [ ] **3.2** Port the `flowrt` linked-direct runtime to the SDK/JS so the same flow composes in the browser harness; test. [space-data-module-sdk]

## WS2b — secp256k1 ECIES encryption (default X25519)
- [ ] **2b.1** Spec + EPM key: define secp256k1 ECIES (ephemeral ECDH + HKDF-SHA256 + AES-256-GCM); add a secp256k1 **encryption** CryptoKey to the node/wallet EPM (Go `epm/service.go`, `sdn-js` peer-identity). Test EPM carries both x25519 + secp256k1 encryption keys.
- [ ] **2b.2** Implement secp256k1 ECIES wrap/unwrap dispatch on the recipient encryption-key curve (default X25519): Go `internal/license/plugins.go` BuildPluginKeyEnvelope/Decrypt; test. [space-data-network]
- [ ] **2b.3** C++ ECIES: `licensing/core` key_server (wrap) + `client-decrypt`/`delivery/plugin-delivery` (unwrap) secp256k1 path; native test; rebuild wasm. [space-data-network-modules]
- [ ] **2b.4** SDK/wallet ECIES + cross-runtime test (wrap-for-secp256k1-recipient on one runtime → unwrap on another). [space-data-module-sdk + hd-wallet-wasm]

## WS7 — FlatSQL `(producer, standard)` table routing (50-file blast radius)
- [x] **7.1** `(producer, standard)`→table-name function + on-demand table creation in `internal/storage/producer_standard_tables.go` (`ProducerStandardTableName` = `sds_p_<producer>__<standard>`, sanitized producer + validated `sds.SchemaNameToTable`; `ensureProducerStandardTable` idempotent on-demand create). Unit tests. [space-data-network]
- [x] **7.2** Routed write path `StoreRoutedByProducer` — the `(producer, standard)` counterpart of `Store` (ensures the producer table, appends to the shared stream, updates the record index; row lands in `sds_p_<producer>__<standard>`). Additive (existing `Store` unchanged so readers keep working until 7.3); tested for producer separation + idempotency. *(Flipping the default write path + migrating source_tags/source_summary keys folds into 7.3.)* [space-data-network]
- [ ] **7.3** Update record read/query call sites (sds-exchange, flatsql-sync, api, ingest) to cross-table SQL over `(producer, standard)` tables. Batch; build+test after each cluster. [space-data-network]
- [ ] **7.4** starlink `src/host/storage/flatsql.ts` — route by `(producer, standard)` instead of the fixed `EphemRecord` table; test. [starlink_downloader]
- [ ] **7.5** Cross-table query surface (e.g. "all OMM across producers", "all from producer X") + tests. [space-data-network]

## WS6 — Helia (browser) node parity (XL) — REAL in-browser E2E required (chrome-devtools MCP)
- [ ] **6.1** Async in-WASM host bridge (SharedArrayBuffer + `Atomics.wait` worker) in the SDK browser harness so guest modules can call http/ipfs/storage/pubsub (today the sync bridge throws). Test. [space-data-module-sdk]
- [ ] **6.2** Wire Helia(`ipfs`)/FlatSQL(`storage_*`)/`pubsub`/`wallet_sign` host adapters into `createBrowserModuleHarness` (today none are wired). Test. [space-data-module-sdk + sdn-js]
- [ ] **6.3** Browser cron/timer driver: manifest `TIMERS` → interval → `plugin_invoke_stream` (today `host/cron.js` only parses). Test. [sdn-js/sdk]
- [ ] **6.4** Browser installed-module **registry + lifecycle + persistence** (cache decrypted bytes+manifest, dedupe id/version, start/stop). [sdn-js]
- [ ] **6.5** FlatSQL **store-of-record** on Helia: wire `space-data-module-sdk/runtime-host/flatsqlRuntimeStore.js`; migrate the node off IndexedDB (`sdn-js/src/storage.ts`). [sdn-js]
- [ ] **6.6** PNM **signing + publish** on Helia (encode+sign PNM FlatBuffer, publish topic) — today Helia only subscribes/decodes. [sdn-js]
- [ ] **6.7** End-to-end: install `spacex-starlink-source` on a Helia node → it downloads + stores + PNM-publishes **in-browser**, deps auto-installed via WS4.5. Integration test.

## WS8 — Cleanup
- [ ] **8.1** Delete the JS `*-provider` packages (17 ported + pre-existing celestrak/sdn-publisher) now WASM data-source modules exist (WS5). [space-data-network-closed-modules]
- [ ] **8.2** Final sweep: bump all submodule pins; full suites green across repos; update memory `sdn-full-vision-plan` to DONE.
