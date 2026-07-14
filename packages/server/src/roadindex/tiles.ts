/**
 * Vilka rutor täcker sökrymden, och var går deras kanter?
 *
 * Ingen av funktionerna här rör databasen eller nätet. De svarar bara på frågan
 * "vilka rutor behöver jag?" — hämtningen och cachningen sker i OverpassRoadIndex.
 */

import { cellToBoundary, cellToChildren, cellToParent, latLngToCell,
         polygonToCellsExperimental, POLYGON_TO_CELLS_FLAGS } from 'h3-js';

import { bearing, haversine } from '@mindful/core';
import type { LngLat } from '@mindful/core';

import { ELLIPSE_DETOUR_K, FETCH_TILE_RES, ROAD_TILE_RES } from './RoadIndex.js';

// h3-js har inget bigint-API (se core/h3util.ts). Kastningen sker på gränsen, här.
const toHex = (h3: bigint): string => h3.toString(16);
const toBig = (hex: string): bigint => BigInt('0x' + hex);

const EARTH_R = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * Rutorna som ÖVERLAPPAR polygonen — inte de vars mittpunkt råkar ligga innanför.
 *
 * `containmentCenter` (h3:s default) tappar varenda randruta: en res-6-cell är 7 km bred,
 * och en cell vars centrum ligger 3 km utanför ellipsen kan ändå innehålla flera kilometer
 * väg innanför den. De vägarna hade blivit osynliga för planeraren — inte för att de är
 * körda, utan för att vi aldrig hämtade dem. Tyst dataförlust är värre än en tom lista.
 */
function coveringCells(ring: readonly LngLat[], res: number): bigint[] {
  const loop = ring.map((p) => [p[1], p[0]] as [number, number]);   // h3 vill ha [lat, lng]
  const cells = polygonToCellsExperimental(
    [loop], res, POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
  );
  return cells.map(toBig);
}

/**
 * Ellipsen som polygon, `steps` hörn.
 *
 * Byggd i ett lokalt planärt system runt ellipsens centrum (öst/nord i meter) och
 * projicerad tillbaka. På 100 km-skala är felet i den approximationen någon enstaka
 * meter — och rutorna är 7 000 m breda.
 */
export function ellipsePolygon(
  a: LngLat, b: LngLat, epsilon: number, d0M: number, steps = 96,
): LngLat[] {
  const budget = ((1 + epsilon) * d0M) / ELLIPSE_DETOUR_K;   // summan av fokalavstånden
  const focal = haversine(a, b) / 2;                          // c
  const semiMajor = budget / 2;                               // a_e
  const semiMinor = Math.sqrt(Math.max(0, semiMajor * semiMajor - focal * focal));

  // Centrum och storaxelns riktning. Bäringen är noll grader = norr, medurs.
  const center: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const axis = (90 - bearing(a, b)) * DEG;                    // → matematisk vinkel (öst = 0)
  const cosA = Math.cos(axis);
  const sinA = Math.sin(axis);

  const mPerLat = EARTH_R * DEG;
  const mPerLon = mPerLat * Math.cos(center[1] * DEG);

  const out: LngLat[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const u = semiMajor * Math.cos(t);
    const v = semiMinor * Math.sin(t);
    const east = u * cosA - v * sinA;
    const north = u * sinA + v * cosA;
    out.push([center[0] + east / mPerLon, center[1] + north / mPerLat]);
  }
  out.push(out[0] as LngLat);   // sluten ring
  return out;
}

/**
 * En cirkel som polygon. Sluten ring, `steps` hörn.
 *
 * Slingläget ber om en isokronring, men en region man vill SEEDA i förväg beskrivs
 * enklast som "allt inom N km härifrån".
 */
export function circlePolygon(center: LngLat, radiusM: number, steps = 64): LngLat[] {
  const mPerLat = EARTH_R * DEG;
  const mPerLon = mPerLat * Math.cos(center[1] * DEG);

  const out: LngLat[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    out.push([
      center[0] + (radiusM * Math.cos(t)) / mPerLon,
      center[1] + (radiusM * Math.sin(t)) / mPerLat,
    ]);
  }
  out.push(out[0] as LngLat);
  return out;
}

/** Bokföringsrutorna (res 6) som ellipsen rör vid. */
export function tilesForEllipse(
  a: LngLat, b: LngLat, epsilon: number, d0M: number,
): bigint[] {
  return coveringCells(ellipsePolygon(a, b, epsilon, d0M), ROAD_TILE_RES);
}

/**
 * Bokföringsrutorna som en ringpolygon rör vid (slingläget, design-v1 läge (b)).
 *
 * Polygonens hål respekteras: en isokronring med ett hål i mitten hämtar inte hem
 * hemtrakten en gång till.
 */
export function tilesForRing(ring: GeoJSON.Polygon): bigint[] {
  const loops = ring.coordinates.map(
    (loop) => loop.map((p) => [p[1] as number, p[0] as number] as [number, number]),
  );
  const cells = polygonToCellsExperimental(
    loops, ROAD_TILE_RES, POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
  );
  return cells.map(toBig);
}

/** Hämtningsrutan (res 5) en bokföringsruta hör till. Exakt 7 barn per förälder. */
export function fetchParentOf(tile: bigint): bigint {
  return toBig(cellToParent(toHex(tile), FETCH_TILE_RES));
}

/** Bokföringsrutorna en hämtningsruta täcker. */
export function tilesUnder(parent: bigint): bigint[] {
  return cellToChildren(toHex(parent), ROAD_TILE_RES).map(toBig);
}

/** Rutans hörn som `[lon, lat]`, sluten ring. Overpass-polygonen. */
export function tileBoundary(tile: bigint): LngLat[] {
  const b = cellToBoundary(toHex(tile)).map(([lat, lon]) => [lon, lat] as LngLat);
  const first = b[0];
  if (first) b.push(first);
  return b;
}

/** Rutan en punkt hör hemma i. */
export function tileAt(p: LngLat, res: number = ROAD_TILE_RES): bigint {
  return toBig(latLngToCell(p[1], p[0], res));
}

// ─── Bbox ───────────────────────────────────────────────────────────────────

export interface Bbox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

/** Bboxen som omsluter en ring. Förfiltret i varje PostGIS-fråga börjar här. */
export function bboxOf(ring: readonly LngLat[]): Bbox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return { minLon, minLat, maxLon, maxLat };
}
