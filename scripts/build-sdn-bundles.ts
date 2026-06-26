/**
 * Generate a publish-ready Space Data Network (SDN) bundle for every unit:
 *  - each compute WASM module  -> a `space-data-network-module-<kind>-<id>` bundle
 *    (package.json `sdn-module`, plugin-manifest.json, dist/isomorphic/module.wasm,
 *     protected artifact + publication records, signed $PLG listing).
 *  - each data source/fetcher  -> a `space-data-network-data-source-<id>` bundle
 *    (package.json `sdn-data-source`, data-source-manifest.json, signed $PLG listing).
 *
 * Listings use the spacedatastandards $PLG record (searchable by name/family/tags)
 * and are signed with the publisher HD-wallet identity (SDN_PUBLISHER_MNEMONIC,
 * else a generated dev key printed once). Matches the orbpro-stack convention.
 *
 * Run: `npm run build:bundles` (after `npm run build:modules`).
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  protectModuleArtifact,
  legacyManifestToPlg,
  encodePlgManifest,
  createHdWalletSigner,
  createPublicationNotice,
  encodePublicationRecordCollection,
} from 'space-data-module-sdk';
import { getWasmWallet } from 'space-data-module-sdk/utils/wasm-crypto';
import { listSources } from '../src/host/sources/index.js';
import { ModuleRegistry } from '../src/host/modules/registry.js';
import { generateManifest } from '../src/host/modules/manifest.js';
import { PACKAGE_ROOT } from '../src/host/paths.js';
import { logger } from '../src/host/logger.js';

const ORG = 'org.digitalarsenal.ephem';
const VERSION = '0.1.0';
const PUBLISHER = { name: 'DigitalArsenal', handle: 'digitalarsenal', url: 'https://digitalarsenal.io' };
const BUNDLES_DIR = join(PACKAGE_ROOT, 'bundles');

const toHex = (u8: Uint8Array): string => Buffer.from(u8).toString('hex');
const fbId = (bytes: Uint8Array): string => Buffer.from(bytes.slice(4, 8)).toString('latin1');

// --- publisher signing identity -------------------------------------------
const wallet = (await getWasmWallet()) as {
  mnemonic: { validate(m: string): boolean; generate(n: number): string; toSeed(m: string): unknown };
  hdkey: { fromSeed(seed: unknown): unknown };
  getSigningKey(root: unknown, a: number, b: number, c: number): { publicKey: Uint8Array; privateKey: Uint8Array };
  curves: { secp256k1: { sign(digest: Uint8Array, priv: Uint8Array): Uint8Array } };
};
const envMnemonic = process.env.SDN_PUBLISHER_MNEMONIC?.trim();
const mnemonic =
  envMnemonic && wallet.mnemonic.validate(envMnemonic) ? envMnemonic : wallet.mnemonic.generate(12);
if (!envMnemonic) {
  logger.warn('SDN_PUBLISHER_MNEMONIC not set — using a generated DEV publisher key (set it in .env for real publishing)');
}
const signingKey = wallet.getSigningKey(wallet.hdkey.fromSeed(wallet.mnemonic.toSeed(mnemonic)), 0, 0, 0);
const publisherPublicKeyHex = toHex(signingKey.publicKey);
const signer = createHdWalletSigner({
  publicKeyHex: publisherPublicKeyHex,
  keyId: 'ephem-publisher',
  signDigest: (digest: Uint8Array) => wallet.curves.secp256k1.sign(digest, signingKey.privateKey),
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Build + write a signed $PLG listing record + publication records into a bundle dir. */
async function writeListing(dir: string, manifest: Record<string, unknown>): Promise<number> {
  const plg = encodePlgManifest(legacyManifestToPlg(manifest));
  if (fbId(plg) !== '$PLG') throw new Error(`PLG identifier mismatch for ${String(manifest.pluginId)}: ${fbId(plg)}`);
  writeFileSync(join(dir, 'listing.plg'), Buffer.from(plg));
  const pnm = await createPublicationNotice({
    payloadBytes: plg,
    artifactId: String(manifest.pluginId),
    programId: String(manifest.pluginId),
    fileName: 'listing.plg',
    fileId: String(manifest.pluginId),
    signer,
  });
  const records = encodePublicationRecordCollection({ pnm });
  writeFileSync(join(dir, 'publication-records.fb'), Buffer.from(records));
  return plg.length;
}

