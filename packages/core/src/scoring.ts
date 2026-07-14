/**
 * Skönhet, naturlighet och U(P). CONTRACT §5.2–§5.4 — FRUSEN MATTE.
 *
 * ⚠️ Alla sex koefficienterna i `score()` är HYPOTESER. De kalibreras mot `bench/` (§7).
 *    Ändrar du en av dem utan att köra benchmarken vet du inte om rutterna blev bättre
 *    — bara att de blev annorlunda.
 *
 * ── Två avvikelser från kontraktets pseudokod, och varför ────────────────────
 *
 * 1. §5.2 skriver `weightedByLength(r.roadClassSpans, CLASS_BEAUTY, r.distanceM)`.
 *    Ett spann är ett INDEX-intervall; ur `distanceM` går det inte att få fram hur många
 *    METER just det spannet täcker. Den enda funktion som gick att skriva på den
 *    signaturen hade viktat på antal shape-index — och polyline-noder sitter tätare i
 *    kurvor än på raksträckor, så kurviga partier hade fått orimligt stor vikt.
 *    Funktionen heter `weightedByLength`, och då ska den vikta på LÄNGD. Därför tar den
 *    (och `fractionOf`) den avkodade shapen i stället för `distanceM`.
 *
 * 2. Kandidaten avkodas och samplas EN gång, till `RouteCells`, och baselines dilaterade
 *    cellmängd byggs EN gång per planeringssvep i stället för en gång per anrop till
 *    `sharing`. Kontraktets pseudokod låter varje funktion börja om från `Route`; gjorde
 *    vi det avkodades samma geometri sex gånger per kandidat och baselines 8 400 celler
 *    byggdes om 40 gånger per plan — 90 av 141 ms rent dubbelarbete, mot §3.3:s budget
 *    på 20 ms för 20 kandidater.
 *
 * Formeln — koefficienterna, tabellerna, termerna — är oförändrad i båda fallen.
 */

import {
  CLASS_BEAUTY, H3_RES, SAMPLE_M, SURFACE_BEAUTY, TURNS_PER_KM_MAX,
} from './constants.js';
import { curvatureDegPerKm, curvatureScore } from './curvature.js';
import { angleDiff, bearing, clamp01, decode6, haversine, resample } from './geo.js';
import { cell, gridDiskInto, type VisitedIndex } from './h3util.js';
import { cellsNovelty, sampleCells } from './novelty.js';
import type { LngLat, Route, Span } from './types.js';

/**
 * Saknas spans helt vet vi ingenting om vägens karaktär. Då ska den varken belönas
 * eller straffas. Samma tal som SURFACE_BEAUTY.unknown — kontraktets eget "vet ej".
 */
const NEUTRAL_BEAUTY = 0.5;

/**
 * Två passager genom samma H3-cell är samma väg bara om det gått en bit väg emellan.
 * En polyline som ligger och skvalpar längs en cellgräns pendlar in och ut ur cellen
 * på några tiotals meter — det är geometri, inte en slinga. 200 m är fyra cellbredder.
 */
const SELF_OVERLAP_MIN_SEP_M = 200;

/** Kursomkastning: fönstrens bäringar pekar mer än 120° isär (cos < -0,5). */
const REVERSAL_WINDOW_M = 1000;
const REVERSAL_DOT_MAX = -0.5;

// ─── Kandidaten, avkodad en gång ────────────────────────────────────────────

/**
 * En kandidat avkodad och samplad EN gång: shapen plus H3-cellen för varje sampel.
 *
 * `routeNovelty`, `selfOverlap` och `sharing` samplar alla på exakt SAMPLE_M och tittar
 * alla på res 11. De ska titta på samma punkter — inte var och en räkna fram dem igen.
 */
export interface RouteCells {
  readonly route: Route;
  readonly shape: LngLat[];
  /** En cell per sampel, i ordning. Sampelavståndet är SAMPLE_M. */
  readonly cells: BigUint64Array;
}

/** Avkoda och sampla kandidaten. En gång per kandidat, sedan skickas den vidare. */
export function routeCells(r: Route): RouteCells {
  const shape = decode6(r.geometry);
  return { route: r, shape, cells: sampleCells(shape) };
}

/**
 * Baselines celler plus deras ring (dilationen). En gång per PLANERINGSSVEP.
 *
 * Ringen äter upp jitter mellan två oberoende kodade polylines av SAMMA väg, men är
 * alldeles för liten för att slå ihop två parallella vägar 200 m isär. Det är precis den
 * skillnaden hela produkten står och faller med (§7).
 */
export function dilate(shape: readonly LngLat[]): Set<bigint> {
  const cells = new Set<bigint>();
  const disk: bigint[] = [];

  for (const p of resample(shape, SAMPLE_M)) {
    const n = gridDiskInto(cell(p, H3_RES), 1, disk);
    for (let k = 0; k < n; k++) {
      const c = disk[k];
      if (c !== undefined) cells.add(c);
    }
  }

  return cells;
}

