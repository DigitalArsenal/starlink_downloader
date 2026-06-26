# Adding a compute module

Every parser, validator, normalizer, interpolator, and exporter is an
independent C++/WASM module. Adding one is additive — no host edits.

## 1. Create the directory

```
src/modules/<your-id>/
  module.json     # compact descriptor (the SDK manifest is generated from this)
  module.cpp      # C++ source
```

## 2. Write `module.json`

```json
{
  "id": "my-parser",
  "kind": "parser",            // parser | validator | normalizer | interpolator | exporter
  "methodId": "parse",          // must match the exported C function name
  "language": "c++",
  "name": "My Parser",
  "version": "0.1.0",
  "inputs": ["raw"],            // input port ids
  "outputs": ["meta", "states"],// output port ids
  "provides": ["my-source"],   // capability tags (source id, scheme, format, …)
  "description": "…"
}
```

The registry discovers this automatically and the build generates a strict,
schema-valid `PluginManifest` (declaring both `direct` + `command` surfaces and
`runtimeTargets: [wasmedge, node, browser]`).

## 3. Write `module.cpp`

```cpp
#include "space_data_module_invoke.h"

extern "C" int parse(void) {
  const int32_t i = plugin_find_input_index("raw", 0);
  if (i < 0) { plugin_set_error("no_input", "missing 'raw'"); return 1; }
  const plugin_input_frame_t* f = plugin_get_input_frame((uint32_t)i);

  // ... compute ...

  plugin_reset_output_state();
  plugin_push_output("meta", "", "", meta_ptr, meta_len);       // JSON bytes
  plugin_push_output("states", "", "", states_ptr, states_len); // f64 array
  return 0;
}
```

Honor the wire contract (see `docs/architecture.md`): `meta` = JSON, `states` =
`f64[7]` per state vector. **Guard null `schema_name`/`file_identifier`** before
passing them to `plugin_push_output`.

## 4. Build and test

```sh
npm run build:modules        # compiles, runs `space-data-module check`, AOT-compiles
npx tsx src/host/cli/index.ts list-plugins
```

Then invoke it from the host via the registry:

```ts
const reg = ModuleRegistry.discover();
await reg.buildAll();
const mod = reg.provider('parser', 'my-source')!;
const frames = await mod.module.invoke(mod.descriptor.methodId, [{ portId: 'raw', payload }]);
```

Add a test under `test/` that drives the compiled module against a fixture and
asserts golden output — the WASM module is the single source of truth.
