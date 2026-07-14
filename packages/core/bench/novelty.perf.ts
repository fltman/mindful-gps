/**
 * Prestandabenchmark för nyhetsberäkningen. CONTRACT §3.3:
 *
 *   "30 km rutt = 1 200 sampel × 7 uppslag (cell + gridDisk).
 *    Binärsökning i sorterad BigUint64Array ≈ 80 ns → under 1 ms per kandidat.
 *    20 kandidater ≈ 20 ms."
 *
 * Kör:  npx tsx packages/core/bench/novelty.perf.ts
 *
 * Minnet fylls med 178 000 celler — kontraktets egen siffra för 5 000 km körning (§3.5)
 * — genom att slumpa vägliknande spår runt Göteborg och densifiera dem till 15 m.
 * Testrutten ligger PÅ en av de vägarna, så varje uppslag träffar. Det är det dyra fallet.
 */

import { performance } from 'node:perf_hooks';

import { H3_RES, SAMPLE_M } from '../src/constants.js';
import { haversine, resample } from '../src/geo.js';
import { cell, gridDisk, VisitedIndex, type CellVisit } from '../src/h3util.js';
import { cellNovelty, routeNovelty, todayDay } from '../src/novelty.js';
import type { LngLat } from '../src/types.js';

// ─── Syntetisk geografi ─────────────────────────────────────────────────────

/** Determinism: samma minne och samma rutter varje körning. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

const GBG: LngLat = [11.9746, 57.7089];
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos(GBG[1] * Math.PI / 180);

/**
 * Ett vägliknande spår: slumpvandring med trög kurs, så att kurvaturen hamnar i samma
 * härad som en riktig landsväg i stället för att bli vitt brus.
 */
function road(start: LngLat, headingDeg: number, meters: number, stepM: number,
              rand: () => number): LngLat[] {
  const pts: LngLat[] = [start];
  let [lon, lat] = start;
  let h = headingDeg;

  for (let d = 0; d < meters; d += stepM) {
    h += (rand() - 0.5) * 6;            // ~±3° per steg → mjuka kurvor
    const r = h * Math.PI / 180;
    lat += (Math.cos(r) * stepM) / M_PER_DEG_LAT;
    lon += (Math.sin(r) * stepM) / M_PER_DEG_LON;
    pts.push([lon, lat]);
  }
  return pts;
}

/** Klipp polylinen vid `meters` längs vägen. */
function clip(pts: readonly LngLat[], meters: number): LngLat[] {
  const out: LngLat[] = [];
  let acc = 0;
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev) acc += haversine(prev, p);
    out.push(p);
    if (acc >= meters) break;
  }
  return out;
}

// ─── Minnet: 178 000 celler ─────────────────────────────────────────────────

console.log('Bygger minne (~178 000 celler = 5 000 km enligt CONTRACT §3.5) …');
const t0 = performance.now();

const rand = rng(20200101);
const seen = new Set<bigint>();

// Testrutten är den första vägen — den ligger alltså i minnet.
const testRoad = road(GBG, 30, 31_000, 15, rand);
for (const p of testRoad) seen.add(cell(p, H3_RES));

while (seen.size < 178_000) {
  const start: LngLat = [
    GBG[0] + (rand() - 0.5) * 0.9,       // ~±27 km
    GBG[1] + (rand() - 0.5) * 0.45,
  ];
  for (const p of road(start, rand() * 360, 8_000 + rand() * 20_000, 15, rand)) {
    seen.add(cell(p, H3_RES));
  }
}

const today = todayDay();
const mem = VisitedIndex.empty();
const all = [...seen];
mem.upsert(all.map((h3): CellVisit => ({ h3, axisMask: 1 })), today);
// Pendlaren har kört sina vägar mer än en gång. Utan visits ≥ 2 slår grannvillkoret i
// softFamiliarity aldrig till, och då mäter vi fel gren.
mem.upsert(all.filter((_, i) => i % 2 === 0).map((h3): CellVisit => ({ h3, axisMask: 1 })), today);

console.log(`  ${mem.size} celler, byggt på ${(performance.now() - t0).toFixed(0)} ms\n`);

// ─── Rutterna ───────────────────────────────────────────────────────────────

const shapeKnown = clip(testRoad, 30_000);                                  // körd förut
const shapeNew = clip(road([GBG[0] + 1.4, GBG[1] + 0.6], 200, 31_000, 20, rng(777)), 30_000);

function km(pts: readonly LngLat[]): number {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversine(pts[i - 1]!, pts[i]!);
  return m / 1000;
}

const ptsKnown = resample(shapeKnown, SAMPLE_M);
const ptsNew = resample(shapeNew, SAMPLE_M);
const distinct = new Set(ptsKnown.map(p => cell(p, H3_RES))).size;

console.log(`Rutt "känd väg": ${km(shapeKnown).toFixed(1)} km, ${ptsKnown.length} sampel, `
  + `${distinct} distinkta celler (${(ptsKnown.length / distinct).toFixed(2)} sampel/cell), `
  + `nyhet ${routeNovelty(shapeKnown, mem, today).toFixed(3)}`);
console.log(`Rutt "ny väg":   ${km(shapeNew).toFixed(1)} km, ${ptsNew.length} sampel, `
  + `nyhet ${routeNovelty(shapeNew, mem, today).toFixed(3)}\n`);

// ─── Mätning ────────────────────────────────────────────────────────────────

function bench(name: string, iters: number, fn: () => void): number {
  for (let i = 0; i < Math.max(5, iters / 5); i++) fn();   // uppvärmning (JIT)

  const s: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    fn();
    s.push(performance.now() - t);
  }
  s.sort((a, b) => a - b);

  const median = s[Math.floor(s.length / 2)] ?? 0;
  const p95 = s[Math.floor(s.length * 0.95)] ?? 0;
  console.log(`${name.padEnd(44)} median ${median.toFixed(3).padStart(7)} ms   `
    + `p95 ${p95.toFixed(3).padStart(7)} ms   ×20 = ${(median * 20).toFixed(1).padStart(6)} ms`);
  return median;
}

console.log('KRAV (CONTRACT §3.3): < 1,00 ms per kandidat, ~20 ms för 20 kandidater\n');

const medKnown = bench('routeNovelty — 30 km, känd väg', 60, () => { routeNovelty(shapeKnown, mem, today); });
bench('routeNovelty — 30 km, ny väg', 60, () => { routeNovelty(shapeNew, mem, today); });

console.log('\nVar tar tiden vägen? (känd väg, 1 200 sampel)\n');

const cells = ptsKnown.map(p => cell(p, H3_RES));
bench('  resample(shape, 25)', 60, () => { resample(shapeKnown, SAMPLE_M); });
bench('  cell() × 1 200', 60, () => { for (const p of ptsKnown) cell(p, H3_RES); });
bench('  gridDisk(c, 1) × 1 200', 60, () => { for (const c of cells) gridDisk(c, 1); });
bench('  mem.get() × 1 200 × 8', 60, () => { for (const c of cells) for (let k = 0; k < 8; k++) mem.get(c); });
bench('  cellNovelty() × 1 200', 60, () => { for (const c of cells) cellNovelty(c, mem, today); });

console.log('');
console.log(medKnown < 1
  ? `✅ ${medKnown.toFixed(2)} ms — under kontraktets 1 ms.`
  : `❌ ${medKnown.toFixed(2)} ms — ${(medKnown / 1).toFixed(1)}× ÖVER kontraktets 1 ms. `
    + `20 kandidater: ${(medKnown * 20).toFixed(0)} ms mot målet 20 ms.`);