// --- compute module bundles ------------------------------------------------
async function buildComputeBundles(): Promise<string[]> {
  const registry = ModuleRegistry.discover();
  const names: string[] = [];
  for (const reg of registry.list()) {
    const d = reg.descriptor;
    const wasmPath = reg.buildSpec.wasmPath;
    if (!existsSync(wasmPath)) {
      throw new Error(`module '${d.id}' is not built (${wasmPath}); run npm run build:modules first`);
    }
    const pkgName = `space-data-network-module-${d.kind}-${d.id}`;
    const dir = join(BUNDLES_DIR, pkgName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'dist', 'isomorphic'), { recursive: true });

    const tags = [...new Set(['ephemeris', 'sds', 'space-data', d.kind, ...d.provides])];
    const manifest: Record<string, unknown> = {
      ...(generateManifest(d) as Record<string, unknown>),
      pluginId: `${ORG}.${d.id}`,
      name: d.name || d.id,
      version: VERSION,
      description: d.description,
      tagline: d.description.slice(0, 80),
      tags,
      pluginFamily: 'analysis',
    };
    writeJson(join(dir, 'plugin-manifest.json'), manifest);

    const wasmBytes = new Uint8Array(readFileSync(wasmPath));
    writeFileSync(join(dir, 'dist', 'isomorphic', 'module.wasm'), wasmBytes);
    const aot = reg.buildSpec.aotPath;
    if (existsSync(aot)) writeFileSync(join(dir, 'dist', 'isomorphic', 'module.aot.wasm'), readFileSync(aot));

    const protectedArtifact = (await protectModuleArtifact({
      wasmBytes,
      manifest,
      artifactId: d.id,
      mnemonic,
    })) as { protectedArtifactBytes: Uint8Array; publicationRecordsBytes: Uint8Array };
    writeFileSync(
      join(dir, 'dist', 'isomorphic', 'module.protected.wasm'),
      Buffer.from(protectedArtifact.protectedArtifactBytes),
    );

    const plgLen = await writeListing(dir, manifest);

    writeJson(join(dir, 'package.json'), {
      name: pkgName,
      version: VERSION,
      type: 'module',
      private: true,
      'sdn-module': './dist/isomorphic/module.wasm',
      description: d.description,
      keywords: tags,
      publisher: PUBLISHER.handle,
      license: 'Apache-2.0',
    });
    writeFileSync(
      join(dir, 'README.md'),
      `# ${manifest.name}\n\nSDN compute module (\`${manifest.pluginId}\`, family \`analysis\`).\n\n` +
        `${d.description}\n\n- WASM: \`dist/isomorphic/module.wasm\`\n- Protected artifact: \`dist/isomorphic/module.protected.wasm\`\n` +
        `- Signed listing: \`listing.plg\` ($PLG, ${plgLen} bytes) + \`publication-records.fb\`\n- Publisher key: \`${publisherPublicKeyHex}\`\n`,
    );
    names.push(pkgName);
    logger.info({ bundle: pkgName }, 'compute bundle written');
  }
  return names;
}

// --- data-source bundles ---------------------------------------------------
async function buildDataSourceBundles(): Promise<string[]> {
  const names: string[] = [];
  for (const src of listSources()) {
    const pkgName = `space-data-network-data-source-${src.id}`;
    const dir = join(BUNDLES_DIR, pkgName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const credentialed = ['spire', 'space-track', 'vimpel', 'cpf-edc'].includes(src.id);
    const tags = [
      ...new Set([
        'data-source',
        'ephemeris',
        'sds',
        src.id,
        src.operator.toLowerCase().split(/\s+/)[0] ?? src.id,
        src.contentExt,
        credentialed ? 'credentialed' : 'anonymous',
      ]),
    ];
    const descriptor = {
      sourceId: src.id,
      operator: src.operator,
      upstreamHost: src.host,
      format: src.contentExt,
      parserTag: src.parserTag,
      authentication: credentialed ? 'required (see .env)' : 'none',
    };
    const description =
      `Upstream ${credentialed ? 'credentialed ' : 'public '}ephemeris data source: ${src.name} ` +
      `(operator ${src.operator}), host ${src.host}, format ${src.contentExt}.`;
    const manifest: Record<string, unknown> = {
      pluginId: `${ORG}.source.${src.id}`,
      name: `${src.name} (data source)`,
      version: VERSION,
      description,
      tagline: `Upstream ${src.operator} ephemeris feed`,
      tags,
      pluginFamily: 'data_source',
      capabilities: [{ capability: 'http' }],
      externalInterfaces: [{ kind: 'http', host: src.host }],
      invokeSurfaces: [],
      runtimeTargets: ['node', 'browser', 'wasmedge'],
      methods: [],
      dataSource: descriptor,
    };
    writeJson(join(dir, 'data-source-manifest.json'), manifest);

    const plgLen = await writeListing(dir, manifest);

    writeJson(join(dir, 'package.json'), {
      name: pkgName,
      version: VERSION,
      type: 'module',
      private: true,
      'sdn-data-source': './data-source-manifest.json',
      description,
      keywords: tags,
      publisher: PUBLISHER.handle,
      license: 'Apache-2.0',
    });
    writeFileSync(
      join(dir, 'README.md'),
      `# ${src.name} — data source\n\nSDN data-source listing (\`${manifest.pluginId}\`, family \`data_source\`).\n\n` +
        `${description}\n\n- Descriptor: \`data-source-manifest.json\`\n- Signed listing: \`listing.plg\` ($PLG, ${plgLen} bytes) + \`publication-records.fb\`\n` +
        `- Auth: ${descriptor.authentication}\n- Publisher key: \`${publisherPublicKeyHex}\`\n`,
    );
    names.push(pkgName);
    logger.info({ bundle: pkgName }, 'data-source bundle written');
  }
  return names;
}

mkdirSync(BUNDLES_DIR, { recursive: true });
const compute = await buildComputeBundles();
const sources = await buildDataSourceBundles();
writeJson(join(BUNDLES_DIR, 'index.json'), {
  publisher: { ...PUBLISHER, signingPublicKeyHex: publisherPublicKeyHex },
  generatedFrom: 'ephem',
  computeModules: compute,
  dataSources: sources,
  total: compute.length + sources.length,
});
logger.info(
  { compute: compute.length, dataSources: sources.length, total: compute.length + sources.length },
  'all SDN bundles generated',
);
