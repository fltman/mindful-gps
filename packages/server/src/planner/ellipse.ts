/**
 * ADGW-pruning. Noll anrop. Design-v1 §3, läge (a), steg 2.
 *
 * Mängden via-punkter `v` som ÖVER HUVUD TAGET kan klara tidsbudgeten är per definition
 * insidan av ellipsen med A och B som brännpunkter:
 *
 *     haversine(A, v) + haversine(v, B)  ≤  (1 + ε) · D0 / k          k = 0,85
 *
 * `k` kompenserar för att en småväg är krokigare och långsammare än fågelvägen antyder.
 * Utanför ellipsen kan en kandidat BEVISLIGEN inte klara budgeten — den prunas gratis,
 * utan ett enda ruttanrop.
 *
 * ⛔ Sampla ALDRIG utanför.
 *
 * ── Var matten bor ───────────────────────────────────────────────────────────
 * Själva budgeten (`ellipseBudgetM`, `ELLIPSE_DETOUR_K`) ligger i roadindex/, och den
 * ligger kvar där. SQL-frågan gör ellipstestet i databasen och tiling:en bygger
 * täckningspolygonen ur samma tal — flyttade vi dem hit skulle vägindexet importera
 * planeraren, och pilen pekar åt andra hållet: planeraren orkestrerar vägindexet.
 *
 * Den här filen är planerarens sida av samma ellips: predikatet och omvägsmåttet, för de
 * punkter som INTE kommer ur en SQL-fråga (ankarnas snappade ändar, slingans ringpunkter,
 * upptäcktslägets kastade mål).
 */

import { haversine } from '@mindful/core';
import type { LngLat } from '@mindful/core';

import { ELLIPSE_DETOUR_K, ellipseBudgetM } from '../roadindex/RoadIndex.js';

export { ELLIPSE_DETOUR_K, ellipseBudgetM };

/** Summan av fokalavstånden: A → v → B, fågelvägen. Meter. */
export function focalSumM(v: LngLat, a: LngLat, b: LngLat): number {
  return haversine(a, v) + haversine(v, b);
}

/** Ligger via-punkten innanför ellipsen — alltså kan den ens klara budgeten? */
export function inEllipse(
  v: LngLat, a: LngLat, b: LngLat, epsilon: number, d0M: number,
): boolean {
  return focalSumM(v, a, b) <= ellipseBudgetM(epsilon, d0M);
}

/**
 * Omvägen genom `v`, som en faktor av baslinjen: (|Av| + |vB|) / D0.
 *
 * Nämnaren i ankarrankningen (design-v1 §3, steg 3). En punkt mitt på linjen ger en faktor
 * strax under 1 (fågelvägen är kortare än vägen); en punkt vid ellipsens ände ger upp mot
 * (1 + ε)/0,85. Måttet är monotont i omvägen och det är allt rankningen behöver.
 */
export function detourOf(v: LngLat, a: LngLat, b: LngLat, d0M: number): number {
  if (d0M <= 0) return 1;
  return Math.max(focalSumM(v, a, b) / d0M, 1e-9);
}

/** Behåll bara de punkter som kan klara budgeten. Allt annat är bevisligen bortkastat. */
export function pruneToEllipse<T>(
  items: readonly T[],
  at: (item: T) => LngLat,
  a: LngLat,
  b: LngLat,
  epsilon: number,
  d0M: number,
): T[] {
  const budget = ellipseBudgetM(epsilon, d0M);
  return items.filter((item) => focalSumM(at(item), a, b) <= budget);
}
