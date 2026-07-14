/**
 * Läge (b) — slinga hemifrån. "90 minuter okänd väg, ta mig hem." Sex anrop.
 *
 * Motorernas inbyggda `round_trip` är NYHETSBLIND — enda ratten är en slumpseed. Valhalla
 * har den inte alls. Vi bygger den själva, och den blir bättre, för vi vet var nyheten bor.
 *
 *   1  isokron            1 anrop  (ringen, cachad 30 d per (hem, T))
 *   2  sektoranalys       0 anrop  (1 DB-fråga)   ← det steget ingen motor kan göra åt oss
 *   3  ankarpar           0 anrop
 *   4  snappa             1 locate
 *   5  rutta              4 route  (H → A1[through] → A2[through] → H)
 *   6  filtrera, poängsätt
 *
 * ⛔ ALDRIG `exclude_locations` på utvägen. Det är en HÅRD uteslutning (max 50 punkter) som
 *    kan ge "no route found" och kräver en "släpp hälften och kör om"-loop. Hård
 *    uteslutning i en produkt som handlar om PREFERENS är fel semantik.
 *
 * ✅ Ankarpar kan aldrig ge NoRoute, ger genuint olika ut- och hemväg, och kostar ett anrop
 *    per kandidat. Valhalla ger noll alternates på multipoint-rutter — diversiteten kommer
 *    från VÅRA ankarpar, inte från motorn. Det är hela poängen.
 */

import {
  H3_SPREAD_RES, NOVELTY_ANCHOR_MIN, RouteEngineError, TURNS_PER_KM_MAX,
  bearing, cell, encode6, haversine, routeCells, segmentNovelty, selfOverlap, turnsPerKm,
} from '@mindful/core';
import type {
  LngLat, RoadSegment, Route, RouteCells, SnappedPoint, VisitedIndex, Waypoint,
} from '@mindful/core';

import { midpointOf } from '../roadindex/segmenter.js';
import { anchorBeauty } from './anchors.js';
import { candidateOf, dedupe } from './candidates.js';
import type { Scoring } from './candidates.js';
import { ANCHOR_CLASSES, ANCHOR_SNAP, TOP_N, settle } from './context.js';
import type { Genomrutt, PlanContext, PlanResult } from './context.js';

export interface PlanLoopInput {
  /** Hemmet. Slingan börjar och slutar här. */
  readonly from: LngLat;
  /** Tidsbudgeten i sekunder. */
  readonly seconds: number;
}

/**
 * Ringens radie, som andel av budgeten.
 *
 * ⚠️ Designen säger 0,38 ("marginal för en ANNAN väg hem"). Den siffran går inte ihop med
 *    ankarpar, och det är räknat, inte tyckt. Ligger båda ankarna på tidsradien `r` och
 *    θ grader isär sett från hemmet, kostar slingan H→A1→A2→H ungefär
 *
 *        2r + kordan(A1,A2)  ≈  2r · (1 + sin(θ/2))
 *
 *    Vid θ = 120° blir det 3,73 · r. Med r = 0,38 · T är slingan alltså 1,42 · T — över
 *    budgeten innan den ens börjat. Mätt: alla fyra ankarparen föll på tidsgränsen, i båda
 *    svepen, och slingläget gav noll slingor.
 *
 *    Löser man ut r för θ ∈ [90°, 150°] hamnar man på 0,25–0,29. Vi tar 0,27: då landar en
 *    120°-slinga på ~1,0 · T, vilket är precis vad användaren bad om.
 *
 *    Designens 0,38 hade varit rätt för en tur och retur (2r ≈ 0,76 · T plus en annan väg
 *    hem). Ankarparet är inte en tur och retur — det är hela poängen med det.
 */
const RING_FRACTION = 0.27;

/** Om färre än så här överlever: dra in ringen och försök en gång till. */
const RETRY_RING_FRACTION = 0.22;
const MIN_CANDIDATES = 2;

/** Tolv sektorer à 30°. */
const SECTORS = 12;
const SECTOR_DEG = 360 / SECTORS;

/** Ankarparets bäringar ska ligga så här långt isär — annars blir slingan en tur och retur. */
const PAIR_MIN_DEG = 90;
const PAIR_MAX_DEG = 150;

/** Så många ankarpar ruttar vi. Ett route-anrop per par. */
const PAIRS = 4;

