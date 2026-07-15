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

import { GULD, SEV_MÖRK, SEV_NATUR, SEV_SPÅR } from './palett.js';

export const KÄLLA_SEV = 'sevärdheter';
export const LAGER_SEV_PRICK = 'sev-prick';
export const LAGER_SEV_NAMN = 'sev-namn';
export const LAGER_SEV_NAMN_LATT = 'sev-namn-latt';
export const LAGER_SEV_TRYCK = 'sev-tryck';

export const KÄLLA_VALD = 'sev-vald';
export const LAGER_VALD = 'sev-vald-ring';

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
  /** OSM-id, med n/w/r inbakat. Nyckeln som berättelsen hämtas och cachas på. */
  readonly id: number;
  readonly namn: string;
  readonly kind: SightKind;
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
      properties: {
        id: s.id, namn: s.name, kind: s.kind, färg: färgAv(s.kind), vikt: SIGHT_WEIGHT[s.kind],
      },
    })),
  };
}

/** Ringens färg — ljus mot den ljusa kartan, mörk mot den mörka. Det som får pricken att lyfta. */
const ringfärg = (tema: 'ljust' | 'mörkt'): string => (tema === 'mörkt' ? SEV_MÖRK : '#f7f2e7');

const prickLager = (tema: 'ljust' | 'mörkt'): CircleLayerSpecification => ({
  id: LAGER_SEV_PRICK,
  type: 'circle',
  source: KÄLLA_SEV,
  minzoom: SEV_MINZOOM,
  paint: {
    // Större än förr, och med en tydlig ljus ring: en färgad prick mot en grön karta
    // försvinner, en prick med ram gör inte det. Utsikten är större än minnesmärket —
    // vikten är redan svaret på "hur mycket är det värt att se", ingen egen skala behövs.
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      SEV_MINZOOM, ['+', 3, ['*', 2, ['get', 'vikt']]],
      12, ['+', 4.5, ['*', 3, ['get', 'vikt']]],
      16, ['+', 6, ['*', 4, ['get', 'vikt']]],
    ],
    'circle-color': ['get', 'färg'],
    // De lätta sevärdheterna tonas in först när kartan är nära nog att bära dem.
    'circle-opacity': [
      'interpolate', ['linear'], ['zoom'],
      SEV_MINZOOM, ['case', ['>=', ['get', 'vikt'], TUNG_NOG], 0.95, 0],
      ALLA_FRÅN_ZOOM, 0.95,
    ],
    'circle-stroke-width': [
      'interpolate', ['linear'], ['zoom'],
      SEV_MINZOOM, ['case', ['>=', ['get', 'vikt'], TUNG_NOG], 2, 0],
      ALLA_FRÅN_ZOOM, 2,
    ],
    'circle-stroke-color': ringfärg(tema),
    'circle-stroke-opacity': 1,
  },
});

/**
 * En namntagg BREDVID pricken. `tung` styr både vilka sevärdheter lagret ritar och hur
 * tidigt: de tunga (utsikt, runsten, reservat …) får sitt namn redan i planeringsöversikten,
 * de lätta först när man zoomat in så nära att kartan bär dem. Två lager i stället för ett,
 * för ett filter kan inte bero på zoomen — och ett osynligt namn tar ändå kollisionsplats
 * från ett synligt.
 *
 * Krockar två taggar vinner den tyngsta (`symbol-sort-key`), och den andra faller helt
 * (`text-optional` spelar ingen roll utan ikon i samma lager). Så blir det aldrig gröt:
 * tätheten begränsas av att texterna inte får överlappa.
 */
function namnLager(
  id: string, tema: 'ljust' | 'mörkt', minzoom: number, tung: boolean,
): SymbolLayerSpecification {
  return {
    id,
    type: 'symbol',
    source: KÄLLA_SEV,
    minzoom,
    filter: ['all',
      ['!=', ['get', 'namn'], ''],
      tung ? ['>=', ['get', 'vikt'], TUNG_NOG] : ['<', ['get', 'vikt'], TUNG_NOG],
    ],
    layout: {
      'text-field': ['get', 'namn'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 11, 15, 13],
      // Bredvid pricken, inte under: det läser som en tagg fäst vid markören.
      'text-anchor': 'left',
      'text-offset': [0.9, 0],
      'text-justify': 'left',
      'text-max-width': 8,
      'text-padding': 4,
      // Trängs det: den tyngsta sevärdheten behåller sitt namn. MapLibre sorterar stigande,
      // så vi vänder på vikten.
      'symbol-sort-key': ['-', 1, ['get', 'vikt']],
    },
    paint: {
      'text-color': ['get', 'färg'],
      'text-halo-color': ringfärg(tema),
      'text-halo-width': 1.8,
      'text-halo-blur': 0.4,
    },
  };
}

/**
 * Ett osynligt, större träffområde ovanpå prickarna.
 *
 * Prickarna är 2–5 px. Ett finger är inte 5 px. Utan den här lager landar trycket bredvid
 * och ingenting händer — och en funktion som kräver millimeterprecision i en bil är ingen
 * funktion. 16 px radie är ungefär en fingertopp. Helt genomskinlig: den syns aldrig, den
 * bara fångar trycket.
 */
