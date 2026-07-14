/**
 * Läge (a) — A→B, men vackrare. Design-v1 §3. Tolv anrop.
 *
 * Grundinsikten: ingen ruttmotor i världen kan uttrycka "föredra väg jag inte kört förut".
 * Alltså får motorn aldrig veta något om nyhet. Den är en dum kandidatgenerator. Nyheten
 * är 100 % vår, den kostar noll API-anrop, och den körs på under en millisekund per
 * kandidat.
 *
 * Men vi samplar inte blint och hoppas att rutten råkar bli ny. Vi hittar de okända
 * vägbitarna FÖRST — i vårt eget vägindex — och tvingar rutten genom dem med
 * `through`-punkter. Det är skillnaden mellan "slumpmässig omväg" och "överraskande vacker
 * rutt", och det är den enda mekanism i något ruttnings-API som GARANTERAR okänd väg i
 * rutten i stället för att hoppas på den.
 *
 *   1  baslinje            1 route  (alternates: 2 → två gratis kandidater)
 *   2  ellips-pruning      0 anrop  (ADGW; halverar sökrymden gratis)
 *   3  okända vägarna      0 anrop  (1 DB-fråga)
 *   4  snappa              1 locate (alla ankarändar i ETT anrop)
 *   5  matris-förfilter    2 matrix (i stället för 14 ruttanrop — den stora besparingen)
 *   6  tvinga genom        8 route  (parallellt)
 *   7  dedup, filtrera, poängsätt   0 anrop
 */

import { RouteEngineError, routeCells } from '@mindful/core';
import type { LngLat, Route, RouteCells, Waypoint } from '@mindful/core';

import { rankAnchors, snapAnchors, spread } from './anchors.js';
import type { Anchor } from './anchors.js';
import { candidateOf, dedupe, selectBest, sweepContext } from './candidates.js';
import type { Scoring } from './candidates.js';
import {
  ANCHOR_CLASSES, ANCHOR_COUNT, ANCHOR_SNAP, MATRIX_MARGIN, fanOutOf, settle,
} from './context.js';
import type { Genomrutt, PlanContext, PlanResult } from './context.js';

export interface PlanABInput {
  readonly from: LngLat;
  readonly to: LngLat;
  /** Tidsbudget-slidern. 0,15 / 0,35 / 0,60 / 1,00. Visas i MINUTER, aldrig i procent. */
  readonly epsilon: number;
}

