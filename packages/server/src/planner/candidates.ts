/**
 * Kandidatmängden: slå ihop, deduplicera, filtrera hårt, poängsätt.
 *
 * All matte kommer ur @mindful/core. Den här filen räknar ingenting själv — den bestämmer
 * bara VILKA rutter som får finnas kvar och i vilken ordning. Skulle den räkna nyhet eller
 * skönhet på egen hand hade planeraren optimerat mot ett annat tal än det användaren läser,
 * och den buggen går aldrig att stänga (CONTRACT, ingressen).
 */

import {
  H3_DEDUP_RES, TURNS_PER_KM_MAX,
  beauty as beautyOf, cellToParent, fractionOf, isNatural, naturalContext, novelKm as novelKmOf,
  reversals, routeCells, score, selfOverlap, sharing, turnsPerKm,
} from '@mindful/core';
import type { NaturalContext, Route, RouteCells, VisitedIndex, Waypoint } from '@mindful/core';

import { DEDUP_JACCARD, TOP_N } from './context.js';
import type { PlanCandidate } from './context.js';

// ─── Dedup ──────────────────────────────────────────────────────────────────

/**
 * Ruttens celler på H3 res 9 (≈ 175 m). Grovare än nyhetens res 11 — med flit.
 *
 * Två rutter som kör samma väg men råkar ha kodats med några meters skillnad ska räknas
 * som SAMMA rutt. På res 11 (50 m) hade den skillnaden gjort dem olika; på res 9 är den
 * borta, medan två vägar som verkligen går 200 m isär fortfarande hålls isär.
 */
function dedupCells(c: RouteCells): Set<bigint> {
  const out = new Set<bigint>();
  for (const h3 of c.cells) out.add(cellToParent(h3, H3_DEDUP_RES));
  return out;
}

