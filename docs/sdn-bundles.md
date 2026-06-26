# SDN bundles — searchable, installable on the Space Data Network

Every unit is packaged as its own **Space Data Network (SDN) bundle** so it can
be listed, searched, and installed, following the `orbpro-stack` convention.
Generate them with:

```sh
npm run build:modules     # compile the C++/WASM compute modules first
npm run build:bundles     # emit one bundle per unit under bundles/
```

`bundles/` is generated (git-ignored); `bundles/index.json` lists everything and
the publisher key.

## What gets produced

**22 bundles** = 5 compute modules + 17 data sources.

### Compute module bundle (`space-data-network-module-<kind>-<id>/`)
```
package.json                       # "sdn-module": "./dist/isomorphic/module.wasm"
plugin-manifest.json               # pluginId, family=analysis, methods, SDS ports
dist/isomorphic/module.wasm        # the isomorphic WASM artifact (passes `space-data-module check`)
dist/isomorphic/module.aot.wasm    # WasmEdge AOT build
dist/isomorphic/module.protected.wasm  # signed artifact (wasm + $REC/PNM trailer)
listing.plg                        # signed $PLG marketplace listing
publication-records.fb             # PNM publication records (signature)
README.md
```

### Data-source bundle (`space-data-network-data-source-<id>/`)
```
package.json                       # "sdn-data-source": "./data-source-manifest.json"
data-source-manifest.json          # pluginId, family=data_source, http capability, upstream descriptor
listing.plg                        # signed $PLG marketplace listing (PLUGIN_TYPE = datasource)
publication-records.fb             # PNM publication records (signature)
README.md
```

Data sources are listings + descriptors (not pure-compute WASM), matching how
orbpro-stack handles ingestion (compute modules are WASM; data sources are
separate).

## Searchability (the `$PLG` record)

Each `listing.plg` is a spacedatastandards **`$PLG`** (Plugin Listing) record,
populated from the manifest and decodable with `decodePlgManifest`:

- `pluginId` — e.g. `org.digitalarsenal.ephem.validator`, `…ephem.source.spacex-starlink`
- `name`, `description`, `tagline`
- `pluginType` — `analysis` (3) for compute, `datasource` (4) for sources
- `tags[]` — e.g. `["data-source","ephemeris","sds","spacex-starlink","spacex","txt","anonymous"]`
  (operator, format, and `anonymous`/`credentialed` are tagged for filtering)
- `publisherName`/`publisherHandle`, `runtimeTargets`, `abiVersion`

This is what the SDN storefront indexes for name/family/tag/provider search.

## Signing & publishing

Bundles are signed at build time:

- Compute modules → `protectModuleArtifact()` produces the `$REC`/PNM-trailered
  `module.protected.wasm` and `publication-records.fb`.
- Data sources → the `$PLG` listing is signed via a `createPublicationNotice`
  PNM over the listing bytes.

The signer is an HD-wallet identity from **`SDN_PUBLISHER_MNEMONIC`** (`.env`);
without it a dev key is generated and printed. To publish for real:

1. Set `SDN_PUBLISHER_MNEMONIC` to your publisher mnemonic and `npm run build:bundles`.
2. Upload each WASM (encrypted via `protectModuleArtifact` recipient keys if
   private) to IPFS → obtain the CID.
3. Push the signed `$PLG` record (with the `WASM_CID`) to the SDN storefront API.

See `scripts/build-sdn-bundles.ts` for the generator and `orbpro-stack`’s
`AGENTS-data-module-marketplace.md` for the storefront/listing contract.
