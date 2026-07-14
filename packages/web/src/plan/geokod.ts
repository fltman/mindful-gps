/**
 * "Vart?" — adressökningen.
 *
 * Photon (photon.komoot.io), och inte Nominatim: Nominatims usage policy förbjuder
 * uttryckligen autocomplete. Photon är byggt för det och är nyckellöst.
 *
 * Två fällor, båda skarpt verifierade:
 *   · `countrycode=se`  — SINGULAR. `countrycodes` ger HTTP 400.
 *   · `lang=default`    — `lang=sv` ger HTTP 400. Photon kan inte svenska, och det gör
 *                         ingenting: ortnamnen i Sverige ÄR svenska i OSM.
 *
 * Reverse-geokodning görs inte här och inte under körning. Vägnamn kommer ur ruttmotorns
 * manövrar (`streetRef`), aldrig ur en geokodare — Nominatims policy stryper återkommande
 * skript till 4 anrop i minuten, och en enda aktiv förare bryter mot den.
 */

import type { LngLat } from '@mindful/core';

const PHOTON = 'https://photon.komoot.io/api/';

/** Fler än så är en lista man läser i stället för väljer ur. */
const ANTAL = 6;

/** En tangenttryckning är inte en fråga. 350 ms är den tid det tar att sluta skriva. */
export const DEBOUNCE_MS = 350;

export interface Plats {
  readonly id: string;
  /** "Kalmar". Det man känner igen. */
  readonly namn: string;
  /** "Kalmar kommun, Kalmar län". Det som skiljer två med samma namn åt. Kan vara tom. */
  readonly beskrivning: string;
  readonly at: LngLat;
}

interface PhotonEgenskaper {
  readonly osm_id?: number;
  readonly osm_type?: string;
  readonly name?: string;
  readonly street?: string;
  readonly housenumber?: string;
  readonly postcode?: string;
  readonly city?: string;
  readonly district?: string;
  readonly county?: string;
  readonly state?: string;
}

interface PhotonSvar {
  readonly features?: ReadonlyArray<{
    readonly properties?: PhotonEgenskaper;
    readonly geometry?: { readonly coordinates?: readonly number[] };
  }>;
}

/**
 * Namnet: ortens namn om den har ett, annars adressen. En träff utan endera är en träff
 * användaren inte kan känna igen, och den kastas i `sök`.
 */
function namnAv(p: PhotonEgenskaper): string {
  if (p.name) return p.name;
  if (p.street) return p.housenumber ? `${p.street} ${p.housenumber}` : p.street;
  return '';
}

/** Raden under namnet. Dubbletter tas bort — "Kalmar, Kalmar" hjälper ingen. */
function beskrivningAv(p: PhotonEgenskaper, namn: string): string {
  const delar: string[] = [];
  for (const del of [p.city, p.district, p.county, p.state]) {
    const d = del?.trim();
    if (d && d !== namn && !delar.includes(d)) delar.push(d);
  }
  return delar.slice(0, 2).join(', ');
}

/**
 * Sök. `nära` är valfri och biasar träffarna mot där man står — det är nästan alltid
 * rätt: man söker på "handelsboden", inte på "handelsboden i Kalmar".
 */
export async function sök(
  fråga: string,
  nära?: LngLat,
  signal?: AbortSignal,
): Promise<Plats[]> {
  const q = fråga.trim();
  if (q.length < 2) return [];

  const url = new URL(PHOTON);
  url.searchParams.set('q', q);
  url.searchParams.set('lang', 'default');
  url.searchParams.set('countrycode', 'se');
  url.searchParams.set('limit', String(ANTAL));
  if (nära) {
    url.searchParams.set('lon', nära[0].toFixed(5));
    url.searchParams.set('lat', nära[1].toFixed(5));
  }

  const svar = await fetch(url, { signal });
  if (!svar.ok) throw new Error('Sökningen svarade inte.');

  const kropp = (await svar.json()) as PhotonSvar;
  const platser: Plats[] = [];

  for (const f of kropp.features ?? []) {
    const p = f.properties;
    const c = f.geometry?.coordinates;
    const lon = c?.[0];
    const lat = c?.[1];
    if (!p || typeof lon !== 'number' || typeof lat !== 'number') continue;

    const namn = namnAv(p);
    if (!namn) continue;

    platser.push({
      id: `${p.osm_type ?? '?'}${p.osm_id ?? platser.length}`,
      namn,
      beskrivning: beskrivningAv(p, namn),
      at: [lon, lat],
    });
  }

  return platser;
}
