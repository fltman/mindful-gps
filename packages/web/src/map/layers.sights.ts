/**
 * Sevärdheterna på kartan.
 *
 * ⛔ De styr INTE rutten. Vi mätte den varianten och den föll — i Sverige ligger
 *    sevärdheterna längs de vägar folk alltid har färdats, så att rutta mot dem är att
 *    rutta tillbaka mot den vanliga vägen (se `core/sights.ts` och `bench/sevardheter.ts`).
 *
 * Så här gör de i stället: de STÅR DÄR. Kör du förbi en runsten säger appen ingenting, men
 * den finns på skärmen om du råkar titta. Ser du den, svänger du av. Gör du inte det, har
 * ingenting hänt. Det är hela kontraktet med föraren, och det är samma kontrakt som
 * tystnadsdoktrinen: appen berättar vad som finns och lägger sig inte i.
 *
 * Därför ingen pin som pekar, ingen bricka som räknar, ingen ring som pulserar. En prick
 * och ett namn.
 */

import { SIGHT_WEIGHT, type Sight, type SightKind } from '@mindful/core';
import type {
  CircleLayerSpecification, GeoJSONSource, Map as MapLibreMap, SymbolLayerSpecification,
} from 'maplibre-gl';

import { SEV_MÖRK, SEV_NATUR, SEV_SPÅR } from './palett.js';

export const KÄLLA_SEV = 'sevärdheter';
export const LAGER_SEV_PRICK = 'sev-prick';
export const LAGER_SEV_NAMN = 'sev-namn';

/**
 * Under den här zoomen ritas ingenting.
 *
 * ⚠️ Den var 11 först, och det var fel — mätt, inte tyckt. Vid körzoom (14,5) ser man ett
 *    par kvadratkilometer, och sevärdheterna ligger med ungefär en per tio. Lagret
 *    fungerade perfekt och syntes bokstavligen aldrig.
 *
 *    Sevärdheterna är som mest värda något på ÖVERSIKTEN, när man tittar på rutten och
 *    väljer — inte i kurvan. Zoom 9 är hela turen i bild. Där hör de hemma.
 *
 * Priset är trängsel, och det betalas av `TUNG_NOG` nedan.
 */
export const SEV_MINZOOM = 9;

/**
 * Utzoomad ritas bara de tunga: utsikter, runstenar, vattenfall, borgar, naturreservat.
 *
 * Varenda minnessten och hembygdsgård utzoomat är inte en karta, det är gröt — och gröt
 * läser ingen. Från zoom 12 (ungefär "trakten") får alla vara med.
 */
const TUNG_NOG = 0.7;
const ALLA_FRÅN_ZOOM = 12;

/**
 * Naturen är grön, spåren efter människor är bruna. Två familjer, inte tolv färger:
 * en karta med tolv prickfärger är en legend man måste lära sig, och den lär sig ingen
 * i nittio i en kurva.
 */
const NATUR: readonly SightKind[] = ['utsikt', 'vattenfall', 'naturreservat'];

const färgAv = (kind: SightKind): string => (NATUR.includes(kind) ? SEV_NATUR : SEV_SPÅR);

interface Egenskaper {
  readonly namn: string;
  readonly färg: string;
  /** SIGHT_WEIGHT. Styr både storlek och vem som får behålla sitt namn när det trängs. */
  readonly vikt: number;
}

function tillGeoJSON(sights: readonly Sight[]): GeoJSON.FeatureCollection<GeoJSON.Point, Egenskaper> {
  return {
    type: 'FeatureCollection',
    features: sights.map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.at[0], s.at[1]] },
      properties: { namn: s.name, färg: färgAv(s.kind), vikt: SIGHT_WEIGHT[s.kind] },
    })),
  };
}

const prickLager = (tema: 'ljust' | 'mörkt'): CircleLayerSpecification => ({
  id: LAGER_SEV_PRICK,
  type: 'circle',
  source: KÄLLA_SEV,
  minzoom: SEV_MINZOOM,
  paint: {
    // Utsikten är större än minnesmärket. Vikten är redan svaret på "hur mycket är det
    // värt att se det här från bilen" — den behöver ingen egen skala.
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      SEV_MINZOOM, ['+', 1.5, ['*', 1.5, ['get', 'vikt']]],
      15, ['+', 3.0, ['*', 3.0, ['get', 'vikt']]],
    ],
    'circle-color': ['get', 'färg'],
    // De lätta sevärdheterna tonas in först när kartan är nära nog att bära dem.
    'circle-opacity': [
      'interpolate', ['linear'], ['zoom'],
      SEV_MINZOOM, ['case', ['>=', ['get', 'vikt'], TUNG_NOG], 0.85, 0],
      ALLA_FRÅN_ZOOM, 0.85,
    ],
    'circle-stroke-width': [
      'interpolate', ['linear'], ['zoom'],
      SEV_MINZOOM, ['case', ['>=', ['get', 'vikt'], TUNG_NOG], 1, 0],
      ALLA_FRÅN_ZOOM, 1,
    ],
    'circle-stroke-color': tema === 'mörkt' ? SEV_MÖRK : '#f7f2e7',
    'circle-stroke-opacity': 0.9,
  },
});

const namnLager = (tema: 'ljust' | 'mörkt'): SymbolLayerSpecification => ({
  id: LAGER_SEV_NAMN,
  type: 'symbol',
  source: KÄLLA_SEV,
  // Namnen långt senare än prickarna. En prick är en antydan; ett namn är en utsaga,
  // och den kräver plats.
  minzoom: 13,
  filter: ['!=', ['get', 'namn'], ''],
  layout: {
    'text-field': ['get', 'namn'],
    'text-font': ['Noto Sans Italic'],
    'text-size': 11,
    'text-offset': [0, 0.9],
    'text-anchor': 'top',
    'text-max-width': 9,
    'text-padding': 6,
    // Trängs det: den tyngsta sevärdheten behåller sitt namn. MapLibre sorterar stigande,
    // så vi vänder på vikten.
    'symbol-sort-key': ['-', 1, ['get', 'vikt']],
  },
  paint: {
    'text-color': ['get', 'färg'],
    'text-halo-color': tema === 'mörkt' ? SEV_MÖRK : '#f7f2e7',
    'text-halo-width': 1.4,
  },
});

/** Lagren, en gång per stil. Anropas om vid temabyte — stilen tar med sig allt i graven. */
export function monteraSevärdheter(map: MapLibreMap, tema: 'ljust' | 'mörkt'): void {
  if (!map.getSource(KÄLLA_SEV)) {
    map.addSource(KÄLLA_SEV, { type: 'geojson', data: tillGeoJSON([]) });
  }
  if (!map.getLayer(LAGER_SEV_PRICK)) map.addLayer(prickLager(tema));
  if (!map.getLayer(LAGER_SEV_NAMN)) map.addLayer(namnLager(tema));
}

export function sättSevärdheter(map: MapLibreMap, sights: readonly Sight[]): void {
  const källa = map.getSource(KÄLLA_SEV) as GeoJSONSource | undefined;
  källa?.setData(tillGeoJSON(sights));
}
