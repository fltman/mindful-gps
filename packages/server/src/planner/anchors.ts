/**
 * Ankarsegmenten: de okända vägbitarna vi TVINGAR rutten genom.
 *
 * Det här är skillnaden mellan "slumpmässig omväg" och "överraskande vacker rutt". Vi
 * samplar inte blint och hoppas att rutten råkar bli ny — vi hittar de okända vägbitarna
 * först, i vårt eget vägindex, och gör dem till `through`-punkter. Det kostar noll extra
 * anrop: en databasfråga och lite aritmetik.
 *
 * Motorn får aldrig veta något om nyhet. Den är en dum kandidatgenerator (CLAUDE.md).
 */

import {
  CLASS_BEAUTY, H3_SPREAD_RES, NOVELTY_ANCHOR_MIN,
  cell, curvatureScore, haversine, segmentNovelty,
} from '@mindful/core';
import type { LngLat, RoadSegment, RouteProvider, VisitedIndex } from '@mindful/core';

import { midpointOf } from '../roadindex/segmenter.js';
import { ANCHOR_CLASSES, ANCHOR_SNAP } from './context.js';
import { detourOf } from './ellipse.js';

/**
 * Ett ankarsegment, orienterat och färdigt att bli två `through`-punkter.
 *
 * `start` och `end` är segmentets två ändar, ORIENTERADE så att `start` är den ände som
 * ligger närmast A och `end` den som ligger närmast B. Utan orienteringen hade rutten
 * A → start → end → B kunnat tvingas att först köra förbi segmentet, vända, och köra
 * tillbaka igenom det — through-punkter förbjuder u-svängen, så motorn hade i stället
 * lagt en lång och absurd ögla. Orienteringen kostar två haversine och tar bort hela
 * felklassen.
 */
export interface Anchor {
  readonly segment: RoadSegment;
  /** Segmentets mittpunkt. Matrisens frågepunkt — och samma punkt som SQL-ellipsen testar. */
  readonly mid: LngLat;
  readonly start: LngLat;
  readonly end: LngLat;
  readonly novelty: number;
  readonly beauty: number;
  readonly rank: number;
}

/**
 * Segmentets skönhet som ANKARE: klassens skönhet gånger dess slingrighet (design-v1 §3,
 * steg 3). Två 0..1-tal, alltså 0..1.
 *
 * Observera att en spikrak väg får noll — `curvatureScore` är 0 under 40°/km. Det är
 * avsiktligt: en rak väg är inte vacker, hur okänd den än är, och vi vill inte tvinga
 * någon genom en. Mätt på vårt eget index är 83 % av `primary` och 34 % av `tertiary`
 * rakare än så; 14 % av `unclassified` och 10 % av `track`. Kurvorna finns där de ska.
 */
export function anchorBeauty(s: RoadSegment): number {
  return CLASS_BEAUTY[s.cls] * curvatureScore(s.curvatureDpk);
}

/**
 * Vi tvingar rutten genom en VÄG, aldrig genom en 400-metersnypa.
 *
 * ⚠️ Mätt, inte gissat. Med designens rank — `nov^1.5 · bty · seg.lengthM / det` — blev alla
 *    åtta ankare i Växjö→Kalmar detta: NAMNLÖSA `unclassified`-ways på 590 m, ett enda
 *    segment långa, med 300–660°/km. Fyra av åtta rutter genom dem fick en U-SVÄNG, och
 *    u-svängen låg exakt vid ankaret. Det är ingen slump: en 590 m lång, spikkrokig,
 *    namnlös småväg är en vändplan, en grustäkt eller en återvändsgränd. Man kör in, man
 *    kör ut. Det ÄR u-svängen.
 *
 *    Tre effekter förstärkte varandra:
 *      1. `curvatureScore` mättar vid 300°/km → tusentals segment ligger lika på bty = 0,90.
 *      2. `seg.lengthM` avgör då. Men segmenten är ~400 m PER KONSTRUKTION (§3.1), så
 *         termen bär ingen information — utom en artefakt: `pieceCount` avrundar, så en way
 *         under 600 m blir EN bit på 590 m, längre än de 400 m-bitar riktiga vägar klipps i.
 *         Formeln väljer alltså bokstavligen "den längsta möjliga enskilda biten" = en way
 *         strax under 600 m.
 *      3. 75 % av ellipsens ways har bara ett segment. Stubbarna är i majoritet.
 *
 *    Designens `· seg.lengthM` MENADE "mer okänd väg är bättre". Med likformiga segment
 *    säger den ingenting alls. Vi låter den betyda det den menade: wayens längd, alltså hur
 *    mycket sammanhängande okänd väg som faktiskt ligger här.
 */