const tryckLager = (): CircleLayerSpecification => ({
  id: LAGER_SEV_TRYCK,
  type: 'circle',
  source: KÄLLA_SEV,
  minzoom: SEV_MINZOOM,
  paint: { 'circle-radius': 16, 'circle-color': '#000', 'circle-opacity': 0 },
});

/** Lagren, en gång per stil. Anropas om vid temabyte — stilen tar med sig allt i graven. */
export function monteraSevärdheter(map: MapLibreMap, tema: 'ljust' | 'mörkt'): void {
  if (!map.getSource(KÄLLA_SEV)) {
    map.addSource(KÄLLA_SEV, { type: 'geojson', data: tillGeoJSON([]) });
  }
  if (!map.getLayer(LAGER_SEV_PRICK)) map.addLayer(prickLager(tema));
  // Tunga namn redan i planeringsöversikten (samma zoom som deras prickar), lätta först
  // när man zoomat in (zoom 13). Krockhanteringen håller översikten läsbar.
  if (!map.getLayer(LAGER_SEV_NAMN)) {
    map.addLayer(namnLager(LAGER_SEV_NAMN, tema, SEV_MINZOOM, true));
  }
  if (!map.getLayer(LAGER_SEV_NAMN_LATT)) {
    map.addLayer(namnLager(LAGER_SEV_NAMN_LATT, tema, 13, false));
  }
  if (!map.getLayer(LAGER_SEV_TRYCK)) map.addLayer(tryckLager());
}

/** En tryckt sevärdhet: precis det berättelsebladet behöver för att hämta sin text. */
export interface SevärdhetsTryck {
  readonly id: number;
  readonly namn: string;
  readonly kind: SightKind;
  readonly at: [number, number];
}

/**
 * Koppla trycket. Anropas EN gång; handlern filtreras på lagret vid varje event, så den
 * överlever att lagret rivs och byggs om vid ett temabyte.
 *
 * ⛔ Det här är den enda platsen appen reagerar på en sevärdhet, och den kräver ett tryck.
 *    Ingen automatik, ingen hovring, ingen närhet — doktrinen förbjuder appen att tala
 *    oombedd, och ett tryck är inte oombett. Det är en fråga.
 */
export function kopplaSevärdhetsTryck(
  map: MapLibreMap, vidTryck: (s: SevärdhetsTryck) => void,
): void {
  map.on('click', LAGER_SEV_TRYCK, (e) => {
    const f = e.features?.[0];
    if (!f || f.geometry.type !== 'Point') return;
    const p = f.properties as Egenskaper;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    vidTryck({ id: Number(p.id), namn: p.namn, kind: p.kind, at: [lon, lat] });
  });

  // Pekaren blir en hand över en prick — den lilla signalen att här går det att trycka.
  map.on('mouseenter', LAGER_SEV_TRYCK, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', LAGER_SEV_TRYCK, () => { map.getCanvas().style.cursor = ''; });
}

export function sättSevärdheter(map: MapLibreMap, sights: readonly Sight[]): void {
  const källa = map.getSource(KÄLLA_SEV) as GeoJSONSource | undefined;
  källa?.setData(tillGeoJSON(sights));
}

// ─── Den valda sevärdheten ──────────────────────────────────────────────────
//
// En guldring runt pricken man tryckt på. Utan den vet man inte VILKEN prick texten
// handlar om — det ligger tio naturreservat i en skärm, och de ser likadana ut.

const TOM: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: 'FeatureCollection', features: [] };

const ringLager = (): CircleLayerSpecification => ({
  id: LAGER_VALD,
  type: 'circle',
  source: KÄLLA_VALD,
  paint: {
    // Bara zoom — den valda punktens feature bär ingen vikt, och ringen ska ändå bara
    // omsluta pricken, inte tävla med den.
    'circle-radius': ['interpolate', ['linear'], ['zoom'], SEV_MINZOOM, 9, 16, 15],
    'circle-color': 'rgba(0,0,0,0)',       // ihålig — ringen får aldrig dölja pricken
    'circle-stroke-width': 2.5,
    'circle-stroke-color': GULD,
  },
});

/** Ringlagret. Ovanpå prickarna, under trycklagret så trycket fortfarande fångas. */
export function monteraVald(map: MapLibreMap): void {
  if (!map.getSource(KÄLLA_VALD)) {
    map.addSource(KÄLLA_VALD, { type: 'geojson', data: TOM });
  }
  if (!map.getLayer(LAGER_VALD)) {
    map.addLayer(ringLager(), map.getLayer(LAGER_SEV_TRYCK) ? LAGER_SEV_TRYCK : undefined);
  }
}

/** Markera en punkt, eller `null` för att sudda ringen. */
export function sättVald(map: MapLibreMap, at: readonly [number, number] | null): void {
  const källa = map.getSource(KÄLLA_VALD) as GeoJSONSource | undefined;
  källa?.setData(at
    ? { type: 'FeatureCollection', features: [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [at[0], at[1]] }, properties: {},
      }] }
    : TOM);
}
