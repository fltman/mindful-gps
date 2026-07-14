/**
 * Från OSM-way till RoadSegment. Allt arbete sker VID INGEST, aldrig per fråga.
 *
 * ⛔ Det här är filen som gör segmentnyheten KONTINUERLIG i stället för binär, och den
 *    skillnaden är hela produkten:
 *
 *      SELECT * FROM road WHERE NOT EXISTS (visited ∩ way.h3)
 *
 *    ger NOLL kandidater i användarens hemtrakt — där appen används mest. En OSM-way är
 *    ofta kilometerlång, och efter ett halvår hemma är nästan varje way DELVIS körd.
 *    Den binära frågan svarar "inget nytt finns" precis där produkten ska leverera, och
 *    överlever bara på semestern i Norrland.
 *
 *    Därför klipps varje way i ~400 m-bitar (SEGMENT_LENGTH_M) redan här, och nyheten
 *    räknas som fraktionell täckning över bitens h3-celler (core: `segmentNovelty`).
 *    Den okörda kilometern i mitten av en way vi kört ändarna av blir synlig.
 *
 * Curvature förberäknas här av samma skäl: en planeringsomgång läser tusentals segment,
 * och kurvigheten är en ren funktion av geometrin. Att räkna om den per fråga hade gjort
 * SQL-frågan till flaskhalsen i en produkt vars hela poäng är att matten kostar noll.
 */

import {
  DENSIFY_M, H3_RES, SEGMENT_LENGTH_M,
  cell, curvatureDegPerKm, densify, gridPathCells, haversine, length,
} from '@mindful/core';
import type { LngLat, RoadClass, Surface } from '@mindful/core';

import type { DraftSegment } from './RoadIndex.js';

// ─── Vad Overpass ger oss ───────────────────────────────────────────────────

/** En way ur `out geom` — geometrin ligger inline, inga noder att slå upp. */
export interface OsmWay {
  readonly id: number;
  readonly tags?: Readonly<Record<string, string>>;
  /** Overpass talar (lat, lon). Kastningen till [lon, lat] sker i `shapeOf`, en gång. */
  readonly geometry?: readonly { readonly lat: number; readonly lon: number }[];
}

// ─── Taggar → vårt språk ────────────────────────────────────────────────────

/**
 * `highway` → RoadClass. Motorväg och trunk indexeras aldrig (se INDEXED_CLASSES) och
 * saknas därför här: en rutt som TVINGAS genom E4:an är motsatsen till produkten.
 */
const CLASS_OF_HIGHWAY: Readonly<Record<string, RoadClass>> = {
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  unclassified: 'unclassified',
  residential: 'residential',
  living_street: 'living_street',
  track: 'track',
};

/**
 * `surface` → Surface. Grus är vackert, lera är det inte (CONTRACT §5.2).
 *
 * Otaggat blir `unknown` (skönhet 0,50), aldrig gissat. En svensk `track` är visserligen
 * nästan alltid grus — men att låtsas veta det hade gett track en gratispoäng i skönhet
 * som inte kommer från data. Vi hittar inte på vad vi inte observerat.
 */
const SURFACE_OF_TAG: Readonly<Record<string, Surface>> = {
  asphalt: 'paved', paved: 'paved', concrete: 'paved', 'concrete:plates': 'paved',
  paving_stones: 'paved', sett: 'paved', cobblestone: 'paved', chipseal: 'paved',
  metal: 'paved', wood: 'paved',

  gravel: 'gravel', fine_gravel: 'gravel', compacted: 'gravel', pebblestone: 'gravel',
  grit: 'gravel', unpaved: 'gravel',

  dirt: 'dirt', ground: 'dirt', earth: 'dirt', soil: 'dirt', mud: 'dirt',
  sand: 'dirt', grass: 'dirt',
};

/** Låst bom eller privat mark. Vi föreslår aldrig en väg användaren inte får köra. */
const CLOSED = new Set(['private', 'no']);