/**
 * Slingans hårda tidsgräns. Slingan HAR ingen ε — användaren gav en budget i minuter, och
 * U_loop straffar avvikelsen åt båda hållen. Men en slinga som överskrider budgeten med mer
 * än en fjärdedel har brutit sitt löfte, och då är den ingen kandidat.
 */
const LOOP_SLACK = 0.25;

export async function planLoop(ctx: PlanContext, input: PlanLoopInput): Promise<PlanResult> {
  const started = Date.now();
  const { engine, mem, today, prefs } = ctx;
  const log = ctx.log ?? (() => {});

  if (!engine.caps.isochrone) {
    throw new RouteEngineError('bad_request', 'motorn har inga isokroner — slingläget kräver dem');
  }

  const T = input.seconds;
  let calls = 0;

  // ── 1. ISOKRONEN ────────────────────────────────────────── [1 anrop, cachat 30 d]
  //
  // Båda ringarna hämtas i SAMMA anrop. Adaptern delar upp det på motorns konturtak om
  // det behövs; för oss är det ett anrop. Det gör återförsöket (steg 6) gratis i
  // isokronvaluta — annars hade "kör om med en snävare ring" kostat ett nytt anrop för
  // att fråga om något vi redan kunde ha bett om.

  const wanted = [RETRY_RING_FRACTION * T, RING_FRACTION * T];
  const [tight, wide] = await engine.isochrone(input.from, wanted, prefs);
  calls++;

  if (!wide || !tight) throw new RouteEngineError('no_route', 'motorn gav ingen isokron');

  // Ett svep per ring. Den vida först — den använder budgeten.
  for (const ring of [wide, tight]) {
    const pass = await loopPass(ctx, input, ring, T, (n) => { calls += n; });

    if (pass.routes.length >= MIN_CANDIDATES || ring === tight) {
      const scoring: Scoring = {
        baseline: normReference(T),
        baselineCells: EMPTY_CELLS,
        T0: T,
        Tmax: T * (1 + LOOP_SLACK),
        mem,
        today,
      };

      // Genompunkterna kopplas till rutten på identitet, inte på ordning: `dedupe` kastar
      // slingor, och ett index hade pekat på fel ankarpar efteråt.
      const throughFor = new Map<RouteCells, readonly Waypoint[]>();
      for (const g of pass.routes) throughFor.set(g.cells, g.through);

      const natural: RouteCells[] = [];
      for (const c of dedupe(pass.routes.map((g) => g.cells))) {
        const why = isNaturalLoop(c, scoring.Tmax);
        if (why.length === 0) natural.push(c);
        else {
          log(`planLoop: kastad slinga ${(c.route.distanceM / 1000).toFixed(1)} km,`
            + ` ${(c.route.timeS / 60).toFixed(0)} min — ${why.join(', ')}`);
        }
      }

      // U_loop(P) = U(P) − 0,50 · |T(P) − T| / T. Slingan ska LANDA på budgeten, inte
      // maximera den: en slinga på 40 minuter av 90 är inte "bättre för att den är
      // kortare", den är ett brutet löfte åt andra hållet.
      const best = natural
        .map((c) => candidateOf(
          c, scoring, 'candidate', -0.50 * Math.abs(c.route.timeS - T) / T,
          throughFor.get(c) ?? [],
        ))
        .sort((x, y) => y.score - x.score)
        .slice(0, TOP_N);

      const survived = natural.length;
      log(`planLoop: ${pass.routes.length} slingor ruttade, ${survived} naturliga`);

      return {
        routes: best,
        stats: {
          engineCalls: calls,
          anchorsFound: pass.found,
          anchorsSnapped: pass.snapped,
          anchorsRouted: pass.routes.length,
          survivedNatural: survived,
          ms: Date.now() - started,
        },
      };
    }

    log('planLoop: för få slingor överlevde — drar in ringen och försöker igen');
  }

  throw new RouteEngineError('no_route', 'ingen slinga gick att bygga från den här punkten');
}

// ─── Ett svep ───────────────────────────────────────────────────────────────

interface LoopPass {
  readonly routes: Genomrutt[];
  readonly found: number;
  readonly snapped: number;
}

