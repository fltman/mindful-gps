/**
 * Den aktuella turens tråd, och pricken som drar den.
 *
 * Det här är det enda i kartan som rör sig varje sekund, i två timmar. Därför lever det
 * helt utanför React: en ny GPS-fix leder aldrig till en render, bara till ett `setData`
 * på en GeoJSON-källa. Ett komponentträd som ritas om 7 200 gånger under en biltur är
 * inte en prestandafråga — det är en batterifråga, och batteriet är det som avgör om
 * appen finns kvar när man kommer fram.
 *
 * `setData` är dessutom throttlad till en animationsruta. Kommer fixarna tätare än
 * skärmen ritar om, hjälper det ingen att skicka in dem.
 */

import type { LngLat } from '@mindful/core';
import type {
  CircleLayerSpecification, GeoJSONSource, LineLayerSpecification, Map as MapLibreMap,
} from 'maplibre-gl';

import { GLÖD, LIVE, POSITION, POSITION_RING } from './palett.js';

export const KÄLLA_LIVE = 'live';
export const KÄLLA_POSITION = 'position';
export const LAGER_LIVE_GLÖD = 'live-glöd';
export const LAGER_LIVE_TRÅD = 'live-tråd';
export const LAGER_POSITION_RING = 'position-ring';
export const LAGER_POSITION_KÄRNA = 'position-kärna';

const tomLinje = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

export class LiveSpår {
  readonly #map: MapLibreMap;
  readonly #punkter: LngLat[] = [];
  #väntar = 0;

  constructor(map: MapLibreMap) {
    this.#map = map;
  }

  /** Källor och lager. Anropas när stilen laddat, en gång. */
  montera(): void {
    const map = this.#map;

    if (!map.getSource(KÄLLA_LIVE)) {
      map.addSource(KÄLLA_LIVE, { type: 'geojson', data: tomLinje() });
      for (const lager of this.#trådLager()) map.addLayer(lager);
    }

    if (!map.getSource(KÄLLA_POSITION)) {
      map.addSource(KÄLLA_POSITION, { type: 'geojson', data: tomLinje() });
      for (const lager of this.#positionLager()) map.addLayer(lager);
    }
  }

  get punkter(): readonly LngLat[] {
    return this.#punkter;
  }

  /** Ny tur. Tråden börjar om från ingenting. */
  nollställ(): void {
    this.#punkter.length = 0;
    this.#skriv();
  }

  /**
   * Ett steg till på tråden.
   *
   * Vi filtrerar inte här. Det som når hit har redan passerat GPS-loopens filter
   * (CONTRACT §3.4) — kartan är inte rätt ställe att ha en andra åsikt om vilka fixar
   * som duger.
   */
  läggTill(p: LngLat): void {
    this.#punkter.push(p);
    this.#planera();
  }

  /** Pricken. Ritas även när tråden är tom — man står stilla innan man kör. */
  sättPosition(p: LngLat, noggrannhetM?: number): void {
    const källa = this.#map.getSource<GeoJSONSource>(KÄLLA_POSITION);
    if (!källa) return;

    källa.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { noggrannhetM: noggrannhetM ?? 0 },
        geometry: { type: 'Point', coordinates: [p[0], p[1]] },
      }],
    });
  }

  /** Skriv senast en gång per animationsruta, hur ofta vi än blir anropade. */
  #planera(): void {
    if (this.#väntar !== 0) return;
    this.#väntar = requestAnimationFrame(() => {
      this.#väntar = 0;
      this.#skriv();
    });
  }

  #skriv(): void {
    const källa = this.#map.getSource<GeoJSONSource>(KÄLLA_LIVE);
    if (!källa) return;

    if (this.#punkter.length < 2) {
      källa.setData(tomLinje());
      return;
    }

    källa.setData({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: this.#punkter.map((p) => [p[0], p[1]]),
      },
    });
  }

  #trådLager(): LineLayerSpecification[] {
    return [
      {
        id: LAGER_LIVE_GLÖD,
        type: 'line',
        source: KÄLLA_LIVE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': GLÖD,
          'line-blur': 5,
          'line-opacity': 0.45,
          'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 8, 6, 14, 12, 18, 22],
        },
      },
      {
        id: LAGER_LIVE_TRÅD,
        type: 'line',
        source: KÄLLA_LIVE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': LIVE,
          'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 8, 1.8, 14, 3.6, 18, 7],
        },
      },
    ];
  }

  #positionLager(): CircleLayerSpecification[] {
    return [
      {
        id: LAGER_POSITION_RING,
        type: 'circle',
        source: KÄLLA_POSITION,
        paint: {
          'circle-color': POSITION_RING,
          'circle-opacity': 0.22,
          'circle-blur': 0.4,
          'circle-radius': 18,
        },
      },
      {
        id: LAGER_POSITION_KÄRNA,
        type: 'circle',
        source: KÄLLA_POSITION,
        paint: {
          'circle-color': POSITION,
          'circle-radius': 6,
          'circle-stroke-color': POSITION_RING,
          'circle-stroke-width': 2.5,
        },
      },
    ];
  }
}
