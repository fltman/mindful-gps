/**
 * ⚠️ HISTORIK. Fixen är shippad: `dilate()` bygger baselines cellmängd EN gång per svep,
 *    och `sharing()` tar den färdiga mängden. "NU" nedan är den gamla implementationen,
 *    bevarad här som jämförelse.
 *
 * sharing() byggde om baseline-mängden vid VARJE anrop — och anropades två gånger per
 * kandidat (en gång i isNatural, en gång i score). Baseline är samma rutt hela vägen.
 *
 * Kör:  npx tsx packages/core/bench/sharing.perf.ts
 */

import { performance } from 'node:perf_hooks';

import { H3_RES, SAMPLE_M } from '../src/constants.js';
import { decode6, encode6, resample } from '../src/geo.js';
import { cell, gridDisk } from '../src/h3util.js';
import { dilate, routeCells, sharing } from '../src/scoring.js';
import type { LngLat, Route } from '../src/types.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1_664_525 + 1_013_904_223) >>> 0; return s / 4_294_967_296; };
}
const GBG: LngLat = [11.9746, 57.7089];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(GBG[1] * Math.PI / 180);

function road(start: LngLat, headingDeg: number, meters: number, stepM: number,
              rand: () => number): LngLat[] {
  const pts: LngLat[] = [start];
  let [lon, lat] = start;
  let h = headingDeg;
  for (let d = 0; d < meters; d += stepM) {
    h += (rand() - 0.5) * 6;
    const r = h * Math.PI / 180;
    lat += (Math.cos(r) * stepM) / M_PER_DEG_LAT;
    lon += (Math.sin(r) * stepM) / M_PER_DEG_LON;
    pts.push([lon, lat]);
  }
  return pts;
}

const baseShape = road(GBG, 30, 30_000, 20, rng(99));
const candidates: Route[] = Array.from({ length: 20 }, (_, i) => {
  const s = road(GBG, 30 + i, 30_000, 20, rng(1000 + i));
  return { id: `k${i}`, geometry: encode6(s), distanceM: 30_000, timeS: 2000,
           maneuvers: [], engine: 'valhalla@3.5.1' };
});

/** Den gamla sharing(): baseline-mängden byggdes om vid varje anrop. */
function sharingRebuild(r: Route, baselineShape: readonly LngLat[]): number {
  const mine = resample(decode6(r.geometry), SAMPLE_M);
  if (mine.length === 0) return 0;
  const theirs = new Set<bigint>();
  for (const p of resample(baselineShape, SAMPLE_M)) {
    for (const n of gridDisk(cell(p, H3_RES), 1)) theirs.add(n);
  }
  if (theirs.size === 0) return 0;
  let shared = 0;
  for (const p of mine) if (theirs.has(cell(p, H3_RES))) shared++;
  return shared / mine.length;
}

function bench(name: string, iters: number, fn: () => void): number {
  for (let i = 0; i < 5; i++) fn();
  const s: number[] = [];
  for (let i = 0; i < iters; i++) { const t = performance.now(); fn(); s.push(performance.now() - t); }
  s.sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)] ?? 0;
  console.log(`${name.padEnd(56)} ${med.toFixed(2).padStart(8)} ms`);
  return med;
}

console.log('20 kandidater mot samma baseline, 30 km vardera.\n');

const now = bench('FÖRE: 40 × sharing() som byggde om mängden', 15, () => {
  for (const c of candidates) { sharingRebuild(c, baseShape); sharingRebuild(c, baseShape); }
});

const fixed = bench('EFTER: dilate() en gång + 20 × sharing()', 15, () => {
  const theirs = dilate(baseShape);
  for (const c of candidates) sharing(routeCells(c), theirs);
});

console.log(`\n${(now / fixed).toFixed(1)}× — och svaret är identiskt: ` +
  `${sharingRebuild(candidates[0]!, baseShape).toFixed(9)} vs ` +
  `${sharing(routeCells(candidates[0]!), dilate(baseShape)).toFixed(9)}`);

const t = performance.now();
const set = dilate(baseShape);
console.log(`\nBaseline-Set: ${set.size} celler, ${(performance.now() - t).toFixed(2)} ms att bygga — × 40 = ${((performance.now() - t) * 40).toFixed(0)} ms bortkastat.`);