export function classOf(tags: Readonly<Record<string, string>>): RoadClass | undefined {
  const hw = tags['highway'];
  return hw === undefined ? undefined : CLASS_OF_HIGHWAY[hw];
}

export function surfaceOf(tags: Readonly<Record<string, string>>): Surface {
  const s = tags['surface'];
  return (s !== undefined ? SURFACE_OF_TAG[s] : undefined) ?? 'unknown';
}

function isDrivable(tags: Readonly<Record<string, string>>): boolean {
  const access = tags['access'];
  const motor = tags['motor_vehicle'] ?? tags['motorcar'];

  // `motor_vehicle` slår `access`: en skogsbilväg taggad access=private men
  // motor_vehicle=destination går att köra på.
  if (motor !== undefined) return !CLOSED.has(motor);
  return access === undefined || !CLOSED.has(access);
}

function shapeOf(way: OsmWay): LngLat[] {
  return (way.geometry ?? []).map((n) => [n.lon, n.lat] as LngLat);
}

// ─── H3-täckningen ──────────────────────────────────────────────────────────

/**
 * Cellerna ett segment TÄCKER — beräknade med exakt samma recept som cellerna ett
 * RÅSPÅR skriver (server/ingest.ts, CONTRACT §3.4 steg 4 och 6).
 *
 * Symmetrin är inte kosmetisk, den är själva mätningen. `segmentNovelty` frågar hur stor
 * andel av segmentets celler som saknas i minnet. Genererade vi vägens celler efter ett
 * annat recept än spårets skulle en väg användaren KÖRT ändå redovisa celler minnet
 * aldrig fick se — och appen hade envisats med att skicka hen tillbaka dit.
 *
 *   · densifiera till 15 m: medelkordan i res 11 är 39,3 m. En OSM-way har ofta bara
 *     noder i kurvorna; en rak kilometer är två punkter. Utan mellanpunkter hoppar vi
 *     över nästan varenda cell på den kilometern.
 *   · gridPathCells: två celler som är grannar i luftlinje behöver inte dela kant.
 *     Utan mellancellerna blir täckningen ett streckat spår med hål i.
 *
 * MEN med en skillnad mot spårets recept, och den är avsiktlig: här densifieras även över
 * hål större än MAX_GAP_M. I ett GPS-spår betyder ett 800-metershål att signalen dog, och
 * då hittar vi ALDRIG på vägen däremellan (§3.4 steg 5). I en OSM-way betyder samma hål
 * bara att vägen är rak — geometrin ÄR vägen, det finns inget att gissa. Läte vi taket
 * gälla här hade varje rak kilometer täckts av en h3-gridlinje mellan två celler i stället
 * för av de celler vägen faktiskt går igenom, och en rak väg hade sett nyare ut än den är.
 */
export function cellsOfShape(shape: readonly LngLat[]): bigint[] {
  const dense = densify(shape, DENSIFY_M, Number.POSITIVE_INFINITY);
  const cells: bigint[] = [];
  const seen = new Set<bigint>();

  const add = (h3: bigint): void => {
    if (seen.has(h3)) return;
    seen.add(h3);
    cells.push(h3);
  };

  let prevCell: bigint | undefined;
  for (const p of dense) {
    const here = cell(p, H3_RES);
    if (prevCell === undefined) add(here);
    else for (const h of gridPathCells(prevCell, here)) add(h);
    prevCell = here;
  }

  return cells;
}

// ─── Klippningen ────────────────────────────────────────────────────────────

/**
 * Dela polylinen i `n` lika långa bitar. Ändpunkterna klipps in exakt där de hör hemma,
 * så bitarna möts utan glapp och utan dubbelräkning.
 */
