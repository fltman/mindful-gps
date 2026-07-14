/**
 * Läge (c) — upptäcktsläget: routa inte alls. Fyra anrop per ben.
 *
 * Att lösa det här exakt är Arc Orienteering Problem — NP-hårt (Knapsack + TSP). Gör det
 * inte. Den "rätta" lösningen är en girig policy PER KORSNING mot en offline-korsningsgraf,
 * och den kräver antingen att vi rekonstruerar topologi ur vektortiles som bevisligen inte
 * har någon, eller en Overpass-fråga per korsning (bannad efter ~30 användare).
 *
 * Vi är giriga per BEN i stället — var ~6:e km. Det är en dag i stället för två veckor, och
 * FÖRAREN MÄRKER INTE SKILLNADEN: hen får en röst som säger "sväng höger här, den vägen har
 * du aldrig kört".
 *
 *   0  kopplet            1 isokron (per session, cachad 30 d)  ← 0 anrop under körning
 *   1  kasta mål          0 anrop
 *   2  snappa             1 locate
 *   3  rutta              ≤3 route (parallellt)
 *   4  välj               0 anrop  ← kopplet är en point-in-polygon-fråga
 *
 * ⭐ Ett anrop per ben, och kopplet kostar noll. Upptäcktsläget fungerar i
 *    mobiltäckningsskugga — vilket är precis där de vackra små vägarna finns.
 *
 * ⭐ OFF-ROUTE ÄR INTE ETT FEL. Svänger föraren "fel" har hen inte kört fel — hen har
 *    hittat en väg till. Nästa ben planeras från där hen faktiskt är. Ingen
 *    omberäkningsstress, ingen U-sväng. Det ligger i klienten; det som ligger HÄR är att
 *    ett ben alltid planeras från `from`, aldrig från "där du borde ha varit".
 */

import {
  RouteEngineError, TURNS_PER_KM_MAX,
  beauty as beautyOf, cellsNovelty, clamp01, fractionOf, resample, routeCells, sampleCells,
  turnsPerKm,
} from '@mindful/core';
import type { LngLat, Route, RouteCells, SnappedPoint } from '@mindful/core';

import { gravelKm, motorwayKm } from './candidates.js';
import { ANCHOR_CLASSES, ANCHOR_SNAP, settle } from './context.js';
import type { PlanCandidate, PlanContext, PlanResult } from './context.js';
import { LEASH_CONTOURS_S, leashOf, timeHomeS } from './leash.js';

export interface PlanExploreInput {
  /** Var föraren ÄR. Aldrig där hen borde ha varit. */
  readonly from: LngLat;
  /** Hemmet — den punkt kopplet mäts mot. */
  readonly home: LngLat;
  /** Kompassnålen. Riktningen föraren dragit ut. */
  readonly headingDeg: number;
  /** Kvarvarande budget, i sekunder. */
  readonly seconds: number;
}

/** Benets längd. Grovt med flit: girigt per ben, inte per korsning. */
const LEG_MIN_M = 6_000;
const LEG_MAX_M = 8_000;

/** Tre mål, spridda över kompassnålens kon. */
const TARGETS = 3;
const FAN_DEG = 30;

/**
 * Kopplet: målet måste ligga inom 0,85 av kvarvarande budget hem.
 *
 * Marginalen bär två fel på en gång: att isokronen mäter tiden HEMIFRÅN och inte hem, och
 * att benet dit tar tid det också. Snålt är rätt — den som får slut på budget 40 km
 * hemifrån har inte fått en upplevelse, hen har fått ett problem.
 */
const LEASH_MARGIN = 0.85;

const EARTH_R_M = 6_371_008.8;
const DEG = Math.PI / 180;

