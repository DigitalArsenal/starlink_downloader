import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm, unlink, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Processor, fitFailure } from '../lib/process.mjs';
import { readFB } from '../lib/products.mjs';
import { compare, closestReference } from '../lib/compare.mjs';
import { Celestrak, THREE_HOURS } from '../lib/celestrak.mjs';
import { OUTPUTS, isDeclaredOutput, validateOutput } from '../lib/output.mjs';
import { run } from '../lib/run.mjs';
import { fetchMemory } from '../lib/http.mjs';
import { parseArgs } from '../bin/retrieve.mjs';
const fixturePath = new URL('../../test/fixtures/starlink_sample.txt', import.meta.url);
const reference = {
  OBJECT_NAME: 'FIXTURE', NORAD_CAT_ID: 99999, EPOCH: '2026-06-25T21:29:41.999990Z',
  MEAN_MOTION: 15.51107026, ECCENTRICITY: 0.0002062, INCLINATION: 53.2169,
  RA_OF_ASC_NODE: 26.7629, ARG_OF_PERICENTER: 183.3723, MEAN_ANOMALY: 244.9823,
  BSTAR: 4.18183e-4, MEAN_MOTION_DOT: 1.74932e-3, MEAN_MOTION_DDOT: 0,
};
async function temp(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'retriever-test-')); t.after(() => rm(dir, { recursive: true })); return dir; }
async function fixture(t) {
  const processor = new Processor(); t.after(() => processor.close());
  const item = { source: { id: 'spacex-starlink' }, bytes: await readFile(fixturePath),
    resource: { noradId: 99999, hints: { satelliteName: 'FIXTURE' } }, provenance: { source: 'fixture' } };
  t.after(() => item.bytes.fill(0)); return { processor, item };
}
test('real WASM fixture GP fit stays below 0.5 km and produces SDS records', async t => {
  const { processor, item } = await fixture(t);
  const [fitted] = await processor.fit(item);
  assert.ok(Number(fitted.fit.RMS) < 0.5, `RMS ${fitted.fit.RMS}`);
  assert.equal(fitted.fit.NORAD_CAT_ID, 99999);
  for (const [type, bytes] of Object.entries(fitted.products)) {
    assert.equal(bytes.subarray(8, 12).toString(), `$${type.toUpperCase()}`);
    assert.equal(readFB(bytes).length, 1);
  }
  assert.equal(readFB(fitted.products.omm)[0].OBJECT_NAME, 'FIXTURE');
  assert.ok(processor.artifacts.every(a => /^[0-9a-f]{64}$/.test(a.sha256)));
  t.diagnostic(`WASM fixture RMS ${fitted.fit.RMS} km`);
});
test('fixed SupGP-like elements are scored in WASM on the identical fixture states', async t => {
  const { processor, item } = await fixture(t); const [fitted] = await processor.fit(item);
  const result = await compare(processor, item, fitted, [reference]);
  assert.equal(result.record.verdict, 'AGREE');
  assert.ok(result.record.supgpRmsKm < 0.5);
  assert.ok(Math.abs(result.record.ourRmsKm - result.record.supgpRmsKm) < 0.01);
  assert.equal(result.record.ourMaxErrorKm, null);
  assert.equal(readFB(result.supgp)[0].NORAD_CAT_ID, 99999);
  const mismatch = await compare(processor, item, fitted, [{ ...reference, MEAN_ANOMALY: 280 }]);
  assert.equal(mismatch.record.verdict, 'DISAGREE'); assert.equal(mismatch.record.worse, 'SupGP');
  const stale = await compare(processor, item, fitted, [{ ...reference, EPOCH: '2026-06-23T00:00:00Z' }]);
  assert.equal(stale.record.verdict, 'NOT_COMPARED');
  assert.equal(closestReference({ ...reference, NORAD_CAT_ID: 0 }, [reference]), null);
  t.diagnostic(`same-state RMS ours ${result.record.ourRmsKm}, reference ${result.record.supgpRmsKm} km`);
});
test('ledger reuses GP cache and refuses repeat with missing cache within 3 hours', async t => {
  const out = await temp(t); let calls = 0; let time = 100000;
  const client = new Celestrak(out, { now: () => time, wait: async ms => { time += ms; },
    fetchImpl: async () => { calls++; return Response.json([reference]); } });
  await client.get('starlink'); assert.equal((await client.get('starlink')).cached, true); assert.equal(calls, 1);
  const cache = (await readdir(out)).find(name => name.startsWith('supgp-')); await unlink(path.join(out, cache));
  await assert.rejects(client.get('starlink'), /ledger refuses repeat/); assert.equal(calls, 1);
  time += THREE_HOURS; await client.get('starlink'); assert.equal(calls, 2);
});
test('CelesTrak serial floor, 60-second backoff, one retry, persistent failure reservation', async t => {
  const out = await temp(t); let time = 100000; const times = [];
  const client = new Celestrak(out, { now: () => time, wait: async ms => { time += ms; },
    fetchImpl: async () => { times.push(time); return new Response('', { status: 429 }); } });
  await assert.rejects(client.get('starlink'), /HTTP 429/); assert.equal(times.length, 2); assert.equal(times[1] - times[0], 60000);
  await assert.rejects(client.get('starlink'), /ledger refuses repeat/); assert.equal(times.length, 2);
  await assert.rejects(client.get('oneweb'), /HTTP 429/); assert.ok(times[2] - times[1] >= 2500);
});
test('integration writes only declared derived outputs and allowed SupGP cache', async t => {
  const out = await temp(t); const bytes = await readFile(fixturePath);
  const fetchImpl = async (url, options) => {
    if (url.includes('celestrak.org')) return Response.json([reference]);
    if (url.endsWith('MANIFEST.txt')) return new Response('MEME_99999_FIXTURE_x_Operational_1_UNCLASSIFIED.txt\n');
    assert.equal(options.headers.Range, 'bytes=0-131071');
    const range = bytes.subarray(0, 131072);
    return new Response(range, { status: 206, headers: { 'Content-Range': `bytes 0-${range.length - 1}/${bytes.length}`, ETag: 'fixture' } });
  };
  const result = await run({ sourceIds: ['spacex-starlink'], limit: 1, out, fetchImpl });
  assert.equal(result.sources[0].fitted, 1); assert.equal(result.sources[0].compared, 1);
  const files = await readdir(out); assert.ok(files.every(isDeclaredOutput));
  for (const name of OUTPUTS) assert.ok(files.includes(name));
  assert.ok(!files.includes('.retriever.lock'));
  assert.equal(readFB(await readFile(path.join(out, 'omm.fsb'))).length, 1);
  for (const name of files) assert.ok(!(await readFile(path.join(out, name))).includes(bytes.subarray(0, 100)), `raw fixture leaked to ${name}`);
  const row = JSON.parse((await readFile(path.join(out, 'comparison.jsonl'), 'utf8')).trim());
  assert.equal(row.provenance.status, 206); assert.match(row.provenance.sha256, /^[0-9a-f]{64}$/);
});
test('unsafe output paths, including symlink aliases into repo, are rejected', async t => {
  const repo = path.resolve(new URL('../..', import.meta.url).pathname);
  await assert.rejects(validateOutput(path.join(repo, 'do-not-create')), /outside/);
  const dir = await temp(t); await symlink(repo, path.join(dir, 'alias'));
  await assert.rejects(validateOutput(path.join(dir, 'alias', 'do-not-create')), /outside/);
});
test('credentialed getters are inert and discovery failure does not stop other sources', async t => {
  const out = await temp(t); let calls = 0;
  const result = await run({ out, supgp: false, sourceIds: ['spacex-starlink', 'spire', 'vimpel', 'cpf-edc', 'space-track'],
    fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } });
  assert.equal(calls, 1); assert.equal(result.sources.length, 5);
  assert.ok(result.sources[0].notes.some(note => /Discovery failed.*404/.test(note)));
  for (const source of result.sources.slice(1)) { assert.equal(source.fetched, 0); assert.match(source.notes[0], /inert/); }
});
test('Starlink range refusal fails closed and CLI limits are explicit', async () => {
  await assert.rejects(fetchMemory('https://example.invalid/a', { range: 131072, fetchImpl: async () => new Response('not a range') }), /not honored/);
  assert.equal(parseArgs([]).limit, 50); assert.equal(parseArgs(['--all']).limit, Infinity);
  assert.throws(() => parseArgs(['--all', '--limit', '10']), /mutually exclusive/);
  assert.throws(() => parseArgs(['--limit', '0']), /positive/);
});

