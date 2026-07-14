/**
 * Geometri. Distanser i meter, vinklar i grader, koordinater ALLTID [lon, lat].
 *
 * Ren matematik — inget minne, ingen H3, inga API:er. Allt annat i core bygger på
 * den här filen, så den måste vara tråkig och rätt.
 */

import { DENSIFY_M, MAX_GAP_M } from './constants.js';
import type { LngLat } from './types.js';

/** Jordens medelradie (IUGG). Fel < 0,3 % för våra avstånd — det räcker gott. */
const EARTH_R_M = 6_371_008.8;

const DEG = Math.PI / 180;

/**
 * Under en millimeter är två punkter samma punkt. Används för att avgöra om en
 * ändpunkt redan är utskriven, inte för någon geometrisk approximation.
 */
const EPS_M = 1e-3;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Storcirkelavstånd i meter. */
export function haversine(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const dLat = lat2 - lat1;
  const dLon = (b[0] - a[0]) * DEG;

  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bäring a → b, grader medurs från norr. 0..360. */
export function bearing(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const dLon = (b[0] - a[0]) * DEG;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2)
          - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = Math.atan2(y, x) / DEG;
  return (deg + 360) % 360;
}

/**
 * Kortaste vinkeln från b1 till b2, tecknad. [-180, 180).
 * Positiv = medurs (höger). `Math.abs()` ger kursändringen 0..180.
 */
export function angleDiff(b1: number, b2: number): number {
  return ((b2 - b1 + 540) % 360) - 180;
}

/** Polylinens längd i meter. */
export function length(pts: readonly LngLat[]): number {
  let total = 0;
  let prev: LngLat | undefined;
  for (const p of pts) {
    if (prev) total += haversine(prev, p);
    prev = p;
  }
  return total;
}

/**
 * Punkt en bråkdel `t` in på segmentet a→b.
 *
 * Linjär interpolation i lon/lat. Över en enskild polyline-kant (tiotals meter) är
 * skillnaden mot storcirkeln millimeter — men mät ALLTID resultatet med haversine,
 * blanda aldrig in grader i en distansberäkning.
 */
function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Sampla om polylinen till jämna avstånd (`spacingM`) längs vägen.
 *
 * Ändpunkterna behålls ALLTID. Sista intervallet blir därför oftast kortare än
 * `spacingM` — det är avsiktligt: en rutt som slutar 12 m in på ett sampelintervall
 * ska inte tappa sina sista 12 meter.
 */
export function resample(pts: readonly LngLat[], spacingM: number): LngLat[] {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || pts.length < 2 || spacingM <= 0) {
    return first ? [first] : [];
  }

  const out: LngLat[] = [first];
  let untilNext = spacingM;   // meter kvar till nästa sampel
  let prev = first;

  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    if (!cur) break;

    const segM = haversine(prev, cur);
    if (segM > 0) {
      let along = 0;          // hur långt in på segmentet vi kommit
      while (along + untilNext <= segM) {
        along += untilNext;
        out.push(lerp(prev, cur, along / segM));
        untilNext = spacingM;
      }
      untilNext -= segM - along;
    }
    prev = cur;
  }

  // Snäpp till den exakta ändpunkten i stället för att lägga en dubblett bredvid den.
  const tail = out[out.length - 1];
  if (tail && haversine(tail, last) <= EPS_M) out[out.length - 1] = last;
  else out.push(last);

  return out;
}

/**
 * Skjut in mellanpunkter så att inget avstånd överstiger `spacingM`.
 *
 * Vid 90 km/h och 1 Hz rör du dig 25 m per fix. Medelkordan i H3 res 11 är 39,3 m —
 * utan interpolation HOPPAR VI ÖVER CELLER (CONTRACT §3.4 steg 4).
 *
 * MEN: hål större än `maxGapM` lämnas orörda. Ett stort hål är signalförlust eller en
 * släckt skärm, och vi hittar ALDRIG på en väg vi inte observerat (§3.4 steg 5).
 * Anroparen markerar hålet som `Gap` — det syns fortfarande som ett långt avstånd
 * mellan två konsekutiva punkter i resultatet.
 */