export async function planExplore(
  ctx: PlanContext, input: PlanExploreInput,
): Promise<PlanResult> {
  const started = Date.now();
  const { engine, mem, today, prefs, signal } = ctx;
  const log = ctx.log ?? (() => {});

  if (!engine.caps.isochrone) {
    throw new RouteEngineError('bad_request', 'motorn har inga isokroner — kopplet kräver dem');
  }

  let calls = 0;

  // ── 0. KOPPLET ──────────────────────────────── [1 anrop, cachat 30 d per hem]

  const polygons = await engine.isochrone(input.home, LEASH_CONTOURS_S, prefs);
  calls++;
  const leash = leashOf(input.home, LEASH_CONTOURS_S, polygons);

  // ── 1. KASTA MÅL ────────────────────────────────────────────────── [0 anrop]

  const thrown = throwTargets(ctx, input);
  const budget = input.seconds * LEASH_MARGIN;

  // Kopplet, INNAN vi ruttar: ett mål vi ändå inte kan komma hem ifrån ska inte kosta ett
  // ruttanrop. Point-in-polygon, noll anrop, fungerar utan täckning.
  const reachable = thrown.filter((t) => timeHomeS(leash, t) <= budget);
  log(`planExplore: ${thrown.length} mål kastade, ${reachable.length} innanför kopplet`);

  if (reachable.length === 0) {
    throw new RouteEngineError(
      'no_route', 'inget mål ryms i den kvarvarande budgeten — dags att vända hemåt',
    );
  }

  // ── 2. SNAPPA ─────────────────────────────────────────────── [1 locate-anrop]
  //
  // Punkter som inte snappar (sjö, hygge, återvändsgränd) kastas TYST. Ett kastat mål är
  // inte ett fel — vi kastade ju tre.

  const snapped = await engine.locate(reachable, ANCHOR_SNAP);
  calls++;

  const accepted = new Set<string>(ANCHOR_CLASSES);
  const targets = snapped.filter(
    (s: SnappedPoint | undefined): s is SnappedPoint =>
      s !== undefined && s.ok && accepted.has(s.roadClass),
  );

  // ── 3. RUTTA ──────────────────────────────────── [≤3 route-anrop, PARALLELLT]
  //
  // `headingDeg` på startpunkten är det som gör att benet inte börjar med en U-sväng: vi
  // åker vidare i den riktning bilen redan pekar.

  const work = targets.map((t) => engine.route({
    waypoints: [
      {
        at: input.from,
        kind: 'break',
        headingDeg: Math.round(((input.headingDeg % 360) + 360) % 360),
        headingToleranceDeg: 45,
      },
      { at: t.at, kind: 'break' },
    ],
    prefs,
    locale: 'sv-SE',
    ...(signal ? { signal } : {}),
  }));

  const { ok, failed } = await settle(work);
  calls += targets.length;

  for (const err of failed) log(`planExplore: ett mål gick inte att rutta (${String(err)})`);

  // ── 4. VÄLJ ─────────────────────────────────────────────────────── [0 anrop]

  const legs: PlanCandidate[] = [];

  for (const trip of ok) {
    const route: Route | undefined = trip[0];
    if (!route) continue;

    // Kopplet igen, nu mot ruttens FAKTISKA sluttid: benet kostar tid, och den tiden ska
    // dras från budgeten innan vi frågar om vi kommer hem.
    const cells = routeCells(route);
    const home = timeHomeS(leash, endOf(cells));
    if (home > (input.seconds - route.timeS) * LEASH_MARGIN) continue;

    legs.push(legCandidate(ctx, cells));
  }

  legs.sort((a, b) => b.score - a.score);
  log(`planExplore: ${legs.length} ben klarade kopplet`);

  return {
    routes: legs,
    stats: {
      engineCalls: calls,
      anchorsFound: thrown.length,
      anchorsSnapped: targets.length,
      anchorsRouted: ok.length,
      survivedNatural: legs.length,
      ms: Date.now() - started,
    },
  };
}

// ─── 1. Målen ───────────────────────────────────────────────────────────────

/**
 * Tre mål, 6–8 km ut i riktning φ ± 30°, viktade mot okänd mark.
 *
 * Designen skriver "viktade mot H3 res-8-celler med LÅG besöksgrad". Vi frågar samma sak
 * med den FRUSNA nyhetsmatten i stället: fågelvägens nyhet från här till målet
 * (`cellsNovelty` över res-11-sampel). En egen "besöksgrad" på res 8 hade varit en ANDRA
 * uppfattning om vad "körd väg" betyder — utan recency-decay och utan mjukt grannskap — och
 * två uppfattningar blir två siffror (CONTRACT, ingressen).
 *
 * Fågelvägen är förstås inte den väg bilen kommer att köra. Den behöver inte vara det: det
 * här är en PRIOR som avgör vilka tre mål som ens är värda ett ruttanrop. Rutten
 * poängsätts sedan på sin riktiga geometri.
 */