function cut(shape: readonly LngLat[], n: number): LngLat[][] {
  const totalM = length(shape);
  const pieceM = totalM / n;

  const pieces: LngLat[][] = [];
  let current: LngLat[] = shape[0] !== undefined ? [shape[0]] : [];
  let doneM = 0;      // meter redan avklippta i FÄRDIGA bitar
  let alongM = 0;     // meter från startpunkten till `prev`
  let prev = shape[0];

  for (let i = 1; i < shape.length && prev !== undefined; i++) {
    const next = shape[i];
    if (next === undefined) break;

    const edgeM = haversine(prev, next);
    let usedM = 0;    // hur långt in på kanten vi kommit

    // En enda kant kan spänna över flera hela bitar (en rak mil utan noder).
    while (pieces.length < n - 1 && doneM + pieceM <= alongM + edgeM) {
      const t = (doneM + pieceM - alongM - usedM) / (edgeM - usedM);
      const from = current[current.length - 1] ?? prev;
      const at: LngLat = [
        from[0] + (next[0] - from[0]) * t,
        from[1] + (next[1] - from[1]) * t,
      ];

      current.push(at);
      pieces.push(current);
      current = [at];

      usedM += (edgeM - usedM) * t;
      doneM += pieceM;
    }

    current.push(next);
    alongM += edgeM;
    prev = next;
  }

  if (current.length >= 2) pieces.push(current);
  return pieces;
}

/**
 * Antal bitar. Avrundning, inte `ceil`: en way på 500 m blir EN bit på 500 m i stället
 * för en på 400 och en stump på 100. Stumpar är giftiga här — nyheten är ett medelvärde
 * över bitens celler, och en 30-metersbit har 1–2 celler. Den slår full ut på 0 eller 1
 * och blir antingen ett falskt ankare eller en falsk vägg.
 */
const pieceCount = (totalM: number): number =>
  Math.max(1, Math.round(totalM / SEGMENT_LENGTH_M));

// ─── Way → segment ──────────────────────────────────────────────────────────

/**
 * Segmentera en way. Tom lista om den inte är körbar, inte har en klass vi bryr oss om,
 * eller saknar geometri.
 *
 * Segmenteringen är en ren funktion av wayens geometri — den beror INTE på vilken ruta
 * som råkade hämta den. Två hämtningar av samma way ger därför bit för bit samma
 * segment, och en refetch efter TTL kan gå på delete-och-skriv-om utan att flytta något.
 */
export function segmentWay(way: OsmWay): DraftSegment[] {
  const tags = way.tags ?? {};
  const cls = classOf(tags);
  if (cls === undefined || !isDrivable(tags)) return [];

  const shape = shapeOf(way);
  if (shape.length < 2) return [];

  const totalM = length(shape);
  if (totalM <= 0) return [];

  const name = tags['name'];
  // Svenska riksvägar saknar ofta `name` och har bara `ref` (CONTRACT §6). Båda bärs
  // vidare orörda; att komponera "väg 27" är röstens jobb, inte vägindexets.
  const ref = tags['ref'];

  const out: DraftSegment[] = [];
  for (const piece of cut(shape, pieceCount(totalM))) {
    const segment: DraftSegment = {
      wayId: way.id,
      cls,
      surface: surfaceOf(tags),
      lengthM: length(piece),
      shape: piece,
      h3: cellsOfShape(piece),
      // Kursändringen VID snittet tillfaller ingen bit — den ligger på gränsen mellan
      // två. Med ~400 m bitar och 50 m omsampling är det en vinkel av åtta, och priset
      // för att bitarna ska vara oberoende av varandra.
      curvatureDpk: curvatureDegPerKm(piece),
      ...(name !== undefined ? { name } : {}),
      ...(ref !== undefined ? { ref } : {}),
    };
    out.push(segment);
  }

  return out;
}

/** Segmentets ankarpunkt: mitten. Den avgör vilken ruta biten bokförs i. */
export function midpointOf(shape: readonly LngLat[]): LngLat {
  const half = length(shape) / 2;

  let along = 0;
  let prev = shape[0];
  for (let i = 1; i < shape.length && prev !== undefined; i++) {
    const next = shape[i];
    if (next === undefined) break;

    const edgeM = haversine(prev, next);
    if (along + edgeM >= half && edgeM > 0) {
      const t = (half - along) / edgeM;
      return [prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t];
    }

    along += edgeM;
    prev = next;
  }

  return prev ?? [0, 0];
}
