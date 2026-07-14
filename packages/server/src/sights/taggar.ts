/**
 * OSM-taggar → våra tolv sorter.
 *
 * Ordningen i `REGLER` är en PRIORITET, inte en lista. En medeltida kyrka är taggad både
 * `historic=church` och `amenity=place_of_worship`, och en borgruin är både
 * `historic=castle` och `historic=ruins`. Första träffen vinner, och därför står det
 * ovanligare och mer sevärda överst: en runsten är alltid en runsten, aldrig ett
 * "minnesmärke".
 */

import type { SightKind } from '@mindful/core';

type Taggar = Readonly<Record<string, string>>;

interface Regel {
  readonly nyckel: string;
  readonly värden: readonly string[];
  readonly sort: SightKind;
}

const REGLER: readonly Regel[] = [
  { nyckel: 'historic',  värden: ['runestone', 'rune_stone'],            sort: 'runsten' },
  { nyckel: 'natural',   värden: ['waterfall'],                          sort: 'vattenfall' },
  { nyckel: 'tourism',   värden: ['viewpoint'],                          sort: 'utsikt' },
  { nyckel: 'man_made',  värden: ['lighthouse'],                         sort: 'fyr' },
  { nyckel: 'historic',  värden: ['castle', 'fort', 'city_gate'],        sort: 'borg' },
  { nyckel: 'historic',  värden: ['ruins'],                              sort: 'borg' },
  { nyckel: 'historic',  värden: ['archaeological_site', 'tomb',
                                  'boundary_stone', 'wayside_cross'],    sort: 'fornlämning' },
  { nyckel: 'leisure',   värden: ['nature_reserve'],                     sort: 'naturreservat' },
  { nyckel: 'boundary',  värden: ['protected_area'],                     sort: 'naturreservat' },
  { nyckel: 'historic',  värden: ['church', 'chapel', 'monastery'],      sort: 'kyrka' },
  { nyckel: 'tourism',   värden: ['museum'],                             sort: 'museum' },
  { nyckel: 'tourism',   värden: ['attraction', 'artwork'],              sort: 'sevärdhet' },
  { nyckel: 'historic',  värden: ['memorial', 'monument'],               sort: 'minnesmärke' },
];

/**
 * Kyrkan är ett specialfall och får sin egen rad.
 *
 * `amenity=place_of_worship` träffar också moskéer, synagogor och Pingstkyrkans lokal i
 * ett industriområde. Bara den som ÄR en byggnad värd att se från vägen räknas, och den
 * signalen finns i `building=church` eller `historic`. En modern församlingslokal är
 * ingen sevärdhet, hur mycket den än är ett gudshus.
 */
function ärSevärdKyrka(t: Taggar): boolean {
  if (t['amenity'] !== 'place_of_worship') return false;
  return t['building'] === 'church' || t['building'] === 'chapel' || t['historic'] !== undefined;
}

/** `null` = ingen sevärdhet. Det normala svaret. */
export function sortAv(t: Taggar): SightKind | null {
  for (const r of REGLER) {
    const v = t[r.nyckel];
    if (v !== undefined && r.värden.includes(v)) return r.sort;
  }
  return ärSevärdKyrka(t) ? 'kyrka' : null;
}

/** "Kosta glasbruk". Tom sträng är helt i sin ordning — en namnlös runsten är en runsten. */
export function namnAv(t: Taggar): string {
  return t['name:sv'] ?? t['name'] ?? '';
}