const MIN_ANCHOR_WAY_M = 1_000;

/**
 * Rangordna segmenten i ellipsen (design-v1 §3, steg 3):
 *
 *     nov   = segmentNovelty(seg, mem, today)      ← KONTINUERLIG, aldrig NOT EXISTS
 *     bty   = CLASS_BEAUTY[seg.cls] · curvatureScore(seg.curvatureDpk)
 *     det   = (haversine(A, mid) + haversine(mid, B)) / D0
 *     rank  = nov^1.5 · bty · wayLängd / det
 *
 * `nov^1.5` böjer skalan: ett halvkört segment (0,5) är inte halva värdet av ett okört
 * (1,0), det är en tredjedel. Nyhet ÄR produkten och den ska dominera.
 *
 * ⛔ Sevärdheter finns INTE i den här formeln, och det är ett mätresultat, inte ett
 *    förbiseende. Se `bench/sevardheter.ts`: i Sverige ligger sevärdheterna längs de vägar
 *    folk alltid har färdats, så att dra rutten mot dem är att dra den TILLBAKA mot den
 *    vanliga vägen. Vi mätte det. Rutten blev 4,4 % längre och 1,7 % glesare på
 *    sevärdheter per kilometer. Sevärdheterna ritas på kartan i stället — appen berättar
 *    vad som finns, den bestämmer inte åt dig.
 *
 * Segment under NOVELTY_ANCHOR_MIN faller bort — vi tvingar aldrig någon genom en väg hen
 * redan kör varje vecka. Spikraka segment faller bort — de är inte vackra, hur okända de
 * än är. Och stubbar faller bort; se MIN_ANCHOR_WAY_M.
 */
export function rankAnchors(
  segments: readonly RoadSegment[],
  a: LngLat,
  b: LngLat,
  d0M: number,
  mem: VisitedIndex,
  today: number,
): Anchor[] {
  // Wayens längd INOM ellipsen. En way som sträcker sig ut ur sökrymden räknas bara för
  // den del vi faktiskt kan rutta genom — och det är också den del som är värd något.
  const wayLengthM = new Map<number, number>();
  for (const s of segments) {
    wayLengthM.set(s.wayId, (wayLengthM.get(s.wayId) ?? 0) + s.lengthM);
  }

  const out: Anchor[] = [];

  for (const segment of segments) {
    const wayM = wayLengthM.get(segment.wayId) ?? segment.lengthM;
    if (wayM < MIN_ANCHOR_WAY_M) continue;

    const novelty = segmentNovelty(segment, mem, today);
    if (novelty < NOVELTY_ANCHOR_MIN) continue;

    const beauty = anchorBeauty(segment);
    if (beauty <= 0) continue;

    const mid = midpointOf(segment.shape);
    const rank = novelty ** 1.5 * beauty * wayM / detourOf(mid, a, b, d0M);

    const [start, end] = orient(segment.shape, a, b);
    out.push({ segment, mid, start, end, novelty, beauty, rank });
  }

  return out.sort((x, y) => y.rank - x.rank);
}

