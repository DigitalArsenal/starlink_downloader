import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkerModuleHarness } from 'space-data-module-sdk/testing';
import { toLoadableWasmBytes } from 'space-data-module-sdk/host/browser-module';
import { standards } from 'spacedatastandards.org';
import { Builder, ByteBuffer } from 'flatbuffers';
import { gunzipSync } from 'node:zlib';
import { sha256 } from './http.mjs';
import { firstOemInZip } from './containers.mjs';
import { textFitProducts, readFB } from './products.mjs';
export const DEFAULT_MODULES_ROOT = '/Users/tj/software/spacedatanetwork-stack/repos/main-packages/space-data-network-modules';
const fsbType = { schemaName: 'FSB.fbs', fileIdentifier: '$FSB', rootTypeName: 'FSB', wireFormat: 'flatbuffer',
  schemaVersion: '1.164.0', schemaHash: '0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945' };
export const unsupported = {
  'eutelsat-oneweb': 'No WASM LTEF CSV parser in the supplied OD artifacts.',
  planet: 'No WASM Planet .states parser in the supplied OD artifacts (TLE feed excluded).',
  ses: 'No WASM I11 parser in the supplied OD artifacts.',
  telesat: 'No WASM Telesat center-of-box CSV parser; feed does not expose full states.',
  'gps-precise': 'Supplemental SP3 WASM parser accepts R (GLONASS) records only, not GPS G records.',
  'esa-pod': 'Supplemental SP3 WASM parser is GLONASS-only; no generic multi-GNSS/Swarm/CryoSat parser.',
};
// sgp4_fitter.cpp compute_residuals_3d / compute_rms return 1e6 on propagation failure.
export function fitFailure(rms) {
  return !Number.isFinite(Number(rms)) || Number(rms) >= 1e6
    ? 'WASM fit failed: RMS is non-finite or the 1000000 km propagation-failure sentinel' : null;
}
function objectKey(row) { return `${row.OBJECT_NAME ?? ''}|${row.NORAD_CAT_ID ?? 0}`; }
function checked(response) {
  if (response.statusCode !== 0) throw new Error(`WASM ${response.errorCode}: ${response.errorMessage}`);
  return response;
}
export class Processor {
  constructor({ modulesRoot = process.env.TEST_RETRIEVER_MODULES_ROOT ?? DEFAULT_MODULES_ROOT } = {}) {
    this.modulesRoot = modulesRoot; this.artifacts = []; this.harness = null; this.queue = Promise.resolve();
  }
  async load(relative, pluginId) {
    const filename = path.join(this.modulesRoot, relative);
    const bytes = await readFile(filename);
    const digest = sha256(bytes);
    if (!this.artifacts.some(a => a.path === filename && a.sha256 === digest)) this.artifacts.push({ path: filename, pluginId, sha256: digest });
    return createWorkerModuleHarness({ wasmSource: toLoadableWasmBytes(bytes),
      dispatchHost: async () => { throw new Error('OD compute has no host capabilities'); },
      harnessOptions: { logOutput: false } });
  }
  async textFit(bytes, options = {}) {
    // Serialize access to a single worker/guest arena. The caller retains raw bytes only until fit/score completes.
    const work = this.queue.then(async () => {
      this.harness ??= await this.load('analysis/od/dist/isomorphic/module.wasm', 'orbit-determination');
      const response = checked(await this.harness.invoke({ methodId: 'fit', inputs: [
        { portId: 'meme', payload: bytes }, { portId: 'options', payload: Buffer.from(JSON.stringify(options)) },
      ] }));
      const output = response.outputs.find(o => o.portId === 'result');
      if (!output) throw new Error('OD text path returned no result diagnostics');
      const fit = JSON.parse(Buffer.from(output.payload).toString());
      if (fitFailure(fit.RMS)) throw new Error(fitFailure(fit.RMS));
      return fit;
    });
    this.queue = work.catch(() => {}); return work;
  }
  async fit(item, limit = Infinity) {
    const id = item.source.id;
    if (unsupported[id]) throw new Error(unsupported[id]);
    if (['spacex-starlink', 'iss', 'css-tiangong'].includes(id)) {
      const options = { inputFormat: id === 'spacex-starlink' ? 'meme' : 'oem', dataSource: id,
        ...(item.resource.noradId ? { noradCatId: item.resource.noradId } : {}),
        objectName: item.resource.hints?.satelliteName };
      const scoringBytes = id === 'css-tiangong' ? firstOemInZip(item.bytes) : undefined;
      try {
        const fit = await this.textFit(scoringBytes ?? item.bytes, options);
        return [{ fit, products: textFitProducts(fit), options, canScore: true, scoringBytes }];
      } catch (error) { scoringBytes?.fill(0); throw error; }
    }
    return this.nativeFit(item, limit);
  }
  async nativeFit(item, limit) {
    const port = { 'glonass-precise': 'glonass', intelsat: 'intelsat', cpf: 'cpf' }[item.source.id];
    if (!port) throw new Error('No WASM parser for source');
    let bytes = item.bytes;
    if (item.resource.ext?.endsWith('.gz')) bytes = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
    const h = await this.load('flows/supplemental-omm/nodes/od/dist/isomorphic/module.wasm', 'org.sdn.flows.supplemental-omm.od');
    const rows = []; const streams = { omm: [], ocm: [], obd: [] };
    const collect = response => {
      checked(response);
      for (const frame of response.outputs) {
        if (!(frame.portId in streams) || frame.wireFormat !== 'flatbuffer') continue;
        const chunk = standards.FSB.FSB.getRootAsFSB(new ByteBuffer(frame.payload)).unpack();
        streams[frame.portId].push(Buffer.from(chunk.DATA));
      }
    };
    try {
      let response;
      for (let offset = 0, sequence = 0; offset < bytes.length; offset += 1_048_576, sequence++) {
        const part = bytes.subarray(offset, offset + 1_048_576);
        const fsb = Object.assign(new standards.FSB.FSBT(), { REQUEST_ID: 1n, CHUNK_SEQUENCE: sequence,
          FINAL: offset + part.length === bytes.length, TOTAL_BYTES: BigInt(bytes.length),
          SCHEMA_NAME: item.resource.id.slice(0, 64), DATA: [...part], SHA256: [...Buffer.from(sha256(bytes), 'hex')] });
        const builder = new Builder(); builder.finish(fsb.pack(builder), '$FSB');
        response = await h.invoke({ methodId: 'fit', inputs: [{ portId: port, typeRef: fsbType, payload: builder.asUint8Array() }] });
        collect(response);
      }
      let objects = new Set(readFB(Buffer.concat(streams.omm)).map(objectKey)).size;
      while (response?.yielded && objects < limit) {
        response = await h.invoke({ methodId: 'fit', inputs: [] }); collect(response);
        objects = new Set(readFB(Buffer.concat(streams.omm)).map(objectKey)).size;
      }
      const omms = readFB(Buffer.concat(streams.omm));
      const ocms = readFB(Buffer.concat(streams.ocm));
      const obds = readFB(Buffer.concat(streams.obd));
      const { writeFB } = await import('spacedatastandards.org');
      const seen = new Set();
      for (let i = 0; i < omms.length && rows.length < limit; i++) {
        const key = objectKey(omms[i]);
        if (seen.has(key)) continue; seen.add(key);
        if (!ocms[i] || !obds[i]) throw new Error('Incomplete native OD product triplet');
        // These two native parsers never supply NORAD identity; the fitter's
        // internal 99999 / 99999A seed is not an upstream catalog identifier.
        if (port === 'glonass' || port === 'intelsat') {
          omms[i].NORAD_CAT_ID = 0; omms[i].OBJECT_ID = null; obds[i].SAT_NO = 0; obds[i].ORIG_OBJECT_ID = null;
          if (ocms[i].METADATA) { ocms[i].METADATA.OBJECT_DESIGNATOR = null; ocms[i].METADATA.INTERNATIONAL_DESIGNATOR = null; }
        }
        const failure = fitFailure(obds[i].WRMS);
        if (failure) { rows.push({ failure, fit: { ...omms[i], RMS: obds[i].WRMS } }); continue; }
        rows.push({ fit: { ...omms[i], RMS: obds[i].WRMS }, canScore: false,
          products: { omm: writeFB(omms[i]), ocm: writeFB(ocms[i]), obd: writeFB(obds[i]) } });
      }
      if (!rows.length) throw new Error('Native OD parser produced no fitted objects');
      return rows;
    } finally { await h.destroy(); if (bytes !== item.bytes) bytes.fill(0); }
  }
  async close() { await this.queue; await this.harness?.destroy(); this.harness = null; }
}