async function loopPass(
  ctx: PlanContext,
  input: PlanLoopInput,
  ring: GeoJSON.Polygon,
  T: number,
  spent: (calls: number) => void,
): Promise<LoopPass> {
  const { engine, roads, mem, today, prefs, signal } = ctx;
  const home = input.from;
  const log = ctx.log ?? (() => {});

  // ── 2. SEKTORANALYS ─────────────────────────────────────── [0 anrop, 1 DB-fråga]
  //
  // DETTA är steget ingen ruttmotor kan göra åt oss. Det är vår data som blir en
  // superkraft i stället för en fotnot.

  const segments = await roads.segmentsInRing(home, ring, ANCHOR_CLASSES);
  const anchors = ringAnchors(segments, home, mem, today);
  if (anchors.length === 0) return { routes: [], found: 0, snapped: 0 };

  const sectors = sectorNovelty(anchors);
  const best = bestPerSector(anchors);
  log(`planLoop: ${segments.length} segment i ringen → ${anchors.length} ankare`
    + ` i ${best.length} sektorer`);

  // ── 3. ANKARPAR ────────────────────────────────── [1 matrix-anrop, se nedan]

  const pairs = await anchorPairs(ctx, home, best, sectors, T, spent);
  log(`planLoop: ${pairs.length} ankarpar med en genväg mellan sig`);

  if (pairs.length === 0) return { routes: [], found: anchors.length, snapped: 0 };

  // ── 4. SNAPPA ─────────────────────────────────────────────── [1 locate-anrop]

  const points: LngLat[] = [];
  for (const p of pairs) points.push(p.first.at, p.second.at);

  const snapped = await engine.locate(points, ANCHOR_SNAP);
  spent(1);

  const accepted = new Set<string>(ANCHOR_CLASSES);
  const ok = (s: SnappedPoint | undefined): s is SnappedPoint =>
    s !== undefined && s.ok && accepted.has(s.roadClass);

  const routable = pairs
    .map((pair, i) => ({ pair, a1: snapped[2 * i], a2: snapped[2 * i + 1] }))
    .filter((p) => ok(p.a1) && ok(p.a2));

  // ── 5. RUTTA ────────────────────────────────────── [≤4 route-anrop, PARALLELLT]

  // Slingan och dess två genompunkter föds i samma promise, av samma skäl som i läge (a):
  // `settle` släpper tyst det som bommade, och ett index in i `routable` hade efteråt
  // pekat på fel ankarpar.
  const work = routable.map(async (p): Promise<Genomrutt> => {
    const through: readonly Waypoint[] = [
      { at: p.a1?.at ?? p.pair.first.at, kind: 'through', snap: ANCHOR_SNAP },
      { at: p.a2?.at ?? p.pair.second.at, kind: 'through', snap: ANCHOR_SNAP },
    ];

    const trip = await engine.route({
      waypoints: [
        { at: home, kind: 'break' },
        ...through,
        { at: home, kind: 'break' },
      ],
      prefs,
      locale: 'sv-SE',
      ...(signal ? { signal } : {}),
    });

    const route: Route | undefined = trip[0];
    if (!route) throw new RouteEngineError('no_route', 'ankarparet gav ingen slinga');

    // En slinga som inte ens ryms i budgeten med sitt slack är inte en kandidat — den
    // faller ändå på `isNatural`, men den behöver inte bära med sig hela vägen dit.
    if (route.timeS > T * (1 + LOOP_SLACK)) {
      throw new RouteEngineError(
        'no_route',
        `slingan blev ${(route.timeS / 60).toFixed(0)} min — över budgeten`,
      );
    }

    return { cells: routeCells(route), through };
  });

  const { ok: routes, failed } = await settle(work);
  spent(routable.length);

  for (const err of failed) log(`planLoop: ett ankarpar gick inte att rutta (${String(err)})`);

  return { routes: [...routes], found: anchors.length, snapped: routable.length };
}

// ─── Ankarna i ringen ───────────────────────────────────────────────────────

interface RingAnchor {
  readonly at: LngLat;
  readonly bearingDeg: number;
  readonly sector: number;
  readonly novelty: number;
  readonly rank: number;
  readonly distanceM: number;
}

/**
 * Ett ankare per H3 res-7-cell, som i läge (a) — annars ligger alla fyra paren i samma
 * skogsdunge och de fyra "olika" slingorna svänger av på samma ställe.
 *
 * Avståndet hemifrån ingår i rankningen, och det är inte kosmetik: en slinga som vänder
 * efter tre kilometer ANVÄNDER inte budgeten. `U_loop` straffar den i efterhand, men det
 * hjälper inte om alla fyra kandidaterna redan är för korta. Vi väljer alltså ankare långt
 * ut i ringen, där slingan blir så lång som användaren bad om.
 */
