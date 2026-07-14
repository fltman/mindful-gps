/**
 * Hela poängsättningen per kandidat: isNatural() + score().
 * Det är DEN vägen som körs 20 gånger, inte routeNovelty ensam.
 *
 * Kör:  npx tsx packages/core/bench/scoring.perf.ts
 */

import { performance } from 'node:perf_hooks';

import { H3_RES } from '../src/constants.js';
import { decode6, encode6, haversine } from '../src/geo.js';
import { cell, VisitedIndex, type CellVisit } from '../src/h3util.js';
import { cellsNovelty, todayDay } from '../src/novelty.js';
import { beauty, dilate, isNatural, naturalContext, reversals, routeCells, score,
         selfOverlap, sharing } from '../src/scoring.js';
import type { LngLat, Maneuver, Route } from '../src/types.js';

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

const rand = rng(20200101);
const seen = new Set<bigint>();
while (seen.size < 178_000) {
  const start: LngLat = [GBG[0] + (rand() - 0.5) * 0.9, GBG[1] + (rand() - 0.5) * 0.45];
  for (const p of road(start, rand() * 360, 8_000 + rand() * 20_000, 15, rand)) {
    seen.add(cell(p, H3_RES));
  }
}
const today = todayDay();
const mem = VisitedIndex.empty();
mem.upsert([...seen].map((h3): CellVisit => ({ h3, axisMask: 1 })), today);

// Valhalla ger ~1 nod var 20:e meter på en landsväg. 30 km → ~1 500 noder.
const shape = road(GBG, 30, 30_000, 20, rng(4242));
const baseShape = road(GBG, 30, 28_000, 20, rng(99));

function fakeRoute(pts: LngLat[], id: string): Route {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += haversine(pts[i - 1]!, pts[i]!);
  const maneuvers: Maneuver[] = [];
  for (let i = 0; i < 40; i++) {
    maneuvers.push({
      type: i % 3 === 0 ? 'turn' : 'continue',
      distanceM: m / 40, timeS: 30, shapeIndex: [i * 30, (i + 1) * 30],
    });
  }
  return {
    id, geometry: encode6(pts), distanceM: m, timeS: m / 15, maneuvers,
    roadClassSpans: Array.from({ length: 12 }, (_, i) => ({
      fromIdx: Math.floor(i * pts.length / 12),
      toIdx: Math.floor((i + 1) * pts.length / 12),
      value: (['secondary', 'tertiary', 'unclassified', 'primary'] as const)[i % 4]!,
    })),
    surfaceSpans: Array.from({ length: 6 }, (_, i) => ({
      fromIdx: Math.floor(i * pts.length / 6),
      toIdx: Math.floor((i + 1) * pts.length / 6),
      value: (['paved', 'gravel'] as const)[i % 2]!,
    })),
    engine: 'valhalla@3.5.1',
  };
}

const route = fakeRoute(shape, 'kandidat');
const baseline = fakeRoute(baseShape, 'baseline');

// Svepets engångskostnad: baselines dilaterade cellmängd. Kandidaten avkodas en gång.
const ctx = naturalContext(baseline, baseline.timeS * 1.35);
const cand = routeCells(route);
const input = { route: cand, baseline, baselineCells: ctx.baselineCells,
                T0: baseline.timeS, Tmax: ctx.Tmax, mem, today };

function bench(name: string, iters: number, fn: () => void): number {
  for (let i = 0; i < 10; i++) fn();
  const s: number[] = [];
  for (let i = 0; i < iters; i++) { const t = performance.now(); fn(); s.push(performance.now() - t); }
  s.sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)] ?? 0;
  console.log(`${name.padEnd(42)} ${med.toFixed(3).padStart(8)} ms   ×20 = ${(med * 20).toFixed(1).padStart(7)} ms`);
  return med;
}

console.log(`Rutt: ${(route.distanceM / 1000).toFixed(1)} km, ${decode6(route.geometry).length} noder. Minne: ${mem.size} celler.\n`);
console.log('KRAV (CONTRACT §3.3): 20 kandidater ≈ 20 ms\n');

const tCells = bench('routeCells(r) — avkoda + sampla en gång', 30, () => { routeCells(route); });
const tNat = bench('isNatural(c, ctx)', 30, () => { isNatural(cand, ctx); });
const tScore = bench('score(i)', 30, () => { score(input); });
console.log('');
bench('  varav cellsNovelty', 30, () => { cellsNovelty(cand.cells, mem, today); });
bench('  varav sharing (förbyggd baselinemängd)', 30, () => { sharing(cand, ctx.baselineCells); });
bench('  varav selfOverlap', 30, () => { selfOverlap(cand); });
bench('  varav beauty', 30, () => { beauty(cand); });
bench('  varav reversals', 30, () => { reversals(cand); });
bench('  varav decode6', 30, () => { decode6(route.geometry); });
console.log('');
bench('EN GÅNG PER SVEP: dilate(baseline)', 30, () => { dilate(decode6(baseline.geometry)); });

console.log('');
console.log(`En kandidat: avkodning + filter + poäng   ${(tCells + tNat + tScore).toFixed(2)} ms`);

const tSvep = bench('HELA SVEPET: 20 kandidater', 15, () => {
  const c = naturalContext(baseline, baseline.timeS * 1.35);
  for (let k = 0; k < 20; k++) {
    const rc = routeCells(route);
    if (isNatural(rc, c)) {
      score({ route: rc, baseline, baselineCells: c.baselineCells,
              T0: baseline.timeS, Tmax: c.Tmax, mem, today });
    }
  }
});

console.log('');
console.log(tSvep < 20
  ? `✅ ${tSvep.toFixed(1)} ms för 20 kandidater — inom kontraktets ~20 ms (§3.3).`
  : `❌ ${tSvep.toFixed(1)} ms för 20 kandidater mot kontraktets ~20 ms (§3.3).`);