/** |A ∩ B| / |A ∪ B|. 0..1. */
function jaccard(a: ReadonlySet<bigint>, b: ReadonlySet<bigint>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;

  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Kasta kandidater som är samma rutt som en vi redan har.
 *
 * `keep` är de rutter som är givna (baslinjen). Ordningen i `pool` avgör vem som överlever
 * en krock — anroparen lägger alltså de bästa först.
 *
 * Motorns egna alternativ är den vanliga källan till dubbletter: Valhalla ger gärna två
 * "alternativ" som skiljer sig åt på 300 m i en rondell. Att visa dem som två olika förslag
 * vore att ljuga om valet.
 */
export function dedupe(
  pool: readonly RouteCells[], keep: readonly RouteCells[] = [],
): RouteCells[] {
  const seen = keep.map(dedupCells);
  const out: RouteCells[] = [];

  for (const candidate of pool) {
    const cells = dedupCells(candidate);
    if (seen.some((other) => jaccard(cells, other) > DEDUP_JACCARD)) continue;

    seen.push(cells);
    out.push(candidate);
  }

  return out;
}

// ─── Måtten användaren ser ──────────────────────────────────────────────────

/**
 * Kilometer motorväg och trunk. → "2,1 km E4 gick tyvärr inte att undvika."
 *
 * Saknas vägklasserna svarar `fractionOf` 0, och det är rätt: frånvaro av data är inte
 * bevis för motorväg. Vi hittar aldrig på en vägklass vi inte observerat.
 */
export function motorwayKm(c: RouteCells): number {
  const f = fractionOf(c.route.roadClassSpans, ['motorway', 'trunk'], c.shape);
  return f * (c.route.distanceM / 1000);
}

/**
 * Kilometer obelagd väg. → "Grus sista biten."
 *
 * Både `gravel` och `dirt`: båda är grus i förarens öron, och båda är vackra
 * (SURFACE_BEAUTY 0,90 respektive 0,75). Det är leran vi inte gillar, och den finns inte
 * som ytklass.
 */
export function gravelKm(c: RouteCells): number {
  const f = fractionOf(c.route.surfaceSpans, ['gravel', 'dirt'], c.shape);
  return f * (c.route.distanceM / 1000);
}

// ─── Poängsättning ──────────────────────────────────────────────────────────

export interface Scoring {
  readonly baseline: Route;
  readonly baselineCells: ReadonlySet<bigint>;
  readonly T0: number;
  readonly Tmax: number;
  readonly mem: VisitedIndex;
  readonly today: number;
}

/**
 * En kandidat, färdig för klienten. `extra` är lägets egen justering av U(P) — noll i
 * läge (a), tidsavvikelsen i läge (b).
 *
 * `through` är de okända vägbitarna rutten tvingades genom. Baslinjen och motorns egna
 * alternativ har inga — de gick ingenstans särskilt.
 */
export function candidateOf(
  c: RouteCells, s: Scoring, kind: 'baseline' | 'candidate', extra = 0,
  through: readonly Waypoint[] = [],
): PlanCandidate {
  return {
    route: c.route,
    novelKm: novelKmOf(c.route, s.mem, s.today),
    beauty: beautyOf(c),
    motorwayKm: motorwayKm(c),
    gravelKm: gravelKm(c),
    score: score({
      route: c,
      baseline: s.baseline,
      baselineCells: s.baselineCells,
      T0: s.T0,
      Tmax: s.Tmax,
      mem: s.mem,
      today: s.today,
    }) + extra,
    kind,
    through,
  };
}

export interface SelectOptions {
  /** Lägets egen justering av U(P). Noll i läge (a). */
  readonly extraOf?: (c: RouteCells) => number;
  /** De okända vägbitarna kandidaten tvingades genom. Följer med ut till klienten. */
  readonly throughOf?: (c: RouteCells) => readonly Waypoint[];
  readonly topN?: number;
  readonly log?: (line: string) => void;
}

/**
 * Sista svängen i varje läge: filtrera hårt, poängsätt, ta de bästa.
 *
 * `isNatural` är ett HÅRT filter, aldrig en straffterm (CONTRACT §5.3). Abraham/Delling/
 * Goldberg/Werneck mätte den naiva straffmetoden: >5 omvägar i snitt, upp till 15,
 * "unnatural to most users". En rutt som ser ut som en tarm läser som en bugg — och gör
 * dig stressad även om den är 100 % ny väg.
 *
 * ⛔ Baslinjen filtreras ALDRIG. Den är inte ett förslag, den är referensen: "raka vägen",
 *    så att man kan jämföra. Den hade dessutom fallit på sitt eget `sharing`-test —
 *    den delar per definition 100 % av vägen med sig själv.
 */
export function selectBest(
  pool: readonly RouteCells[],
  ctx: NaturalContext,
  scoring: Scoring,
  opts: SelectOptions = {},
): { readonly best: PlanCandidate[]; readonly survived: number } {
  const extraOf = opts.extraOf ?? (() => 0);
  const throughOf = opts.throughOf ?? ((): readonly Waypoint[] => []);
  const topN = opts.topN ?? TOP_N;
  const log = opts.log ?? ((): void => {});

  const natural: RouteCells[] = [];

  for (const c of pool) {
    if (isNatural(c, ctx)) {
      natural.push(c);
      continue;
    }
    // En kastad kandidat ska kunna förklara sig. Utan det är "noll förslag" en gåta, och
    // gåtan löses med gissningar i stället för med mätning.
    log(`kastad: ${(c.route.distanceM / 1000).toFixed(1)} km,`
      + ` ${(c.route.timeS / 60).toFixed(0)} min — ${whyUnnatural(c, ctx).join(', ')}`);
  }

  const scored = natural
    .map((c) => candidateOf(c, scoring, 'candidate', extraOf(c), throughOf(c)))
    .sort((a, b) => b.score - a.score);

  return { best: scored.slice(0, topN), survived: natural.length };
}

/** Vilka av de hårda villkoren i §5.3 föll kandidaten på? Samma ordning som `isNatural`. */
export function whyUnnatural(c: RouteCells, ctx: NaturalContext): string[] {
  const r = c.route;
  const tpk = turnsPerKm(r);
  const why: string[] = [];

  if (tpk > 1.6 * ctx.baselineTurnsPerKm) why.push(`svängar ${tpk.toFixed(2)}/km mot baslinjen`);
  if (tpk > TURNS_PER_KM_MAX) why.push(`svängar ${tpk.toFixed(2)}/km över taket`);
  if (reversals(c) > 0) why.push(`${reversals(c)} riktningsomkastningar`);
  if (r.maneuvers.some((m) => m.type === 'uturn')) why.push('u-sväng');

  const self = selfOverlap(c);
  if (self > 0.05) why.push(`självöverlapp ${(self * 100).toFixed(1)} %`);

  const share = sharing(c, ctx.baselineCells);
  if (share > 0.80) why.push(`delar ${(share * 100).toFixed(0)} % med baslinjen`);

  if (r.timeS > ctx.Tmax) {
    why.push(`${(r.timeS / 60).toFixed(0)} min över budgetens ${(ctx.Tmax / 60).toFixed(0)}`);
  }

  return why;
}

// ─── Sammanhanget för ett helt svep ─────────────────────────────────────────

/**
 * Baslinjen avkodas och dilateras EN gång per planering, inte en gång per kandidat.
 * `sharing` frågar 40 gånger per svep; utan detta hade baslinjens 8 400 celler byggts om
 * varje gång (se core/scoring.ts).
 */
export function sweepContext(baseline: Route, Tmax: number): {
  readonly cells: RouteCells;
  readonly natural: NaturalContext;
} {
  return { cells: routeCells(baseline), natural: naturalContext(baseline, Tmax) };
}
