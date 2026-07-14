/**
 * Vägindexet. CONTRACT §4.
 *
 * Det här är den halva av produkten som ruttmotorn inte kan göra åt oss: att VETA var
 * de okända vägarna ligger, innan vi ber om en rutt. Motorn är en dum kandidatgenerator
 * (CLAUDE.md) — nyheten är vår, och den börjar med att kunna räkna upp vägbitarna.
 *
 * Själva interfacet (`RoadIndex`, `RoadSegment`) bor i @mindful/core och återexporteras
 * här. Det får INTE skrivas av två gånger: `segmentNovelty` i core läser exakt de fält
 * som skrivs här, och en andra deklaration hade tillåtit dem att glida isär.
 */

import { cellToParent } from '@mindful/core';
import type { LngLat, RoadClass, RoadIndex, RoadSegment, Surface } from '@mindful/core';

import type { OsmWay } from './segmenter.js';

export type { RoadIndex, RoadSegment };

// ─── Tiling ─────────────────────────────────────────────────────────────────
//
// Två upplösningar, och de har olika jobb:
//
//   BOKFÖRINGEN (road_tile.h3_6) sker per res-6-cell — 7,1 km tvärs över. Det är den
//   kornighet servertabellen redan är byggd för, och den som avgör vad TTL:en gäller.
//
//   HÄMTNINGEN sker per res-5-cell — 18,7 km tvärs över, alltså precis den z10-ruta
//   (≈20×20 km) designen räknar med, och den har exakt 7 res-6-barn. En Overpass-fråga
//   fyller alltså sju bokföringsrutor på en gång.
//
// Skillnaden är inte kosmetisk. Ellipsen för en 55 km-tur täcker ~4 500 km²; res-6-cellen
// är 36 km² → 130 Overpass-frågor för EN rutt i en ny trakt. Res-5-cellen är 252 km²
// → 19 frågor. Overpass är gratis och drivs av volontärer; 130 frågor per rutt är att
// missbruka den, 19 är att använda den.
export const ROAD_TILE_RES = 6;
export const FETCH_TILE_RES = 5;

/** Vägdata ruttnar långsamt. En ny skogsbilväg är inte brådskande. */
export const TILE_TTL_DAYS = 90;

/** Bokföringsrutan en punkt (eller ett segment) hör hemma i. */
export const tileOf = (h3: bigint): bigint => cellToParent(h3, ROAD_TILE_RES);

// ─── Klasserna vi bryr oss om ───────────────────────────────────────────────
//
// Motorväg och trunk indexeras ALDRIG. De kan inte bli ankarsegment — en rutt som tvingas
// genom E4:an är motsatsen till produkten — och att lagra dem hade bara gjort varje
// Overpass-svar tre gånger tyngre. Behöver planeraren veta att rutten snuddar vid E4
// får den det ur `Route.roadClassSpans`, inte härifrån.
export const INDEXED_CLASSES: readonly RoadClass[] = [
  'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'track',
];

// ─── Ellipsen ───────────────────────────────────────────────────────────────

/**
 * ADGW-ellipsen (design-v1 §3, steg 2). Via-punkter v som KAN klara tidsbudgeten ligger
 * per definition innanför:
 *
 *     haversine(A,v) + haversine(v,B) ≤ (1 + ε) · D0 / k
 *
 * `k` kompenserar för att småvägar är långsammare och krokigare än fågelvägen antyder.
 * Utanför ellipsen kan en kandidat BEVISLIGEN inte klara budgeten — den prunas gratis.
 */
export const ELLIPSE_DETOUR_K = 0.85;

/** Summan av fokalavstånden (A→v→B) en via-punkt måste hålla sig under. Meter. */
export function ellipseBudgetM(epsilon: number, d0M: number): number {
  return ((1 + epsilon) * d0M) / ELLIPSE_DETOUR_K;
}

// ─── Var vägarna kommer ifrån ───────────────────────────────────────────────

/**
 * En hämtningsruta (res 5) in, OSM-ways ut.
 *
 * Källan MÅSTE ge wayens HELA geometri, även den del som sticker ut ur rutan. Segmenten
 * klipps ur hela wayen och fördelas sedan på bokföringsrutor efter sin mittpunkt — så
 * blir klippningen oberoende av vilken ruta som råkade hämta wayen, och två grannrutor
 * kan aldrig lägga två olika halva segment ovanpå varandra i skarven.
 *
 * Två implementationer, samma segment:
 *   · `OverpassSource` — den enstaka rutan som saknas när någon kör bortom det vi indexerat.
 *   · `PbfSource`      — hela regioner ur den lokala Sverige-extrakten, för seedning.
 */
export interface WaySource {
  readonly name: string;
  ways(fetchTile: bigint): AsyncIterable<OsmWay>;
}

// ─── Ett segment på väg IN i databasen ──────────────────────────────────────

/**
 * Ett färdigsegmenterat vägsegment som ännu inte har ett `id`.
 *
 * `id` sätts av `bigserial` i road_segment. Allt annat räknas ut VID INGEST — h3-cellerna
 * och curvature ligger i tabellen, inte i frågan. En planeringsomgång läser tusentals
 * segment; att räkna om kurvigheten per fråga hade gjort DB-frågan till flaskhalsen i en
 * produkt vars hela poäng är att nyhetsmatten kostar noll.
 */
export interface DraftSegment {
  readonly wayId: number;
  readonly cls: RoadClass;
  readonly surface: Surface;
  readonly name?: string;
  readonly ref?: string;
  readonly lengthM: number;
  readonly shape: LngLat[];
  readonly h3: bigint[];
  readonly curvatureDpk: number;
}
