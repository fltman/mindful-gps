/**
 * ⚠️ HISTORIK. Båda åtgärderna nedan är numera SHIPPADE i src/ (novelty.ts: cellsNovelty
 *    cachar konsekutiva sampel; h3util.ts: VisitedIndex bär grann-maxet förberäknat).
 *    Filen ligger kvar som mätningen som motiverade dem — "nuvarande routeNovelty" i
 *    utskriften är alltså inte längre den långsamma varianten.
 *
 * Prototyp: två åtgärder mot att routeNovelty ligger 2,2× över kontraktets 1 ms-krav.
 *
 *  A. Cachea cellNovelty över konsekutiva sampel i samma cell.
 *     SAMPLE_M = 25 m och cellbredden 49,6 m → kontraktet räknar självt med
 *     "~2 sampel per cell". Varannan gridDisk är alltså ren dubbelräkning.
 *
 *  B. Förberäkna grann-maxet vid indexbygget → gridDisk försvinner HELT ur heta loopen.
 *     familiarity(c, today) = S(visits) · exp(lastSeen/τ) · exp(−today/τ)
 *     Faktorn exp(−today/τ) är GEMENSAM för alla celler → vilken granne som vinner
 *     max() är oberoende av `today`. Den kan alltså bestämmas en gång, vid bygget.
 *
 * Kör:  npx tsx packages/core/bench/fix-prototype.perf.ts
 */

import { performance } from 'node:perf_hooks';

import { H3_RES, NEIGHBOR_SOFTNESS, SAMPLE_M, TAU_DAYS, VISIT_SATURATION } from '../src/constants.js';
import { haversine, resample } from '../src/geo.js';
import { familiarity } from '../src/familiarity.js';
import { cell, gridDisk, VisitedIndex, type CellVisit } from '../src/h3util.js';
import { cellNovelty, routeNovelty, todayDay } from '../src/novelty.js';
import type { LngLat } from '../src/types.js';

// ─── Samma syntetiska geografi som novelty.perf.ts ──────────────────────────

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

function clip(pts: LngLat[], meters: number): LngLat[] {
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

const rand = rng(20200101);
const seen = new Map<bigint, number>();
const roads: LngLat[][] = [];

// Första vägen är EXAKT den 30 km-rutt kontraktet räknar på — och den ligger i minnet,
// så varje uppslag träffar. Det är det dyraste fallet.
const testRoad = road(GBG, 30, 31_000, 15, rand);
roads.push(testRoad);
for (const p of testRoad) { const c = cell(p, H3_RES); seen.set(c, (seen.get(c) ?? 0) + 1); }

while (seen.size < 178_000) {
  const start: LngLat = [GBG[0] + (rand() - 0.5) * 0.9, GBG[1] + (rand() - 0.5) * 0.45];
  const r = road(start, rand() * 360, 8_000 + rand() * 20_000, 15, rand);
  roads.push(r);
  for (const p of r) { const c = cell(p, H3_RES); seen.set(c, (seen.get(c) ?? 0) + 1); }
}

const today = todayDay();
const mem = VisitedIndex.empty();
mem.upsert([...seen.keys()].map((h3): CellVisit => ({ h3, axisMask: 1 })), today);
mem.upsert(
  [...seen.keys()].filter((_, i) => i % 2 === 0).map((h3): CellVisit => ({ h3, axisMask: 1 })),
  today,
);

// En 30 km-rutt PÅ känd väg (dyraste fallet: varje uppslag träffar).
const shape30 = clip(testRoad, 30_000);

// ─── A: cachea konsekutiva sampel ───────────────────────────────────────────

function routeNoveltyDeduped(shape: readonly LngLat[], m: VisitedIndex, day: number): number {
  const pts = resample(shape, SAMPLE_M);
  let sum = 0;
  let prevCell: bigint | undefined;
  let prevNov = 0;
  for (const p of pts) {
    const c = cell(p, H3_RES);
    if (c !== prevCell) { prevNov = cellNovelty(c, m, day); prevCell = c; }
    sum += prevNov;
  }
  return pts.length ? sum / pts.length : 1;
}

// ─── B: förberäknat grann-max ───────────────────────────────────────────────

/** Sorterat sidoindex: för varje cell, DEN granne (visits ≥ 2) som maximerar familiarity. */
class NeighborIndex {
  readonly h3: BigUint64Array;
  readonly visits: Uint8Array;
  readonly day: Uint16Array;

  constructor(h3: BigUint64Array, visits: Uint8Array, day: Uint16Array) {
    this.h3 = h3; this.visits = visits; this.day = day;
  }

  /** Rankningsnyckeln. Oberoende av `today` — se filhuvudet. */
  static #key(visits: number, day: number): number {
    return (1 - Math.exp(-VISIT_SATURATION * visits)) * Math.exp(day / TAU_DAYS);
  }

  static build(cells: readonly { h3: bigint; visits: number; lastSeenDay: number }[]): NeighborIndex {
    const best = new Map<bigint, { v: number; d: number; k: number }>();
    for (const c of cells) {
      if (c.visits < 2) continue;                  // svaga spår smittar inte
      const k = NeighborIndex.#key(c.visits, c.lastSeenDay);
      for (const n of gridDisk(c.h3, 1)) {
        const cur = best.get(n);
        if (!cur || k > cur.k) best.set(n, { v: c.visits, d: c.lastSeenDay, k });
      }
    }
    const keys = [...best.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const h3 = new BigUint64Array(keys.length);
    const visits = new Uint8Array(keys.length);
    const day = new Uint16Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const b = best.get(k)!;
      h3[i] = k; visits[i] = b.v; day[i] = b.d;
    }
    return new NeighborIndex(h3, visits, day);
  }

  lookup(h3: bigint): { visits: number; lastSeenDay: number } | undefined {
    let lo = 0, hi = this.h3.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.h3[mid]! < h3) lo = mid + 1; else hi = mid;
    }
    if (lo >= this.h3.length || this.h3[lo] !== h3) return undefined;
    return { visits: this.visits[lo]!, lastSeenDay: this.day[lo]! };
  }
}

