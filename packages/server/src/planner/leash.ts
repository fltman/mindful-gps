/**
 * Isokron-kopplet. Design-v1 §3, läge (c), steg 0.
 *
 * ⚡ "Kan jag ta mig hem?" blir en point-in-polygon-fråga, INTE ett ruttanrop.
 *
 * Nästlade isokroner runt hemmet (15/30/45/60/90 min), hämtade EN gång och cachade i
 * 30 dagar. Under körningen kostar frågan noll anrop. Det betyder att upptäcktsläget
 * fungerar i mobiltäckningsskugga — vilket är precis där de vackra små vägarna finns.
 *
 * ⚠️ Approximationen, uttalad: isokronen mäter tiden HEMIFRÅN och ut, vi frågar om tiden
 *    hem. För bilkostnad på svenskt vägnät är de nästan symmetriska (enkelriktat och
 *    svängförbud är undantagen). Kopplet är dessutom redan snålt tilltaget — 0,85 av
 *    kvarvarande budget — så asymmetrin ryms i marginalen. Ett riktigt ruttanrop per ben
 *    hade kostat ett anrop där det inte finns någon täckning att göra det över.
 */

import type { LngLat } from '@mindful/core';

/** Konturernas tider, i sekunder. Nästlade: den minsta ligger innanför den näst minsta. */
export const LEASH_CONTOURS_S: readonly number[] = [
  15 * 60, 30 * 60, 45 * 60, 60 * 60, 90 * 60,
];

/**
 * Kopplet: konturerna sorterade från kortast till längst tid, med sina polygoner.
 * Byggd av `engine.isochrone(hem, LEASH_CONTOURS_S, prefs)` — ett anrop, cachat 30 dagar.
 */
export interface Leash {
  readonly home: LngLat;
  readonly rings: readonly { readonly seconds: number; readonly polygon: GeoJSON.Polygon }[];
}

export function leashOf(
  home: LngLat, seconds: readonly number[], polygons: readonly GeoJSON.Polygon[],
): Leash {
  const rings = seconds
    .map((s, i) => ({ seconds: s, polygon: polygons[i] }))
    .filter((r): r is { seconds: number; polygon: GeoJSON.Polygon } => r.polygon !== undefined)
    .sort((a, b) => a.seconds - b.seconds);

  return { home, rings };
}

/**
 * Restiden hem från en punkt, i sekunder. Den innersta kontur som rymmer punkten.
 *
 * Ligger punkten utanför alla konturer är den längre bort än den yttersta — då säger vi
 * `Infinity`, inte "90 minuter". Ett koppel som ljuger om sin längd är inget koppel.
 */
export function timeHomeS(leash: Leash, at: LngLat): number {
  for (const ring of leash.rings) {
    if (inPolygon(at, ring.polygon)) return ring.seconds;
  }
  return Infinity;
}

/**
 * Ligger punkten i polygonen? Ray casting, med hålen respekterade.
 *
 * En isokron kring ett hem kan ha hål — en sjö, ett militärt övningsfält, ett område bakom
 * en bom. En punkt i hålet är INTE nåbar, och att låtsas det hade satt föraren i skogen.
 */
export function inPolygon(p: LngLat, poly: GeoJSON.Polygon): boolean {
  const [outer, ...holes] = poly.coordinates;
  if (!outer || !inRing(p, outer)) return false;

  for (const hole of holes) {
    if (inRing(p, hole)) return false;
  }
  return true;
}

function inRing(p: LngLat, ring: readonly (readonly number[])[]): boolean {
  const [x, y] = p;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;

    const [ax, ay] = a as [number, number];
    const [bx, by] = b as [number, number];

    // Strikt olikhet på den ena sidan och icke-strikt på den andra: en stråle som råkar
    // träffa exakt en hörnpunkt ska korsa kanten EN gång, inte två.
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }

  return inside;
}