export function densify(
  pts: readonly LngLat[],
  spacingM: number = DENSIFY_M,
  maxGapM: number = MAX_GAP_M,
): LngLat[] {
  const first = pts[0];
  if (!first || pts.length < 2 || spacingM <= 0) return pts.slice();

  const out: LngLat[] = [first];
  let prev = first;

  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    if (!cur) break;

    const segM = haversine(prev, cur);
    if (segM > spacingM && segM <= maxGapM) {
      const steps = Math.ceil(segM / spacingM);
      for (let k = 1; k < steps; k++) out.push(lerp(prev, cur, k / steps));
    }
    out.push(cur);
    prev = cur;
  }

  return out;
}

// ─── Polyline, precision 6 ──────────────────────────────────────────────────
//
// Googles polyline-algoritm med faktor 1e6. Valhalla kodar LATITUD FÖRST i strömmen —
// vår LngLat är [lon, lat]. Kastningen sker här, en gång, och ingen annanstans.

const FACTOR6 = 1e6;

/** En signerad, zigzag-kodad delta enligt Googles algoritm. */
function encodeSigned(value: number, out: string[]): void {
  let v = value < 0 ? ~(value << 1) : value << 1;
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>>= 5;
  }
  out.push(String.fromCharCode(v + 63));
}

export function encode6(pts: readonly LngLat[]): string {
  const out: string[] = [];
  let prevLat = 0;
  let prevLon = 0;

  for (const p of pts) {
    // Räkna deltan mot det AVRUNDADE föregående värdet, aldrig mot flyttalet:
    // annars ackumuleras avrundningsfelet längs hela polylinen.
    const lat = Math.round(p[1] * FACTOR6);
    const lon = Math.round(p[0] * FACTOR6);
    encodeSigned(lat - prevLat, out);
    encodeSigned(lon - prevLon, out);
    prevLat = lat;
    prevLon = lon;
  }

  return out.join('');
}

export function decode6(encoded: string): LngLat[] {
  const pts: LngLat[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;

  while (i < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && i < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && i < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    pts.push([lon / FACTOR6, lat / FACTOR6]);
  }

  return pts;
}

// ─── Projektion ─────────────────────────────────────────────────────────────

export interface Projection {
  /** Närmaste punkten PÅ polylinen. */
  readonly at: LngLat;
  /** Index på startnoden i det segment träffen ligger på. */
  readonly segmentIndex: number;
  /** Vinkelrätt avstånd från frågepunkten till polylinen, meter. */
  readonly distanceM: number;
  /** Avstånd längs polylinen från dess start fram till `at`, meter. */
  readonly alongM: number;
}

/**
 * Närmaste punkt på polylinen.
 *
 * `distanceM` svarar på "är jag av rutten?", `alongM` på "hur långt har jag kommit?".
 * Båda behövs i navigeringen; hade vi bara returnerat den ena hade varje anropare fått
 * räkna ut den andra själv — och då har vi två implementationer av samma tal igen.
 *
 * Projektionen görs i ett lokalt plan (longituden skalas med cos(lat)). Över ett enskilt
 * polyline-segment är det exakt nog; svaret mäts sedan alltid med haversine.
 */
export function projectOnPolyline(p: LngLat, pts: readonly LngLat[]): Projection | undefined {
  const first = pts[0];
  if (!first) return undefined;
  if (pts.length === 1) {
    return { at: first, segmentIndex: 0, distanceM: haversine(p, first), alongM: 0 };
  }

  const kx = Math.cos(p[1] * DEG);   // longitudgrader → latitudgrader, lokalt

  let best: Projection = {
    at: first,
    segmentIndex: 0,
    distanceM: haversine(p, first),
    alongM: 0,
  };

  let prev = first;
  let travelled = 0;

  for (let i = 1; i < pts.length; i++) {
    const cur = pts[i];
    if (!cur) break;

    const segM = haversine(prev, cur);
    const ax = (cur[0] - prev[0]) * kx;
    const ay = cur[1] - prev[1];
    const px = (p[0] - prev[0]) * kx;
    const py = p[1] - prev[1];

    const len2 = ax * ax + ay * ay;
    const t = len2 > 0 ? clamp01((px * ax + py * ay) / len2) : 0;
    const at = lerp(prev, cur, t);
    const d = haversine(p, at);

    if (d < best.distanceM) {
      best = { at, segmentIndex: i - 1, distanceM: d, alongM: travelled + t * segM };
    }

    travelled += segM;
    prev = cur;
  }

  return best;
}
