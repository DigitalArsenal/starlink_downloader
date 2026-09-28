import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256 } from './http.mjs';

// Binding policy: space-data-network-modules/analysis/conjunction-assessment/
// scripts/CELESTRAK_FETCH_POLICY.md. Serial >=2500 ms; URL ledger >=3 hours;
// 429/503: 60 seconds, one retry; stop after 30 consecutive failures. No bypass.
export const THREE_HOURS = 10_800_000;
export class Celestrak {
  constructor(out, { fetchImpl = fetch, now = Date.now, wait = sleep } = {}) {
    Object.assign(this, { out, fetchImpl, now, wait });
    this.queue = Promise.resolve(); this.failures = 0; this.lastRequest = -Infinity;
  }
  get(group) {
    const url = `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=${encodeURIComponent(group)}&FORMAT=json`;
    const request = this.queue.then(() => this.fetchURL(url));
    this.queue = request.catch(() => {});
    return request;
  }
  async fetchURL(url) {
    if (this.failures >= 30) throw new Error('CelesTrak halted after 30 consecutive failed requests');
    const ledgerPath = path.join(this.out, 'celestrak-ledger.json');
    let ledger;
    try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ledger = {}; }
    this.lastRequest = Math.max(this.lastRequest, ...Object.values(ledger).map(entry => entry.at));
    const cachedPath = path.join(this.out, `supgp-${sha256(url)}.json`);
    const prior = ledger[url];
    if (prior && this.now() - prior.at < THREE_HOURS) {
      if (!prior.success) throw new Error('CelesTrak ledger refuses repeat within 3 hours (previous attempt failed)');
      try { return { rows: JSON.parse(await readFile(cachedPath, 'utf8')), url, cached: true }; }
      catch { throw new Error('CelesTrak ledger refuses repeat within 3 hours; cache unavailable'); }
    }
    const save = async () => {
      await writeFile(`${ledgerPath}.tmp`, JSON.stringify(ledger, null, 2));
      await rename(`${ledgerPath}.tmp`, ledgerPath);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.wait(Math.max(0, 2500 - (this.now() - this.lastRequest)));
      this.lastRequest = this.now();
      ledger[url] = { at: this.lastRequest, success: false };
      await save(); // Reserve before network I/O, including failures/crashes.
      let response;
      try { response = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) }); }
      catch (error) { this.failures++; throw new Error(`CelesTrak network failure: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`); }
      if (response.status !== 200) {
        await response.body?.cancel(); this.failures++;
        if (this.failures >= 30) throw new Error('CelesTrak halted after 30 consecutive failed requests');
        if ([429, 503].includes(response.status) && attempt === 0) { await this.wait(60_000); continue; }
        throw new Error(`CelesTrak HTTP ${response.status}`);
      }
      let rows;
      try { rows = await response.json(); if (!Array.isArray(rows)) throw new Error('Expected OMM array'); }
      catch (error) { this.failures++; throw new Error(`Invalid CelesTrak JSON: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`); }
      await writeFile(cachedPath, JSON.stringify(rows));
      ledger[url] = { at: this.now(), success: true }; await save(); this.failures = 0;
      return { rows, url, cached: false };
    }
  }
}

// Group names checked against https://celestrak.org/NORAD/elements/supplemental/
// on 2026-09-28. ESA POD has no dedicated SupGP group.
export const groups = {
  'spacex-starlink': ['starlink'], 'eutelsat-oneweb': ['oneweb'], planet: ['planet'],
  iss: ['iss'], ses: ['ses'], intelsat: ['intelsat'], telesat: ['telesat'],
  'css-tiangong': ['css'], 'gps-precise': ['gps'], 'glonass-precise': ['glonass'],
  'esa-pod': ['gps', 'glonass', 'cpf'], cpf: ['cpf'],
};
