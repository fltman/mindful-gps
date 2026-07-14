/**
 * Rutten, splittad i två.
 *
 * En vanlig GPS ritar en enda blå orm och skriver siffrorna bredvid. Vi ritar i stället
 * rutten i två färger: det du redan kört är grått och tunt, det du aldrig kört är varmt
 * och tjockt och lysande. "62 av 80 km är nya för dig" står fortfarande i UI:t — men man
 * ska kunna se det utan att läsa det.
 *
 * Klassningen görs med SAMMA `cellNovelty()` som planeraren optimerade mot. Ritade vi
 * med någon egen tumregel skulle bilden och siffran kunna säga olika saker, och då hade
 * användaren haft rätt i att lita på ingen av dem.
 */

import {
  H3_RES, cell, cellNovelty, decode6,
  type LngLat, type Route, type VisitedIndex,
} from '@mindful/core';
import type { GeoJSONSource, LineLayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

import { RUTT_KÖRD_LJUS, RUTT_KÖRD_MÖRK, RUTT_NY } from './palett.js';
import type { Tema } from './style.js';

export const KÄLLA_RUTT = 'rutt';
export const LAGER_RUTT_KÖRD = 'rutt-körd';
export const LAGER_RUTT_NY = 'rutt-ny';

/**
 * Under den här nyheten kallar vi biten "körd".
 *
 * 0,5 och inte 0,6 (NOVELTY_ANCHOR_MIN): ankartröskeln avgör vad vi VÄLJER att köra
 * genom och ska vara kräsen. Det här avgör bara vilken färg en meter väg får, och där
 * är det ärligare att låta hälften avgöra — en cell som är precis lika mycket känd som
 * okänd ska inte målas guld.
 */
const KÄND_TRÖSKEL = 0.5;

interface Bit {
  readonly känd: boolean;
  readonly punkter: LngLat[];
}

/**
 * Dela rutten vid varje övergång mellan känt och okänt.
 *
 * Skarvpunkten hamnar i BÅDA bitarna. Annars uppstår ett hål på en bildskärmspixel i
 * varje övergång, och en rutt med tjugo övergångar ser trasig ut.
 */
export function delaRutt(shape: readonly LngLat[], mem: VisitedIndex, today: number): Bit[] {
  const bitar: Bit[] = [];
  let aktuell: Bit | undefined;

  for (const p of shape) {
    const känd = cellNovelty(cell(p, H3_RES), mem, today) < KÄND_TRÖSKEL;

    if (aktuell === undefined || aktuell.känd !== känd) {
      const förra = aktuell?.punkter.at(-1);
      aktuell = { känd, punkter: förra ? [förra, p] : [p] };
      bitar.push(aktuell);
    } else {
      aktuell.punkter.push(p);
    }
  }

  return bitar.filter((b) => b.punkter.length >= 2);
}

export function ruttGeoJSON(
  route: Route,
  mem: VisitedIndex,
  today: number,
): GeoJSON.FeatureCollection<GeoJSON.LineString, { känd: boolean }> {
  const bitar = delaRutt(decode6(route.geometry), mem, today);

  return {
    type: 'FeatureCollection',
    features: bitar.map((b) => ({
      type: 'Feature',
      properties: { känd: b.känd },
      geometry: {
        type: 'LineString',
        coordinates: b.punkter.map((p) => [p[0], p[1]]),
      },
    })),
  };
}

export function ruttLager(tema: Tema): LineLayerSpecification[] {
  return [
    {
      id: LAGER_RUTT_KÖRD,
      type: 'line',
      source: KÄLLA_RUTT,
      filter: ['==', ['get', 'känd'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': tema === 'mörkt' ? RUTT_KÖRD_MÖRK : RUTT_KÖRD_LJUS,
        'line-opacity': 0.75,
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 8, 1.6, 14, 3.5, 18, 6],
      },
    },
    {
      id: LAGER_RUTT_NY,
      type: 'line',
      source: KÄLLA_RUTT,
      filter: ['==', ['get', 'känd'], false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': RUTT_NY,
        'line-blur': 0.4,
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 8, 3.2, 14, 7, 18, 12],
      },
    },
  ];
}

export function monteraRutt(map: MapLibreMap, tema: Tema): void {
  if (map.getSource(KÄLLA_RUTT)) return;

  map.addSource(KÄLLA_RUTT, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  for (const lager of ruttLager(tema)) map.addLayer(lager);
}

/** `null` tar bort rutten. Ingen rutt är ett fullt giltigt tillstånd — man får köra fritt. */
export function sättRutt(
  map: MapLibreMap,
  route: Route | null,
  mem: VisitedIndex,
  today: number,
): void {
  const källa = map.getSource<GeoJSONSource>(KÄLLA_RUTT);
  if (!källa) return;

  källa.setData(route
    ? ruttGeoJSON(route, mem, today)
    : { type: 'FeatureCollection', features: [] });
}
