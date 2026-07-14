/** Testgeometri. Riktiga geodetiska punkter — inga påhittade grader. */

import type { LngLat } from '../types.js';

const R = 6_371_008.8;
const DEG = Math.PI / 180;

/** Punkten `distM` meter bort i riktningen `bearingDeg` från `from`. */
export function destination(from: LngLat, bearingDeg: number, distM: number): LngLat {
  const d = distM / R;
  const b = bearingDeg * DEG;
  const lat1 = from[1] * DEG;
  const lon1 = from[0] * DEG;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
  );

  return [lon2 / DEG, lat2 / DEG];
}

/** Rak linje: `n` punkter med `stepM` meters mellanrum i riktningen `bearingDeg`. */
export function straight(
  from: LngLat,
  bearingDeg: number,
  stepM: number,
  n: number,
): LngLat[] {
  const pts: LngLat[] = [];
  for (let i = 0; i < n; i++) pts.push(destination(from, bearingDeg, i * stepM));
  return pts;
}

/** Sluten cirkel med given radie, en punkt var `stepDeg` grad. */
export function circle(center: LngLat, radiusM: number, stepDeg: number): LngLat[] {
  const pts: LngLat[] = [];
  for (let a = 0; a <= 360; a += stepDeg) pts.push(destination(center, a, radiusM));
  return pts;
}

/** Flytta hela polylinen `distM` meter i riktningen `bearingDeg`. */
export function offset(pts: readonly LngLat[], bearingDeg: number, distM: number): LngLat[] {
  return pts.map(p => destination(p, bearingDeg, distM));
}