// ─── Hjälpmatte för spann ───────────────────────────────────────────────────

/** Kumulativ väglängd fram till varje nod. */
function prefixLengths(shape: readonly LngLat[]): number[] {
  const prefix: number[] = [];
  let acc = 0;
  let prev: LngLat | undefined;
  for (const p of shape) {
    if (prev) acc += haversine(prev, p);
    prefix.push(acc);
    prev = p;
  }
  return prefix;
}

/** Spannets längd i meter. Halvöppet över KANTERNA: noderna fromIdx..toIdx. */
function spanLengthM(prefix: readonly number[], span: Span<unknown>): number {
  const n = prefix.length;
  if (n === 0) return 0;
  const lo = Math.min(Math.max(0, span.fromIdx), n - 1);
  const hi = Math.min(Math.max(0, span.toIdx), n - 1);
  return Math.max(0, (prefix[hi] ?? 0) - (prefix[lo] ?? 0));
}

/**
 * Längdviktat medelvärde av en tabell över spann. 0..1.
 * Nämnaren är den TÄCKTA längden — täcker spannen bara halva rutten ska den halvan
 * ändå betygsättas rätt, inte dras mot noll.
 */
export function weightedByLength<T extends string>(
  spans: readonly Span<T>[] | undefined,
  table: Readonly<Record<T, number>>,
  shape: readonly LngLat[],
): number {
  if (!spans || spans.length === 0) return NEUTRAL_BEAUTY;

  const prefix = prefixLengths(shape);
  let weighted = 0;
  let covered = 0;

  for (const s of spans) {
    const m = spanLengthM(prefix, s);
    weighted += m * table[s.value];
    covered += m;
  }

  return covered > 0 ? weighted / covered : NEUTRAL_BEAUTY;
}

/**
 * Andel av rutten (av dess LÄNGD) som har något av de angivna värdena. 0..1.
 *
 * Saknas spans returneras 0, inte 0,5: frånvaro av data är inte bevis för motorväg,
 * och en rutt ska inte straffas för ett fält motorn inte råkade fylla i.
 */
export function fractionOf<T extends string>(
  spans: readonly Span<T>[] | undefined,
  values: readonly T[],
  shape: readonly LngLat[],
): number {
  if (!spans || spans.length === 0) return 0;

  const prefix = prefixLengths(shape);
  const total = prefix[prefix.length - 1] ?? 0;
  if (total <= 0) return 0;

  let hit = 0;
  for (const s of spans) {
    if (values.includes(s.value)) hit += spanLengthM(prefix, s);
  }

  return clamp01(hit / total);
}

// ─── §5.2 Skönhet ───────────────────────────────────────────────────────────

export function beauty(c: RouteCells): number {
  const r = c.route;
  const cls = weightedByLength(r.roadClassSpans, CLASS_BEAUTY, c.shape);
  const surf = weightedByLength(r.surfaceSpans, SURFACE_BEAUTY, c.shape);
  const curv = curvatureScore(curvatureDegPerKm(c.shape));
  const rural = 1 - fractionOf(r.roadClassSpans, ['residential', 'living_street'], c.shape);
  return 0.45 * cls + 0.30 * curv + 0.15 * surf + 0.10 * rural;
}

// ─── §5.3 isNatural — ett HÅRT FILTER, inte en straffterm ───────────────────

export interface NaturalContext {
  readonly baselineTurnsPerKm: number;
  /** Baselines dilaterade celler — `dilate(decode6(baseline.geometry))`. */
  readonly baselineCells: ReadonlySet<bigint>;
  readonly Tmax: number;             // T0 × (1 + ε)
}

/** Sammanhanget för hela svepet. Baseline avkodas och dilateras en enda gång. */
export function naturalContext(baseline: Route, Tmax: number): NaturalContext {
  return {
    baselineTurnsPerKm: turnsPerKm(baseline),
    baselineCells: dilate(decode6(baseline.geometry)),
    Tmax,
  };
}

/** Svängar per kilometer. Rondelltillfarter räknas, rondellutfarter gör det inte. */
export function turnsPerKm(r: Route): number {
  const km = r.distanceM / 1000;
  if (km <= 0) return 0;
  const turns = r.maneuvers.filter(m =>
    m.type === 'turn' || m.type === 'fork' || m.type === 'roundabout_enter',
  ).length;
  return turns / km;
}

/**
 * Hur stor del av rutten som delas med baseline. 0..1. (ADGW:s γ.)
 *
 * Jämförelsen görs på H3 res 11 (~50 m) mot baselines dilaterade cellmängd — se
 * `dilate`. Mängden är densamma för hela svepet och byggs därför inte här.
 */
