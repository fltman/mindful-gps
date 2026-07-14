/**
 * Nyheten. CONTRACT §3.3 och §4 — FRUSEN MATTE.
 *
 * Det här är produkten. Talet `novelKm()` returnerar är exakt det tal användaren läser
 * ("62 av 80 km är nya för dig") OCH exakt det tal planeraren optimerar mot. Två
 * implementationer hade blivit två siffror, och två siffror blir buggrapporter för alltid.
 *
 * Själva familiaritetsformeln bor i `familiarity.ts` — den delas med minnets förberäknade
 * grann-max (h3util.ts) och får därför bara finnas på ett ställe.
 */

import {
  EPOCH_DAY0,
  H3_RES,
  METERS_PER_CELL,
  NEIGHBOR_SOFTNESS,
  SAMPLE_M,
} from './constants.js';
import { familiarityOf } from './familiarity.js';
import { decode6, resample } from './geo.js';
import { cell, type VisitedIndex } from './h3util.js';
import type { LngLat, RoadSegment, Route } from './types.js';

const MS_PER_DAY = 86_400_000;

/** Dagar sedan EPOCH_DAY0. Samma dagnummer på klienten och på servern. */
export function todayDay(nowMs: number = Date.now()): number {
  return Math.floor((nowMs - EPOCH_DAY0) / MS_PER_DAY);
}

/**
 * Mjukt medlemskap: en GRANNCELL till en starkt känd cell räknas som delvis känd.
 * Tar hand om GPS-brus (±5–10 m) utan att kollapsa parallella vägar 50 m isär.
 * Grannen bidrar bara om den har visits ≥ 2 — svaga spår smittar inte.
 *
 * Ringen slås aldrig upp här. Vilken granne som vinner `max` beror inte på dagen, så
 * minnet har redan avgjort det vid skrivningen (`VisitedIndex.strongNeighborOf`). Kvar
 * blir två binärsökningar; med en `gridDisk` per sampel hade en enda kandidat kostat mer
 * än hela kontraktets millisekund (§3.3).
 */
export function softFamiliarity(h3: bigint, mem: VisitedIndex, today: number): number {
  const i = mem.indexOf(h3);
  const own = i < 0 ? 0 : familiarityOf(mem.visitsAt(i), mem.lastSeenDayAt(i), today);

  // Grannbidraget är 0,35 · best ≤ 0,35. Är den egna familiariteten redan så hög kan
  // grannen per definition inte ändra svaret.
  if (own >= NEIGHBOR_SOFTNESS) return own;

  const n = mem.strongNeighborOf(h3);
  const best = n < 0
    ? 0
    : familiarityOf(mem.neighborVisitsAt(n), mem.neighborLastSeenDayAt(n), today);

  return Math.max(own, NEIGHBOR_SOFTNESS * best);
}

export function cellNovelty(h3: bigint, mem: VisitedIndex, today: number): number {
  return 1 - softFamiliarity(h3, mem, today);
}

/**
 * Ruttens H3-celler, ett sampel var SAMPLE_M meter.
 *
 * Kandidatens dyraste gemensamma nämnare: `routeNovelty`, `selfOverlap` och `sharing`
 * samplar alla på exakt SAMPLE_M. Räknas de var för sig avkodas, samplas om och
 * cellifieras samma 1 200 punkter tre gånger per kandidat.
 */
export function sampleCells(shape: readonly LngLat[]): BigUint64Array {
  const pts = resample(shape, SAMPLE_M);
  const cells = new BigUint64Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p !== undefined) cells[i] = cell(p, H3_RES);
  }
  return cells;
}

/**
 * Distansviktad nyhet för färdiga sampelceller. 0..1.
 *
 * SAMPLE_M är 25 m och cellen är 49,6 m bred — kontraktet räknar självt med "~2 sampel
 * per cell" (§3.1). Konsekutiva sampel i samma cell har samma nyhet, så den räknas om
 * först när cellen byts. Talet är oförändrat; bara arbetet är det.
 */
export function cellsNovelty(
  cells: BigUint64Array,
  mem: VisitedIndex,
  today: number,
): number {
  if (cells.length === 0) return 1;

  let sum = 0;
  let prev: bigint | undefined;
  let novelty = 0;

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c === undefined) continue;
    if (c !== prev) {
      novelty = cellNovelty(c, mem, today);
      prev = c;
    }
    sum += novelty;
  }

  return sum / cells.length;
}

/** Distansviktad nyhet för en hel rutt. 0..1. */
export function routeNovelty(
  shape: readonly LngLat[],
  mem: VisitedIndex,
  today: number,
): number {
  return cellsNovelty(sampleCells(shape), mem, today);
}

/** DETTA är talet som visas: "62 av 80 km är nya för dig". */
export function novelKm(r: Route, mem: VisitedIndex, today: number): number {
  return routeNovelty(decode6(r.geometry), mem, today) * (r.distanceM / 1000);
}

/**
 * "Ditt nät" — unik väg, i kilometer. Ur cellerna, aldrig ur odometern.
 *
 * Skillnaden är hela produkten: en pendlare som kört samma fyra mil till jobbet
 * 200 gånger har ett nät på 40 km, inte 8 000. Summerar man turernas längd
 * gratulerar appen honom för upprepning — precis det beteende den finns för att bryta.
 */
export function netKm(cellCount: number): number {
  return (cellCount * METERS_PER_CELL) / 1000;
}

/**
 * Segmentnyhet är KONTINUERLIG, aldrig binär (CONTRACT §4).
 *
 * En binär "har jag kört den här vägen?" kollapsar till noll kandidater i användarens
 * hemtrakt — där appen används mest. En OSM-way är ofta kilometerlång, och efter ett
 * halvår hemma är nästan varje way DELVIS körd. Därför: 400 m-segment vid ingest, och
 * FRAKTIONELL täckning här.
 */
export function segmentNovelty(s: RoadSegment, mem: VisitedIndex, today: number): number {
  if (!s.h3.length) return 0;
  let sum = 0;
  for (const c of s.h3) sum += cellNovelty(c, mem, today);
  return sum / s.h3.length;
}
