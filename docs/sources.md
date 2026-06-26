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
| `eumetsat` | EUMETSAT | `service.eumetsat.int/tle/` | TLE (Metop, NOAA/JPSS, Sentinel-3/6, Metop-SG) | scrape per-satellite JS data files |
| `cpf` | ESA / ESOC Navigation Office | `navigation-office.esa.int/products/cpf_predictions/` | CPF v2 laser-ranging predictions (Galileo) | newest `<target>_cpf_<yymmdd>_<seq>.esa` per target |

Plus three **credentialed** sources (inert until their `.env` keys are set):
`spire` (Spire orbit API key), `space-track` (login — covers Kuiper/Iridium/ORBCOMM/AST
which have no upstream feed), and `vimpel` (JSC Vimpel portal login).

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

## CelesTrak Supplemental coverage

This system covers the full CelesTrak Supplemental GP operator set via **upstream**
feeds (not CelesTrak): `starlink, oneweb, planet, ses, intelsat, telesat, gps,
glonass, iss, css, cpf, eumetsat` are anonymous upstream; `kuiper, iridium,
orbcomm, ast` have no upstream feed and are covered via the credentialed
**Space-Track** source. The full ILRS CPF target set (LAGEOS, LARES, Etalon,
Sentinel, Jason, …) beyond ESA's Galileo CPF lives at **EDC** (edc.dgfi.tum.de,
free account) or **CDDIS** (NASA Earthdata) — wire as a credentialed source.

## Providers without an anonymous upstream public feed

These do **not** self-host an anonymous public feed; their data is reached via a
credentialed source instead:

- **Amazon Kuiper** — no operator feed; via **Space-Track** (`KUIPER`).
- **Iridium** — no operator feed; via **Space-Track** (`IRIDIUM`).
- **ORBCOMM** — no operator feed; via **Space-Track** (`ORBCOMM`).
- **AST SpaceMobile** — no operator feed; via **Space-Track** (`BLUEWALKER`/`BLUEBIRD`).
- **Spire Global** — orbit API requires an API key (`api.orb.spire.com`); credentialed source.
- **JSC Vimpel** — portal requires registration + login; credentialed source.

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
| **Spire Global** | API key (Bearer) on `api.orb.spire.com` | No anonymous access; 401/403 without a key. Wired as `spire`. |
| **JSC Vimpel** | portal login (`spacedata.vimpel.ru`) | Register at `/ru/user/register` (CAPTCHA + approval). Wired as `vimpel`. |
| **EDC** (full ILRS CPF) | free EDC account (username/password) | edc.dgfi.tum.de API; full laser-target CPF set beyond ESA's Galileo. |
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