function throwTargets(ctx: PlanContext, input: PlanExploreInput): LngLat[] {
  const { mem, today } = ctx;
  const out: LngLat[] = [];

  for (let i = 0; i < TARGETS; i++) {
    // -30°, 0°, +30° runt nålen. Ingen slump: tre deterministiska riktningar är lika
    // spridda som tre jittrade, och de går att felsöka.
    const spread = TARGETS > 1 ? (2 * i) / (TARGETS - 1) - 1 : 0;   // -1 … +1
    const heading = input.headingDeg + spread * FAN_DEG;

    let best: LngLat | undefined;
    let bestNovelty = -1;

    // Tre avstånd i spannet. Det som går genom mest okänd mark vinner.
    for (let k = 0; k < 3; k++) {
      const metres = LEG_MIN_M + ((LEG_MAX_M - LEG_MIN_M) * k) / 2;
      const at = project(input.from, heading, metres);

      const beeline = resample([input.from, at], 25);
      const novelty = cellsNovelty(sampleCells(beeline), mem, today);

      if (novelty > bestNovelty) {
        bestNovelty = novelty;
        best = at;
      }
    }

    if (best) out.push(best);
  }

  return out;
}

/** Punkten `metres` meter bort i bäringen `headingDeg`. Lokalt plan; felet är centimeter. */
function project(from: LngLat, headingDeg: number, metres: number): LngLat {
  const rad = headingDeg * DEG;
  const north = metres * Math.cos(rad);
  const east = metres * Math.sin(rad);

  const mPerLat = EARTH_R_M * DEG;
  const mPerLon = mPerLat * Math.cos(from[1] * DEG);

  return [from[0] + east / mPerLon, from[1] + north / mPerLat];
}

// ─── 4. Bensvalet ───────────────────────────────────────────────────────────

/**
 * Benets egen målfunktion (design-v1 §3, läge (c), steg 4):
 *
 *     s = novelKm/km − 0,30 · turnCost − 0,40 · motorvägsandel + 0,15 · skönhet
 *
 * Det är INTE U(P), och det ska det inte vara. U(P) väger en hel rutt mot en baslinje och
 * en tidsbudget. Ett ben har varken: det är sex kilometer framåt, och frågan är bara "är
 * det här den roligaste av tre vägar härifrån".
 *
 * `turnCost` normeras mot det absoluta taket (4,0 svängar/km, CONTRACT §5.3), av samma skäl
 * som i slingan: det finns ingen baslinje att vara relativ till.
 */
function legCandidate(ctx: PlanContext, c: RouteCells): PlanCandidate {
  const { mem, today } = ctx;

  const novelty = cellsNovelty(c.cells, mem, today);
  const beauty = beautyOf(c);
  const turnCost = clamp01(turnsPerKm(c.route) / TURNS_PER_KM_MAX);
  const motorway = fractionOf(c.route.roadClassSpans, ['motorway', 'trunk'], c.shape);

  return {
    route: c.route,
    novelKm: novelty * (c.route.distanceM / 1000),
    beauty,
    motorwayKm: motorwayKm(c),
    gravelKm: gravelKm(c),
    score: novelty - 0.30 * turnCost - 0.40 * motorway + 0.15 * beauty,
    kind: 'candidate',
    // Ett ben tvingas inte genom någonting: det ÄR vägen till målet, och målet valdes för
    // att vägen dit var okänd. Det finns alltså ingen genompunkt att bevara vid en
    // avvikelse — svänger föraren av planeras nästa ben från där hen faktiskt är.
    through: [],
  };
}

function endOf(c: RouteCells): LngLat {
  return c.shape[c.shape.length - 1] ?? c.shape[0] ?? [0, 0];
}
