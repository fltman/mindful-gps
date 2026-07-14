/**
 * Slingrighet. CONTRACT §5.1 — FRUSEN MATTE.
 *
 * Valhalla har ingen `curvature`-encoded-value. Vi räknar den själva.
 * Utan den är "vackrare väg" tomt prat.
 */

import { angleDiff, bearing, clamp01, length, resample } from './geo.js';
import type { LngLat } from './types.js';

/**
 * Ackumulerad kursändring per kilometer. Enhet: grader/km.
 *
 * VARFÖR INTE `1 - beeline/pathLength` på 200 m-fönster:
 *   En mjuk landsvägskurva med radie 500 m ger över 200 m ett beeline/path på 0,993
 *   → c = 0,007. Måttet är helt dominerat av brus på den skalan, och blint för
 *   S-kurvor. Rätt IDÉ, fel skala.
 *
 * Ackumulerad kursändring fångar båda, och skalar linjärt:
 *   spikrak motorväg   ~5–20°/km
 *   vanlig landsväg    ~60–120°/km
 *   slingrig småväg    ~150–400°/km
 *   serpentiner        800+°/km
 */
export function curvatureDegPerKm(shape: readonly LngLat[]): number {
  const pts = resample(shape, 50);          // 50 m → filtrerar bort geometribrus
  if (pts.length < 3) return 0;

  let turned = 0;
  let a: LngLat | undefined;
  let b: LngLat | undefined;
  for (const c of pts) {
    if (a && b) turned += Math.abs(angleDiff(bearing(a, b), bearing(b, c)));  // 0..180
    a = b;
    b = c;
  }

  const km = length(pts) / 1000;
  return km > 0 ? turned / km : 0;
}

/** 0..1. 40°/km = rakt och tråkigt. 300°/km = härligt slingrigt. ⚠️ KALIBRERAS. */
export const curvatureScore = (dpk: number): number => clamp01((dpk - 40) / 260);