function ringAnchors(
  segments: readonly RoadSegment[],
  home: LngLat,
  mem: VisitedIndex,
  today: number,
): RingAnchor[] {
  const scored: (RingAnchor & { cellId: bigint })[] = [];
  let reach = 1;

  for (const s of segments) {
    const novelty = segmentNovelty(s, mem, today);
    if (novelty < NOVELTY_ANCHOR_MIN) continue;

    const beauty = anchorBeauty(s);
    if (beauty <= 0) continue;

    const at = midpointOf(s.shape);
    const distanceM = haversine(home, at);
    if (distanceM <= 0) continue;
    if (distanceM > reach) reach = distanceM;

    const bearingDeg = bearing(home, at);

    scored.push({
      at,
      bearingDeg,
      sector: Math.floor(bearingDeg / SECTOR_DEG) % SECTORS,
      novelty,
      // `distanceM` normeras mot ringens yttersta ankare först nedan — reach är inte känd
      // förrän hela listan är genomgången.
      rank: novelty ** 1.5 * beauty * s.lengthM * distanceM,
      distanceM,
      cellId: cell(at, H3_SPREAD_RES),
    });
  }

  scored.sort((a, b) => b.rank - a.rank);

  const taken = new Set<bigint>();
  const out: RingAnchor[] = [];

  for (const a of scored) {
    if (taken.has(a.cellId)) continue;
    taken.add(a.cellId);
    out.push({ ...a, rank: a.rank / reach });
  }

  return out;
}

/**
 * sektorNovelty[s] = Σ (segmentNovelty × längd) för småvägssegment i sektorn.
 *
 * Vi använder ankarnas rank som proxy för produkten nyhet × längd × skönhet — det är den
 * summan som säger "här ute finns mycket okänd, vacker väg", och det är den frågan
 * sektorindelningen ställer.
 */
function sectorNovelty(anchors: readonly RingAnchor[]): number[] {
  const sum = new Array<number>(SECTORS).fill(0);
  for (const a of anchors) sum[a.sector] = (sum[a.sector] ?? 0) + a.rank;
  return sum;
}

interface Pair {
  readonly first: RingAnchor;
  readonly second: RingAnchor;
  readonly weight: number;
}

/** Sektorns bästa ankare. Ett per sektor — kandidaterna för parbildningen. */
function bestPerSector(anchors: readonly RingAnchor[]): RingAnchor[] {
  const best = new Map<number, RingAnchor>();
  for (const a of anchors) {
    const cur = best.get(a.sector);
    if (!cur || a.rank > cur.rank) best.set(a.sector, a);
  }
  return [...best.values()];
}

/**
 * Finns det en TVÄRFÖRBINDELSE mellan ankarna, eller går vägen tillbaka genom hemmet?
 *
 * Under detta tal är A1→A2 en genväg. Över det går den lika gärna via hemmet, och slingan
 * blir en åtta som kör samma radiella väg två gånger.
 */
const SHORTCUT_MAX = 0.85;

/**
 * Fyra ankarpar, 90°–150° isär sett från hemmet — OCH med en väg mellan sig.
 *
 * Under 90° blir slingan en tur och retur samma väg. Över 150° går andra benet rakt genom
 * hemmet igen. Mellan dem ligger en riktig slinga.
 *
 * ⚠️ Vinkelvillkoret ensamt RÄCKER INTE, och det är mätt: alla tre slingor som gick att
 *    rutta från Växjö föll på självöverlapp (22 %) och riktningsomkastningar. Orsaken är
 *    inte planeraren, det är vägnätet. En svensk stad är en NAV: vägarna strålar ut, och
 *    tvärförbindelser mellan dem finns bara ibland. Saknas den kör man från A1 tillbaka
 *    mot Växjö och ut igen mot A2 — och då har man kört samma radiella väg två gånger.
 *    Designens ankarpar FÖRUTSÄTTER en tangentiell väg. Vi kan inte skapa en, men vi kan
 *    fråga om den finns:
 *
 *        t(A1→A2)  <  0,85 · ( t(A1→H) + t(H→A2) )
 *
 *    Är kombinationen genom hemmet lika snabb som den direkta vägen, så FINNS ingen direkt
 *    väg — triangelolikheten blir en likhet när enda vägen går genom navet.
 *
 * Det kostar ETT matrisanrop (design-v1 budgeterade sex; vi landar på sju). Ett anrop som
 * gör att de fyra ruttanropen träffar är billigare än fyra ruttanrop som bommar.
 *
 * Samma matris ger dessutom slingans restid gratis, så vi kan välja de par som faktiskt
 * LANDAR på budgeten i stället för att hoppas på det.
 *
 * Varje sektor används i högst ett par — annars blir de fyra slingorna varianter av
 * varandra, och då har vi fyra förslag men ett val.
 */