function routeNoveltyFast(shape: readonly LngLat[], m: VisitedIndex, nbr: NeighborIndex,
                          day: number): number {
  const pts = resample(shape, SAMPLE_M);
  let sum = 0;
  let prevCell: bigint | undefined;
  let prevNov = 0;

  for (const p of pts) {
    const c = cell(p, H3_RES);
    if (c !== prevCell) {
      const self = m.get(c);
      const own = self ? familiarity(self, day) : 0;
      const n = nbr.lookup(c);
      const best = n ? familiarity({ h3: c, visits: n.visits, lastSeenDay: n.lastSeenDay, axisMask: 0 }, day) : 0;
      prevNov = 1 - Math.max(own, NEIGHBOR_SOFTNESS * best);
      prevCell = c;
    }
    sum += prevNov;
  }
  return pts.length ? sum / pts.length : 1;
}

// ─── Mät ────────────────────────────────────────────────────────────────────

function bench(name: string, iters: number, fn: () => void): number {
  for (let i = 0; i < 10; i++) fn();
  const s: number[] = [];
  for (let i = 0; i < iters; i++) { const t = performance.now(); fn(); s.push(performance.now() - t); }
  s.sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)] ?? 0;
  console.log(`${name.padEnd(50)} ${med.toFixed(3).padStart(7)} ms   ×20 = ${(med * 20).toFixed(1).padStart(6)} ms`);
  return med;
}

const pts = resample(shape30, SAMPLE_M);
const distinct = new Set(pts.map(p => cell(p, H3_RES))).size;
let km = 0;
for (let i = 1; i < shape30.length; i++) km += haversine(shape30[i - 1]!, shape30[i]!);

console.log(`Minne: ${mem.size} celler.  Rutt: ${(km / 1000).toFixed(1)} km, ${pts.length} sampel → ${distinct} distinkta celler (${(pts.length / distinct).toFixed(2)} sampel/cell)\n`);

const tB = performance.now();
const cellsForBuild = [...seen.keys()].map((h3, i) => ({ h3, visits: i % 2 === 0 ? 2 : 1, lastSeenDay: today }));
const nbr = NeighborIndex.build(cellsForBuild);
const buildMs = performance.now() - tB;

console.log('KRAV (CONTRACT §3.3): < 1,00 ms per kandidat, ~20 ms för 20 kandidater\n');
const base = bench('nuvarande routeNovelty', 60, () => { routeNovelty(shape30, mem, today); });
const dedup = bench('A: + cache av konsekutiva sampel', 60, () => { routeNoveltyDeduped(shape30, mem, today); });
const fast = bench('B: + förberäknat grann-max (ingen gridDisk)', 60, () => { routeNoveltyFast(shape30, mem, nbr, today); });

console.log('');
console.log(`A ger  ${(base / dedup).toFixed(2)}×`);
console.log(`A+B ger ${(base / fast).toFixed(2)}×`);
console.log('');
console.log(`NeighborIndex: ${nbr.h3.length} poster, ${((nbr.h3.length * 11) / 1e6).toFixed(1)} MB, byggtid ${buildMs.toFixed(0)} ms (en gång)`);

// Identisk matte? Kontrollera mot referensen, cell för cell.
let maxDiff = 0;
for (const p of pts.slice(0, 2000)) {
  const c = cell(p, H3_RES);
  const ref = cellNovelty(c, mem, today);
  const self = mem.get(c);
  const own = self ? familiarity(self, today) : 0;
  const n = nbr.lookup(c);
  const best = n ? familiarity({ h3: c, visits: n.visits, lastSeenDay: n.lastSeenDay, axisMask: 0 }, today) : 0;
  maxDiff = Math.max(maxDiff, Math.abs(ref - (1 - Math.max(own, NEIGHBOR_SOFTNESS * best))));
}
console.log(`Största avvikelse mot referensmatten: ${maxDiff.toExponential(2)}`);
console.log(`routeNovelty: ${routeNovelty(shape30, mem, today).toFixed(9)} vs ${routeNoveltyFast(shape30, mem, nbr, today).toFixed(9)}`);
