/**
 * Hämtar sevärdheterna för det utsnitt kartan visar.
 *
 * ── Varför den är så här tråkig ─────────────────────────────────────────────
 *
 * Den här filen får inte kosta något under körning. Ett laggande kartlager under en
 * navigering är inte en skönhetsfläck — det är en app som slutar rita vägen framför bilen.
 * Därför:
 *
 *   · Ingenting hämtas under SEV_MINZOOM. Är hela Småland i bild finns inget att visa.
 *   · Utsnittet växer till ett RUTNÄT. Panorerar man tio meter är det samma ruta, och då
 *     sker inget anrop alls. Utan det hade varje kartrörelse blivit en fråga.
 *   · Rutorna cachas. Kör man tillbaka samma väg hämtas ingenting igen.
 *   · Anropet avbryts om ett nytt kommer. Det sista svaret är det enda som betyder något.
 */

import type { Sight } from '@mindful/core';

const API = import.meta.env['VITE_API'] ?? 'http://localhost:8161';

/**
 * Rutnätets steg, i grader. 0,25° ≈ 28 km i latitud — en bra bit större än vad som ryms
 * på skärmen vid zoom 11, så en ruta räcker oftast för flera skärmar av panorering.
 */
const STEG = 0.25;

/** Rutorna vi redan hämtat. Sevärdheter ändrar sig inte medan man kör. */
const cache = new Map<string, Sight[]>();

const golv = (x: number): number => Math.floor(x / STEG) * STEG;

/** Rutorna som täcker utsnittet. Nästan alltid en eller två. */
function rutorFör(bbox: [number, number, number, number]): string[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const ut: string[] = [];

  for (let lat = golv(minLat); lat <= maxLat; lat += STEG) {
    for (let lon = golv(minLon); lon <= maxLon; lon += STEG) {
      ut.push(`${lon.toFixed(2)},${lat.toFixed(2)}`);
    }
  }
  return ut;
}

async function hämtaRuta(nyckel: string, signal: AbortSignal): Promise<Sight[]> {
  const träff = cache.get(nyckel);
  if (träff) return träff;

  const [lon, lat] = nyckel.split(',').map(Number) as [number, number];
  const bbox = [lon, lat, lon + STEG, lat + STEG].map((n) => n.toFixed(4)).join(',');

  const res = await fetch(`${API}/api/sights?bbox=${bbox}`, { signal });
  if (!res.ok) throw new Error(`sevärdheter: ${res.status}`);

  const { sights } = await res.json() as { sights: Sight[] };
  cache.set(nyckel, sights);
  return sights;
}

/**
 * Alla sevärdheter i utsnittet.
 *
 * Ett nätfel är inte en kris: kartan ritar det den har och försöker igen nästa gång man
 * panorerar. En app som slänger upp "kunde inte hämta sevärdheter" mitt i en kurva har
 * missförstått vad den är till för.
 */
export async function sevärdheterFör(
  bbox: [number, number, number, number], signal: AbortSignal,
): Promise<Sight[]> {
  const rutor = rutorFör(bbox);
  const svar = await Promise.all(
    rutor.map((r) => hämtaRuta(r, signal).catch(() => [] as Sight[])),
  );
  return svar.flat();
}

/**
 * Rutorna utsnittet täcker, som EN sträng.
 *
 * Kartan jämför den mot förra svepets: är den oförändrad har vi redan det som ska ritas,
 * och då sker varken anrop eller omritning. Under en körning är det det normala fallet —
 * rutan är ~28 km, kameran flyttar sig tjugo meter.
 */
export function rutnyckel(bbox: [number, number, number, number]): string {
  return rutorFör(bbox).join('|');
}