async function anchorPairs(
  ctx: PlanContext,
  home: LngLat,
  anchors: readonly RingAnchor[],
  sectors: readonly number[],
  T: number,
  spent: (calls: number) => void,
): Promise<Pair[]> {
  if (anchors.length < 2) return [];

  const { engine, prefs } = ctx;

  // Hemmet först, sedan ankarna: en enda matris ger t(H→Ai), t(Ai→Aj) och t(Aj→H).
  const points: LngLat[] = [home, ...anchors.map((a) => a.at)];
  const limit = engine.caps.matrix?.maxLocations;
  if (limit === undefined || 2 * points.length > limit) return anglePairsOnly(anchors, sectors);

  const { timeS } = await engine.matrix(points, points, prefs);
  spent(1);

  const t = (from: number, to: number): number => timeS[from]?.[to] ?? Infinity;
  const Tmax = T * (1 + LOOP_SLACK);

  const candidates: Pair[] = [];

  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const first = anchors[i];
      const second = anchors[j];
      if (!first || !second) continue;

      const apart = angleBetween(first.bearingDeg, second.bearingDeg);
      if (apart < PAIR_MIN_DEG || apart > PAIR_MAX_DEG) continue;

      // +1: hemmet är punkt 0 i matrisen.
      const ut = t(0, i + 1);
      const tvärs = t(i + 1, j + 1);
      const hem = t(j + 1, 0);

      const genomHemmet = t(i + 1, 0) + t(0, j + 1);
      if (!(tvärs < SHORTCUT_MAX * genomHemmet)) continue;   // ingen tvärförbindelse

      const total = ut + tvärs + hem;
      if (!Number.isFinite(total) || total > Tmax) continue;

      candidates.push({
        first,
        second,
        // Sektorernas nyhet, men bara bland de slingor som faktiskt landar på budgeten:
        // en slinga på halva tiden är ett brutet löfte åt andra hållet.
        weight: ((sectors[first.sector] ?? 0) + (sectors[second.sector] ?? 0))
          * (1 - Math.abs(total - T) / T),
      });
    }
  }

  return pickSpread(candidates);
}

/** Ingen matris i motorn → falla tillbaka på enbart vinkelvillkoret (och sämre slingor). */
function anglePairsOnly(anchors: readonly RingAnchor[], sectors: readonly number[]): Pair[] {
  const candidates: Pair[] = [];

  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      const first = anchors[i];
      const second = anchors[j];
      if (!first || !second) continue;

      const apart = angleBetween(first.bearingDeg, second.bearingDeg);
      if (apart < PAIR_MIN_DEG || apart > PAIR_MAX_DEG) continue;

      candidates.push({
        first,
        second,
        weight: (sectors[first.sector] ?? 0) + (sectors[second.sector] ?? 0),
      });
    }
  }

  return pickSpread(candidates);
}

/** De bästa paren, med varje sektor använd högst en gång. */
function pickSpread(candidates: Pair[]): Pair[] {
  candidates.sort((a, b) => b.weight - a.weight);

  const used = new Set<number>();
  const out: Pair[] = [];

  for (const pair of candidates) {
    if (out.length >= PAIRS) break;
    if (used.has(pair.first.sector) || used.has(pair.second.sector)) continue;

    used.add(pair.first.sector);
    used.add(pair.second.sector);
    out.push(pair);
  }

  return out;
}