/** Segmentets ändar, A-änden först. Se `Anchor.start`. */
function orient(shape: readonly LngLat[], a: LngLat, b: LngLat): [LngLat, LngLat] {
  const first = shape[0];
  const last = shape[shape.length - 1];
  if (!first || !last) throw new Error('ankarsegment utan geometri');

  const asIs = haversine(a, first) + haversine(last, b);
  const flipped = haversine(a, last) + haversine(first, b);
  return flipped < asIs ? [last, first] : [first, last];
}

/**
 * ⭐ SPRIDNING: högst ETT ankare per H3 res-7-cell (≈ 5 km) — och högst ett per VÄG.
 *
 * Utan spridning hamnar alla fjorton kandidaterna i samma skogsdunge, den vackraste, och
 * användaren får tre "olika" rutter som alla svänger av på samma ställe. Rankningen är
 * girig och gör precis det, för den vackra dungens segment ligger alla i topp.
 *
 * ⚠️ Res-7-cellen ensam räcker inte, och det är mätt: när ankarna väl blev riktiga vägar i
 *    stället för stubbar låg FYRA av åtta på samma väg — länsväg H 665, två mil lång. En
 *    två mil lång väg går genom flera res-7-celler, så cellspridningen ser fyra "olika"
 *    platser där det i själva verket finns en enda väg. Fyra kandidater, ett val.
 *
 *    Vägen är den enhet användaren faktiskt väljer mellan ("den där vägen har du aldrig
 *    kört"), så vägen är den enhet vi sprider över.
 */
export function spread(anchors: readonly Anchor[], k: number): Anchor[] {
  const takenCells = new Set<bigint>();
  const takenWays = new Set<number>();
  const out: Anchor[] = [];

  // `anchors` är redan rankad; först till kvarn i varje cell är alltså cellens bästa.
  for (const anchor of anchors) {
    if (out.length >= k) break;

    const cellId = cell(anchor.mid, H3_SPREAD_RES);
    if (takenCells.has(cellId) || takenWays.has(anchor.segment.wayId)) continue;

    takenCells.add(cellId);
    takenWays.add(anchor.segment.wayId);
    out.push(anchor);
  }

  return out;
}

/**
 * Snappa ankarnas ändar till vägnätet. ETT locate-anrop, oavsett hur många ankare.
 *
 * Löser två fällor på en gång:
 *   · "punkten hamnade i en sjö"        → adaptern förkastar allt bortom `radiusM` (25 m),
 *                                          för Valhallas `radius` är ingen spärr utan en
 *                                          antydan — verifierat: den snappade 2 663 m bort
 *                                          trots `radius: 300`.
 *   · "punkten snappade till E4:an"     → `maxRoadClass: 'tertiary'`.
 *
 * Ett ankare vars ENA ände dör kastas helt. Halva ett segment är inte ett segment; att
 * behålla det hade betytt att vi tvingar rutten genom en punkt vi inte längre vet var den
 * ligger.
 *
 * De snappade koordinaterna ersätter de råa. De ligger nu bevisligen PÅ en liten väg, och
 * det är just den vägen rutten ska tvingas igenom.
 */
export async function snapAnchors(
  engine: RouteProvider, anchors: readonly Anchor[],
): Promise<Anchor[]> {
  if (anchors.length === 0) return [];

  const points: LngLat[] = [];
  for (const a of anchors) points.push(a.start, a.end);

  const snapped = await engine.locate(points, ANCHOR_SNAP);

  const accepted = new Set<string>(ANCHOR_CLASSES);
  const out: Anchor[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const start = snapped[2 * i];
    const end = snapped[2 * i + 1];
    if (!anchor || !start || !end) continue;

    if (!start.ok || !end.ok) continue;
    // Klasskontrollen är i praktiken redan gjord av `search_filter`. Vi gör den ändå:
    // en tyst ignorerad filternyckel hade annars sett ut som ett fungerande filter, och
    // via-punkten hade legat på E4:an utan att någon märkte det.
    if (!accepted.has(start.roadClass) || !accepted.has(end.roadClass)) continue;

    out.push({ ...anchor, start: start.at, end: end.at });
  }

  return out;
}