// Archive helpers are container/network plumbing; the only payload here is a synthetic format marker.
test('CSS archive extraction stays in memory and selects OEM KVN', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const { firstOemInZip } = await import('../lib/containers.mjs');
  const bytes = firstOemInZip(zipSync({ 'readme.txt': strToU8('format notes'), 'orbit.txt': strToU8('CCSDS_OEM_VERS = 2.0\n') }));
  assert.match(Buffer.from(bytes).toString(), /^CCSDS_OEM_VERS/);
  assert.throws(() => firstOemInZip(zipSync({ 'x.txt': strToU8('not OEM') })), /no OEM/);
});

test('WASM failure sentinels cannot be reported as successful fits', () => {
  assert.match(fitFailure(1000000), /propagation-failure sentinel/);
  assert.match(fitFailure(NaN), /non-finite/);
  assert.equal(fitFailure(0.101), null);
});

test('CelesTrak over Tor keeps the policy and parses curl status', async () => {
  const { parseArgs } = await import('../bin/retrieve.mjs');
  const { curlArgs, torFetch } = await import('../lib/tor.mjs');
  assert.equal(parseArgs(['--celestrak-via', 'tor']).celestrakVia, 'tor');
  assert.throws(() => parseArgs(['--celestrak-via', 'proxy']), /direct or tor/);
  assert.deepEqual(curlArgs('https://x/y', '127.0.0.1:9050').slice(0, 3), ['-sS', '--socks5-hostname', '127.0.0.1:9050']);
  const fake = (cmd, args, opts, cb) => { cb(null, Buffer.from('[{"NORAD_CAT_ID":1}]\n200')); return { kill() {} }; };
  const response = await torFetch('https://celestrak.org/x', { run: fake });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ NORAD_CAT_ID: 1 }]);
});

