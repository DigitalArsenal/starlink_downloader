import { starlinkSource } from './starlink.mjs';
import { onewebSource } from './oneweb.mjs';
import { planetSource } from './planet.mjs';
import { issSource } from './iss.mjs';
import { sesSource } from './ses.mjs';
import { intelsatSource } from './intelsat.mjs';
import { telesatSource } from './telesat.mjs';
import { cssSource } from './css.mjs';
import { gpsSource, glonassSource } from './gnss.mjs';
import { esaPodSource } from './esa-pod.mjs';
import { cpfSource } from './cpf.mjs';
import { fetchMemory, mapBounded } from '../lib/http.mjs';

export const anonymous = [starlinkSource, onewebSource, planetSource, issSource, sesSource,
  intelsatSource, telesatSource, cssSource, gpsSource, glonassSource, esaPodSource, cpfSource];
export const credentialed = ['spire', 'vimpel', 'cpf-edc', 'space-track'].map(id => ({
  id, discover: async () => [], note: 'Credentialed getter is inert in phase 1; no credential is read or sent.',
}));
export const sources = [...anonymous, ...credentialed];
export async function getSource(source, { limit = 50, consume, note = () => {}, fetchImpl = fetch }) {
  if (source.note) { note(source.note); return; }
  const http = { getText: async url => {
    try { return (await fetchMemory(url, { source: source.id, fetchImpl })).bytes.toString('utf8'); }
    catch (error) { note(`Discovery request: ${error.message}; ${url}`); throw error; }
  } };
  const resources = (await source.discover({ http, limit: Number.isFinite(limit) ? limit : undefined })).slice(0, limit);
  if (!resources.length) note('Discovery returned no resources (listing may be empty or changed).');
  await mapBounded(resources, source.id === 'spacex-starlink' ? 32 : 4, async resource => {
    try {
      const fetched = await fetchMemory(resource.url, { source: source.id, fetchImpl,
        range: source.id === 'spacex-starlink' ? 128 * 1024 : undefined });
      try { await consume({ ...fetched, resource, source }); }
      finally { fetched.bytes.fill(0); }
    } catch (error) { note(error.message); }
  });
}
