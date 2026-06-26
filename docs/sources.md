# Data sources

Every source fetches from the operator's / producer's **own upstream public
feed** — no CelesTrak, Space-Track, or other aggregators. Verified working
(HTTP 200, real data) via `npx tsx scripts/verify-fetchers.ts`.

| Source id | Operator | Upstream | Format | Discovery |
| --- | --- | --- | --- | --- |
| `spacex-starlink` | SpaceX | `api.starlink.com/public-files/ephemerides/MANIFEST.txt` | MEME state vectors + covariance (.txt) | manifest, per-satellite |
| `eutelsat-oneweb` | Eutelsat OneWeb | `ephemeris.oneweb.net/ltef/ltef.csv` | LTEF CSV (whole constellation) | single file |
| `planet` | Planet Labs | `ephemerides.planet-labs.com/planet.states` | state vectors + TLE | known files |
| `iss` | NASA | `nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/` | CCSDS OEM | single file |
| `ses` | SES | `ses-satellite-orbital-data-public` S3 (linked from ses.com) | IESS-412 11-param (.I11) | scrape index, per-satellite |
| `intelsat` | Intelsat | `my.intelsat.com/Resource/Ephemeris/` | ECF state vectors (.txt) | scrape `my.intelsat.com/ephemeris/public` |
| `telesat` | Telesat | `app.telesat.com/data/` | center-of-box CSV | `FleetLong.csv` manifest |
| `css-tiangong` | China Manned Space (BACC) | `cmse.gov.cn/gfgg/zgkjzgdcs/` | CCSDS OEM (zipped) | scrape latest weekly zip |
| `gps-precise` | IGS / BKG | `igs.bkg.bund.de/root_ftp/IGS/products/<week>/` | SP3 (IGS0OPSULT/RAP, GPS) | newest in GPS-week dir |
| `glonass-precise` | IGS / ESA | `navigation-office.esa.int/products/gnss-products/<week>/` | SP3 (ESA0OPSULT/RAP, GPS+GLONASS) | newest in GPS-week dir |
| `esa-pod` | ESA / ESOC Navigation Office | `navigation-office.esa.int/products/` | SP3 — multi-GNSS (ESA0MGNFIN: G/R/E/C/J) + Swarm A/B/C + CryoSat-2 | newest of each POD product |

### ESA POD products (`esa-pod`)

The ESA/ESOC Navigation Office publishes a full Precise Orbit Determination
suite at `navigation-office.esa.int/products/` (open HTTP, **no login**). The
`esa-pod` source fetches the newest of:

- **multi-GNSS POD** — `gnss-products/<gpsweek>/ESA0MGNFIN_*_ORB.SP3.gz`
  (GPS + GLONASS + Galileo + BeiDou + QZSS; falls back to `ESA0OPSRAP`/`ESA0OPSULT`).
- **Swarm A/B/C POD** — `swarm/SWRAesoc<gpsweek><dow>.sp3.gz`.
- **CryoSat-2 POD** — `cryosat2/<YYMMDD>.cs2.v4.sp3.gz` (final v4, else v3).

Other POD products in the same archive (DORIS, SLR/CPF predictions, GOCE, EOP/ERP)
can be added as additional resources following the same `newestInDir` pattern.

Only `spacex-starlink` currently has a full WASM parser (→ normalized SI state
vectors). The rest are **fetched and archived raw** (with full provenance:
source, URL, SHA-256, fetch timestamp); a format parser module can be added per
source later (Starlink MEME, CCSDS OEM, SP3, LTEF, I11, ECF, …) following
`docs/adding-a-module.md`, after which those sources flow through the full
parse → validate → normalize → store pipeline.

## Providers without an anonymous upstream public feed

Researched directly (operator domains, FCC filings, public buckets); these do
**not** self-host an anonymous public ephemeris feed today — their orbital data
reaches the public only via excluded aggregators (Space-Track/CelesTrak), or is
gated behind authentication:

- **Amazon Kuiper / Amazon Leo** — no operator-hosted feed; shares via Space-Track / NOAA TraCSS only.
- **Spire Global** — an orbit API exists (`api.orb.spire.com/ephemeris`, `/tle`) but requires an API key (HTTP 401/403 anonymously). Provide credentials to enable a fetcher.
- **Iridium** — no ephemeris on any iridium.com domain; routes to Space-Track.
- **ORBCOMM** — corporate IoT site only; no orbital-data section.
- **AST SpaceMobile** — no public feed; shares high-fidelity data privately with NSF NRAO and TLEs via CelesTrak.

If you have a specific upstream URL or credentials for any of these, add a
source descriptor in `src/host/sources/` (see `docs/adding-a-source.md`).

## Authentication / logins

**None of the wired sources require a login** — all 11 are anonymous public
feeds (Starlink, OneWeb, Planet, ISS/NASA, SES, Intelsat, Telesat, CSS/Tiangong,
GPS/BKG, GLONASS/ESA, ESA POD).

Sources that **would** require credentials (and are therefore not wired, or are
served via an open alternative instead):

| Provider | Login / credential needed | Notes |
| --- | --- | --- |
| **Spire Global** | API key (Bearer) on `api.orb.spire.com` | No anonymous access; 401/403 without a key. |
| **Amazon Kuiper** | Space-Track login | No operator feed; data only via Space-Track. |
| **Iridium** | Space-Track login | No operator feed. |
| **ORBCOMM** | Space-Track login | No operator feed. |
| **AST SpaceMobile** | Space-Track login | No public operator feed (shares privately with NSF NRAO). |
| **Space-Track.org** | login (excluded by policy) | Aggregator — intentionally not used. |
| **NASA CDDIS** (alt GNSS/SLR archive) | Earthdata Login | Avoided — GPS/GLONASS/ESA-POD use the open BKG/ESA archives instead. |
| **Copernicus Data Space / Sentinel POD Hub** | registration/login | Avoided — Sentinel/ESA POD come from the open ESA Navigation Office archive instead. |

To enable a credentialed source, add the key/login to the source config
`authentication` block and read it in the source's `discover`/`fetch` (the
`http` client forwards headers).