export function sharing(c: RouteCells, baselineCells: ReadonlySet<bigint>): number {
  if (c.cells.length === 0 || baselineCells.size === 0) return 0;

  let shared = 0;
  for (let i = 0; i < c.cells.length; i++) {
    const h3 = c.cells[i];
    if (h3 !== undefined && baselineCells.has(h3)) shared++;
  }

  return shared / c.cells.length;
}

/**
 * Antal riktningsomkastningar. 1 km-fönster, bäringsdot < -0,5.
 *
 * Fönstren är kedjade och överlappar inte — en enda U-sväng ska räknas en gång, inte
 * en gång per sampel.
 */
export function reversals(c: RouteCells): number {
  const pts = resample(c.shape, REVERSAL_WINDOW_M);
  if (pts.length < 3) return 0;

  const bearings: number[] = [];
  let prev: LngLat | undefined;
  for (const p of pts) {
    if (prev) {
      // Sista fönstret är resten av rutten och kan vara några meter långt — dess
      // bäring är brus. Släng det.
      const m = haversine(prev, p);
      if (m >= REVERSAL_WINDOW_M / 2) bearings.push(bearing(prev, p));
    }
    prev = p;
  }

  let count = 0;
  for (let i = 1; i < bearings.length; i++) {
    const a = bearings[i - 1];
    const b = bearings[i];
    if (a === undefined || b === undefined) continue;
    if (Math.cos(angleDiff(a, b) * Math.PI / 180) < REVERSAL_DOT_MAX) count++;
  }

  return count;
}

/** Andel av rutten som korsar sig själv. 0..1. Ingen H3-cell två gånger i samma rutt. */
export function selfOverlap(c: RouteCells): number {
  const cells = c.cells;
  if (cells.length === 0) return 0;

  const minSepSamples = SELF_OVERLAP_MIN_SEP_M / SAMPLE_M;
  const firstSeen = new Map<bigint, number>();
  let overlapping = 0;

  for (let i = 0; i < cells.length; i++) {
    const h3 = cells[i];
    if (h3 === undefined) continue;
    const seen = firstSeen.get(h3);
    if (seen === undefined) firstSeen.set(h3, i);
    else if (i - seen > minSepSamples) overlapping++;
  }

  return overlapping / cells.length;
}

export function isNatural(c: RouteCells, ctx: NaturalContext): boolean {
  const r = c.route;
  const tpk = turnsPerKm(r);

  // Svängtäthet, RELATIVT baseline. Bohuslän och Skåne har helt olika svängtäthet
  // i grunden — ett absolut tak vore fel normering.
  if (tpk > 1.6 * ctx.baselineTurnsPerKm) return false;
  if (tpk > TURNS_PER_KM_MAX) return false;                // absolut tak (stadsgytter)

  if (reversals(c) > 0) return false;
  if (r.maneuvers.some(m => m.type === 'uturn')) return false;
  if (selfOverlap(c) > 0.05) return false;
  if (sharing(c, ctx.baselineCells) > 0.80) return false;  // ADGW γ = 80 %
  if (r.timeS > ctx.Tmax) return false;                    // användarens budget, HÅRT
  return true;
}

// ─── §5.4 Scoringfunktionen — U(P) ──────────────────────────────────────────

export interface ScoreInput {
  readonly route: RouteCells;
  readonly baseline: Route;
  /** Baselines dilaterade celler. Samma mängd som i NaturalContext — bygg den en gång. */
  readonly baselineCells: ReadonlySet<bigint>;
  readonly T0: number;
  readonly Tmax: number;
  readonly mem: VisitedIndex;
  readonly today: number;
}

/** Alla delvärden 0..1. */
export function score(i: ScoreInput): number {
  const c = i.route;
  const r = c.route;

  const nov = cellsNovelty(c.cells, i.mem, i.today);
  const bty = beauty(c);
  const timeCost = clamp01((r.timeS - i.T0) / Math.max(1, i.Tmax - i.T0));

  // Baseline utan en enda sväng ger 0 i nämnare. Då finns ingen relativ norm: varje
  // sväng vi lägger till är per definition maximalt onaturlig, och noll svängar är gratis.
  const baseTpk = turnsPerKm(i.baseline);
  const myTpk = turnsPerKm(r);
  const turnCost = baseTpk > 0
    ? clamp01(myTpk / (1.6 * baseTpk))
    : (myTpk > 0 ? 1 : 0);

  const mway = fractionOf(r.roadClassSpans, ['motorway', 'trunk'], c.shape);
  const share = sharing(c, i.baselineCells);

  return 1.00 * nov        // nyhet ÄR produkten
       + 0.35 * bty        // vackrare väg
       - 0.30 * timeCost   // vi RESPEKTERAR budgeten, vi jagar den inte
       - 0.25 * turnCost   // naturlighet (utöver det hårda filtret)
       - 0.40 * mway       // motorväg är motsatsen till produkten
       - 0.15 * share;     // vi vill ha genuint OLIKA kandidater
}