export async function planAB(ctx: PlanContext, input: PlanABInput): Promise<PlanResult> {
  const started = Date.now();
  const { engine, roads, mem, today, prefs, signal } = ctx;
  const { from, to, epsilon } = input;
  const log = ctx.log ?? (() => {});

  let calls = 0;

  // ── 1. BASLINJE ───────────────────────────────────────────── [1 route-anrop]
  //
  // Motorns egna alternativ är gratis: de kommer i samma svar. De är nyhetsblinda och
  // ofta nästan identiska med baslinjen — men de kostar ingenting, och de som överlever
  // dedupen och `isNatural` är riktiga kandidater.

  const alternates = Math.min(2, engine.caps.maxAlternates);
  const paths = await engine.route({
    waypoints: [{ at: from, kind: 'break' }, { at: to, kind: 'break' }],
    prefs,
    locale: 'sv-SE',
    alternates,
    ...(signal ? { signal } : {}),
  });
  calls++;

  const baseline = paths[0];
  if (!baseline) throw new RouteEngineError('no_route', 'motorn gav ingen baslinje');

  const T0 = baseline.timeS;
  const D0 = baseline.distanceM;
  const Tmax = T0 * (1 + epsilon);

  const sweep = sweepContext(baseline, Tmax);
  const scoring: Scoring = {
    baseline,
    baselineCells: sweep.natural.baselineCells,
    T0,
    Tmax,
    mem,
    today,
  };

  // ── 2 + 3. ELLIPSEN OCH DE OKÄNDA VÄGARNA ───────────────── [0 anrop, 1 DB-fråga]
  //
  // Ellipstestet görs i SQL:en, på segmentets mittpunkt — exakt den punkt som sedan blir
  // matrisens frågepunkt. Testet svarar alltså på precis den fråga planeraren ställer,
  // inte på en approximation av den.

  const segments = await roads.segmentsInEllipse(from, to, epsilon, ANCHOR_CLASSES, D0);
  const ranked = rankAnchors(segments, from, to, D0, mem, today);
  const chosen = spread(ranked, ANCHOR_COUNT);

  log(`planAB: ${segments.length} segment i ellipsen → ${ranked.length} ankare`
    + ` → ${chosen.length} efter spridning`);

  // Inga okända vägar i ellipsen är ett giltigt svar, inte ett fel. Det händer när
  // användaren kört allt i trakten — och då är recency-decayen (τ = 500 d) svaret, inte
  // ett undantag. Baslinjen och motorns alternativ står kvar.
  const anchored: Anchored = chosen.length > 0
    ? await routeThroughAnchors(ctx, input, chosen, Tmax, (n) => { calls += n; })
    : { routes: [], snapped: 0 };

  // ── 7. SLÅ IHOP, DEDUPLICERA, FILTRERA, POÄNGSÄTT ───────────────── [0 anrop]

  // Varje genomruttad kandidat bär med sig DE punkter den tvingades genom. Kopplingen görs
  // på ruttens identitet, inte på ordningen: `dedupe` kastar kandidater, och ett index in i
  // den ursprungliga listan hade pekat på fel rutt efteråt. Punkterna följer med ut till
  // klienten och överlever därmed en avvikelse (se `PlanCandidate.through`).
  const throughFor = new Map<RouteCells, readonly Waypoint[]>();
  for (const g of anchored.routes) throughFor.set(g.cells, g.through);

  const alternatives = paths.slice(1).map(routeCells);
  const pool = dedupe([...anchored.routes.map((g) => g.cells), ...alternatives], [sweep.cells]);

  const { best, survived } = selectBest(pool, sweep.natural, scoring, {
    throughOf: (c) => throughFor.get(c) ?? [],
    log: (line) => log(`planAB: ${line}`),
  });

  // Baslinjen sist och alltid: "raka vägen", så att man kan jämföra. Den är inte ett
  // förslag och den poängsätts inte som ett.
  const routes = [...best, candidateOf(sweep.cells, scoring, 'baseline')];

  return {
    routes,
    stats: {
      engineCalls: calls,
      anchorsFound: ranked.length,
      anchorsSnapped: anchored.snapped,
      anchorsRouted: anchored.routes.length,
      survivedNatural: survived,
      ms: Date.now() - started,
    },
  };
}

// ─── Steg 4–6 ───────────────────────────────────────────────────────────────

interface Anchored {
  readonly routes: Genomrutt[];
  readonly snapped: number;
}

