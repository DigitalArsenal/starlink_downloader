# Adding a data source

A source knows how to **discover** its fetchable resources; a parser module
(matched by `provides` tag) turns each downloaded file into state vectors.

## 1. Write the source

`src/host/sources/<id>.ts`:

```ts
import type { DiscoveredResource } from '../types.js';
import type { EphemerisSource, SourceContext } from './index.js';

export const myWonderfulSource: EphemerisSource = {
  id: 'my-operator',
  name: 'My Operator',
  operator: 'MyOrg',
  parserTag: 'my-operator',   // a parser module that `provides` this tag
  contentExt: 'txt',
  host: 'data.myorg.example', // for rate limiting

  async discover(ctx: SourceContext): Promise<DiscoveredResource[]> {
    const index = await ctx.http.getText('https://data.myorg.example/index.txt');
    const names = index.split('\n').map((l) => l.trim()).filter(Boolean);
    const limited = ctx.limit ? names.slice(0, ctx.limit) : names;
    return limited.map((name) => ({
      id: name,
      url: `https://data.myorg.example/${name}`,
      noradId: deriveNorad(name),     // or null if unknown before fetch
      hints: { satelliteName: name }, // filename-derived identity for normalize()
    }));
  },
};
```

Network calls go through `ctx.http` — the SDK isomorphic `http` capability with
retry/backoff already applied.

## 2. Register it

Add it to the `ALL` array in `src/host/sources/index.ts`.

## 3. Provide a parser module

Create a parser module whose `module.json` has `"provides": ["my-operator"]`
(see `docs/adding-a-module.md`). It must emit the `meta` + `states` frames.

## 4. Configure and run

```yaml
# config/ephem.yaml
sources:
  my-operator:
    enabled: true
    retryCount: 5
```

```sh
npx tsx src/host/cli/index.ts refresh --source my-operator --limit 20
```

## Notes on formats

- **State-vector formats** (Starlink MEME, CCSDS OEM, SP3) map directly to the
  internal model.
- **Mean-element formats** (TLE / OMM via CelesTrak GP) require an SGP4
  propagator module to produce state vectors — add it as a `parser` (or a
  `normalizer`) module that propagates elements to a state grid.
- The host derives identity (NORAD id, name) from the resource `hints`; the
  parser fills frame/time-system/validity from the file content. `normalize()`
  merges the two into a `SatelliteEphemeris`.