/** Minsta vinkeln mellan två bäringar. 0..180. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(((b - a) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

// ─── Normeringen när det inte finns någon baslinje ──────────────────────────

const EMPTY_CELLS: ReadonlySet<bigint> = new Set<bigint>();

/**
 * En slinga har ingen baslinje. Det finns ingen "raka vägen hem till dig själv".
 *
 * Två av U(P):s sex termer normeras mot en baslinje, och de behöver ett svar ändå:
 *
 *   turnCost = tpk / (1,6 · baslinjens tpk)
 *      → referensen sätts så att nämnaren blir det ABSOLUTA taket, 4,0 svängar/km
 *        (CONTRACT §5.3). Kostnaden betyder då "hur nära zigzag-taket ligger du" — vilket
 *        är precis den frågan termen ställer när det inte finns något att jämföra med.
 *
 *   share    = andel delad väg med baslinjen
 *      → tom cellmängd. Det finns ingenting att dela med, alltså noll.
 *
 * Referensen är inte en rutt någon kör. Den är en nämnare. Den byggs med exakt så många
 * svängar som krävs för att `turnsPerKm` ska svara rätt tal, och inget mer.
 */
function normReference(seconds: number): Route {
  const km = 4;
  const turns = (TURNS_PER_KM_MAX / 1.6) * km;    // 2,5 svängar/km × 4 km = 10

  return {
    id: 'loop-normering',
    geometry: encode6([[0, 0], [0, 0]]),
    distanceM: km * 1000,
    timeS: seconds,
    maneuvers: Array.from({ length: turns }, () => ({
      type: 'turn' as const,
      distanceM: (km * 1000) / turns,
      timeS: seconds / turns,
      shapeIndex: [0, 1] as const,
    })),
    engine: 'planner',
  };
}

/**
 * Slingans hårda filter. CONTRACT §5.3:s villkor, men bara de som BETYDER något för en
 * slinga.
 *
 * ⚠️ `isNatural` är skrivet för A→B, och ett av dess villkor är rent motsägelsefullt här:
 *
 *        if (reversals(r) > 0) return false;
 *
 *    `reversals` räknar hur många gånger färdriktningen kastas om mer än 120° mellan två
 *    konsekutiva kilometerfönster. För en A→B-rutt betyder en enda sådan att du körde
 *    BAKÅT — uppenbart fel. Men EN SLINGA VÄNDER PER DEFINITION: den svänger 360° och
 *    kommer hem. Villkoret är inte strängt, det är fel fråga.
 *
 *    Mätt: den bästa slingan från Växjö — 110,5 km på 107 minuter, noll u-svängar, under
 *    5 % självöverlapp, alltså en fullt naturlig slinga — förkastades av `isNatural` med
 *    enda motiveringen "2 riktningsomkastningar". Vi hade kastat en bra slinga för att vi
 *    ställde en fråga som bara gäller raksträckor.
 *
 * Kvar står de villkor som FAKTISKT skiljer en slinga från en tur och retur:
 *
 *   · `selfOverlap > 5 %`  — kör du samma väg två gånger är det ingen slinga. DET är
 *                            testet `reversals` försökte vara, och det mäter saken direkt.
 *   · u-sväng              — en slinga ska aldrig behöva vända.
 *   · svängar/km > 4,0     — det absoluta taket (stadsgytter). Den relativa varianten
 *                            faller bort: det finns ingen baslinje, ingen "raka vägen hem
 *                            till dig själv".
 *   · över Tmax            — användarens budget, hårt.
 *
 * Vi räknar ingenting själva. Varje term kommer ur @mindful/core, oförändrad — vi ställer
 * bara den frågan som gäller för det här läget. Precis som läge (c) har en egen målfunktion
 * i stället för U(P) (design-v1 §3).
 */
function isNaturalLoop(c: RouteCells, Tmax: number): string[] {
  const r = c.route;
  const why: string[] = [];

  const tpk = turnsPerKm(r);
  if (tpk > TURNS_PER_KM_MAX) why.push(`svängar ${tpk.toFixed(2)}/km över taket`);
  if (r.maneuvers.some((m) => m.type === 'uturn')) why.push('u-sväng');

  const self = selfOverlap(c);
  if (self > 0.05) why.push(`självöverlapp ${(self * 100).toFixed(1)} % — det är en tur och retur`);

  if (r.timeS > Tmax) {
    why.push(`${(r.timeS / 60).toFixed(0)} min över budgetens ${(Tmax / 60).toFixed(0)}`);
  }

  return why;
}