async function routeThroughAnchors(
  ctx: PlanContext,
  input: PlanABInput,
  chosen: readonly Anchor[],
  Tmax: number,
  spent: (calls: number) => void,
): Promise<Anchored> {
  const { engine, prefs, signal } = ctx;
  const { from, to } = input;
  const log = ctx.log ?? (() => {});

  // ── 4. SNAPPA ─────────────────────────────────────────────── [1 locate-anrop]

  const snapped = await snapAnchors(engine, chosen);
  spent(1);
  log(`planAB: ${snapped.length} av ${chosen.length} ankare snappade till en liten väg`);

  // ── 5. MATRIS-FÖRFILTER ──────────────────────────────────── [2 matrix-anrop]

  const fanOut = fanOutOf(engine.caps);
  const viable = engine.caps.matrix
    ? await matrixFilter(ctx, from, to, snapped, Tmax, spent)
    : snapped;      // ingen matris → hoppa steget, betala med sämre urval i steg 6

  const finalists = viable.slice(0, fanOut);
  log(`planAB: ${finalists.length} ankare kvar efter matrisen (fan-out ${fanOut})`);

  // ── 6. TVINGA GENOM ───────────────────────── [≤ fanOut route-anrop, PARALLELLT]
  //
  // `through` ⇒ ingen u-sväng, inget eget ben ⇒ bilen MÅSTE köra igenom hela det okända
  // segmentet.
  //
  // BONUS: en single-via-path är per konstruktion konkateneringen av TVÅ kortaste vägar,
  // alltså lokalt optimal, alltså NATURLIG. Det är därför vi slipper zigzaggen som den
  // naiva straffmetoden ger.

  // Rutten och dess genompunkter föds i SAMMA promise. Hade vi ruttat först och parat ihop
  // dem efteråt på index hade `settle` — som tyst släpper de anrop som misslyckades —
  // förskjutit listan, och en kandidat hade fått ett annat ankares punkter med sig.
  const work = finalists.map(async (anchor): Promise<Genomrutt> => {
    const through: readonly Waypoint[] = [
      { at: anchor.start, kind: 'through', snap: ANCHOR_SNAP },
      { at: anchor.end, kind: 'through', snap: ANCHOR_SNAP },
    ];

    const trips = await engine.route({
      waypoints: [
        { at: from, kind: 'break' },
        ...through,
        { at: to, kind: 'break' },
      ],
      prefs,
      locale: 'sv-SE',
      ...(signal ? { signal } : {}),
    });

    const route: Route | undefined = trips[0];
    if (!route) throw new RouteEngineError('no_route', 'ankaret gav ingen rutt');

    return { cells: routeCells(route), through };
  });

  const { ok, failed } = await settle(work);
  spent(finalists.length);

  for (const err of failed) {
    log(`planAB: ett ankare gick inte att rutta genom (${String(err)})`);
  }

  return { routes: [...ok], snapped: snapped.length };
}

/**
 * ⚡ Två matrisanrop i stället för fjorton ruttanrop. Den stora besparingen.
 *
 *     t(A, mid) + t(mid, B)  ≤  en ÄKTA undre gräns för rutten genom segmentet
 *
 * Varje rutt genom segmentet passerar dess mittpunkt. Alltså kan ingen sådan rutt vara
 * snabbare än den optimala vägen A→mid→B. Ligger den undre gränsen redan över budgeten kan
 * ankaret BEVISLIGEN inte klara den — och vi vet det utan att ha ruttat det.
 *
 * Marginalen (0,92) finns för att through-tvånget gör den verkliga rutten något
 * långsammare än gränsen: den får inte vända vid mittpunkten, den måste följa segmentet.
 *
 * Onåbara par kommer tillbaka som `Infinity` ur adaptern — inte som noll, och inte som ett
 * kastat fel. Ett ankare på en ö faller alltså på samma jämförelse som ett för långsamt.
 */
async function matrixFilter(
  ctx: PlanContext,
  from: LngLat,
  to: LngLat,
  anchors: readonly Anchor[],
  Tmax: number,
  spent: (calls: number) => void,
): Promise<Anchor[]> {
  if (anchors.length === 0) return [];

  const { engine, prefs } = ctx;
  const log = ctx.log ?? (() => {});

  const limit = engine.caps.matrix?.maxLocations ?? Infinity;
  if (anchors.length + 1 > limit) {
    log(`planAB: matrisen tar bara ${limit} punkter — hoppar förfiltret`);
    return [...anchors];
  }

  const mids = anchors.map((a) => a.mid);

  const [outbound, inbound] = await Promise.all([
    engine.matrix([from], mids, prefs),
    engine.matrix(mids, [to], prefs),
  ]);
  spent(2);

  const budget = Tmax * MATRIX_MARGIN;
  const out: Anchor[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const there = outbound.timeS[0]?.[i];
    const back = inbound.timeS[i]?.[0];
    if (!anchor || there === undefined || back === undefined) continue;

    if (there + back <= budget) out.push(anchor);
  }

  return out;
}
