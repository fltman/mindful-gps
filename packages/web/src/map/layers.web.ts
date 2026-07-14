/**
 * Spindelnätet — allt du någonsin kört, ritat som guldtrådar.
 *
 * Två beslut som ser små ut och inte är det:
 *
 * 1. Vi ritar RÅSPÅREN som linjer, inte H3-cellerna som hexagoner. Hexagonerna är
 *    modellen, inte minnet. En hexagonmatta ser ut som ett spelbräde; en tråd ser ut
 *    som en resa. Den är dessutom billigare (ett par tusen punkter i stället för
 *    hundratusentals polygoner) och ÄRLIGARE — den visar var bilen faktiskt var, inte
 *    vilka 50-metersrutor vi råkade bokföra.
 *
 * 2. LJUSSTYRKAN ÄR RECENCY, med samma exponentialavtagande (TAU_DAYS) som
 *    `familiarity()` i core. Turen från förra veckan lyser; turen från 2023 glöder
 *    svagt. Det betyder att det man SER är exakt det planeraren RÄKNAR med — en väg
 *    som har bleknat på kartan är en väg som appen på riktigt börjat betrakta som ny
 *    igen. Modellen är UI:t.
 */

import { TAU_DAYS, type LngLat } from '@mindful/core';
import type { GeoJSONSource, LineLayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

import { GLÖD, GULD, TRÅD_MAX_LJUS, TRÅD_MIN_LJUS } from './palett.js';

export const KÄLLA_NÄT = 'nät';
export const LAGER_NÄT_GLÖD = 'nät-glöd';
export const LAGER_NÄT_TRÅD = 'nät-tråd';

/** En körd tur, redo att ritas. Råspåret avkodat, plus dagen den kördes. */
export interface WebThread {
  readonly id: string;
  readonly shape: readonly LngLat[];
  /** Dagar sedan EPOCH_DAY0. Samma tidsaxel som `VisitedCell.lastSeenDay`. */
  readonly lastSeenDay: number;
}

/**
 * Trådens ljusstyrka, 0..1.
 *
 * Samma `exp(-Δdagar / TAU_DAYS)` som familiaritetens recency-term, men golvad vid
 * TRÅD_MIN_LJUS: en gammal tur ska glöda, inte raderas. Vi minns att du var där även
 * när vi inte längre räknar det som "känt".
 */
export function trådLjus(lastSeenDay: number, today: number): number {
  const dagar = Math.max(0, today - lastSeenDay);
  const färskhet = Math.exp(-dagar / TAU_DAYS);
  return TRÅD_MIN_LJUS + (TRÅD_MAX_LJUS - TRÅD_MIN_LJUS) * färskhet;
}

export function nätGeoJSON(
  trådar: readonly WebThread[],
  today: number,
): GeoJSON.FeatureCollection<GeoJSON.LineString, { ljus: number }> {
  const features: Array<GeoJSON.Feature<GeoJSON.LineString, { ljus: number }>> = [];

  for (const t of trådar) {
    if (t.shape.length < 2) continue;   // en ensam punkt är ingen resa
    features.push({
      type: 'Feature',
      id: t.id,
      properties: { ljus: trådLjus(t.lastSeenDay, today) },
      geometry: {
        type: 'LineString',
        coordinates: t.shape.map((p) => [p[0], p[1]]),
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Glöd under, tråd över. Glöden är bred och suddig och gör att nätet läser som ETT
 * system på håll; tråden är tunn och skarp och gör att den läser som en VÄG nära.
 * Båda tar sin opacitet ur `ljus` — färgen skalar med minnet, inte med zoomen.
 */
export function nätLager(): LineLayerSpecification[] {
  return [
    {
      id: LAGER_NÄT_GLÖD,
      type: 'line',
      source: KÄLLA_NÄT,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': GLÖD,
        'line-blur': ['interpolate', ['linear'], ['zoom'], 6, 2, 14, 6],
        'line-opacity': ['*', ['get', 'ljus'], 0.30],
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 6, 3, 12, 7, 18, 16],
      },
    },
    {
      id: LAGER_NÄT_TRÅD,
      type: 'line',
      source: KÄLLA_NÄT,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': GULD,
        'line-opacity': ['get', 'ljus'],
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 6, 0.8, 12, 1.8, 18, 4.5],
      },
    },
  ];
}

/** Källa + de två lagren. Anropas en gång, när stilen är laddad. */
export function monteraNät(map: MapLibreMap): void {
  if (map.getSource(KÄLLA_NÄT)) return;

  map.addSource(KÄLLA_NÄT, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  for (const lager of nätLager()) map.addLayer(lager);
}

/** Byt ut hela nätet. Imperativt — inget React-träd får röras av det här. */
export function sättTrådar(
  map: MapLibreMap,
  trådar: readonly WebThread[],
  today: number,
): void {
  const källa = map.getSource<GeoJSONSource>(KÄLLA_NÄT);
  if (!källa) return;
  källa.setData(nätGeoJSON(trådar, today));
}
