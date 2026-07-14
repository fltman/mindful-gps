/**
 * Hexagonerna. BARA bakom `?debug=1`.
 *
 * Det här är hur minnet faktiskt ser ut inuti: res-11-celler, färgade efter
 * `familiarity()`. Det är oumbärligt när man ska förstå varför planeraren tycker att en
 * väg är känd — och det är fel bild att visa en människa som kör bil. Hexagoner ser ut
 * som ett spelbräde, och att göra minnet till ett bräde är att bjuda in till att fylla
 * i det. Vi bygger inte streaks.
 *
 * ⚠️ Undantag från h3util-regeln: kontraktet säger att bigint↔hex-kastningen bara sker i
 *    `core/h3util.ts`, och det gäller. Men core exponerar ingen `cellToBoundary`, och en
 *    hexagon utan geometri går inte att rita. Kastningen nedan är därför medveten,
 *    isolerad till den här filen, och lever bakom en debugflagga. Dagen `h3util` får en
 *    `cellBoundary()` ska den här filen använda den i stället.
 */

import { familiarityOf, type VisitedIndex } from '@mindful/core';
import { cellToBoundary } from 'h3-js';
import type { FillLayerSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

export const KÄLLA_HEX = 'hex-debug';
export const LAGER_HEX = 'hex-debug-fyll';

/**
 * Fler celler än så här ritar vi inte. Ett veteranminne är 178 000 hexagoner — de blir
 * varken läsbara eller renderbara, och en debugvy som hänger telefonen är ingen debugvy.
 */
const TAK = 20_000;

/** Är debugvyn påslagen? `?debug=1`, ingenting annat. */
export function debugPåslagen(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}

export function hexGeoJSON(
  mem: VisitedIndex,
  today: number,
): GeoJSON.FeatureCollection<GeoJSON.Polygon, { fam: number }> {
  const features: Array<GeoJSON.Feature<GeoJSON.Polygon, { fam: number }>> = [];

  for (const shard of mem.toShards()) {
    for (let i = 0; i < shard.h3.length && features.length < TAK; i++) {
      const h3 = shard.h3[i];
      if (h3 === undefined) continue;

      const visits = shard.visits[i] ?? 0;
      const dag = shard.lastSeenDay[i] ?? 0;
      const ring = cellToBoundary(h3.toString(16), true);

      features.push({
        type: 'Feature',
        properties: { fam: familiarityOf(visits, dag, today) },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

export function hexLager(): FillLayerSpecification[] {
  return [{
    id: LAGER_HEX,
    type: 'fill',
    source: KÄLLA_HEX,
    paint: {
      // Nytt = varmt, känt = kallt. Motsatt guldtrådarna, med flit: den här vyn visar
      // MINNET, inte belöningen, och ska inte gå att förväxla med den.
      'fill-color': ['interpolate', ['linear'], ['get', 'fam'],
        0, '#f0b64c',
        0.5, '#8fae7a',
        1, '#3f7fa8'],
      'fill-opacity': ['+', 0.15, ['*', ['get', 'fam'], 0.35]],
      'fill-outline-color': 'rgba(0,0,0,0.12)',
    },
  }];
}

export function monteraHex(map: MapLibreMap): void {
  if (map.getSource(KÄLLA_HEX)) return;

  map.addSource(KÄLLA_HEX, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  for (const lager of hexLager()) map.addLayer(lager);
}

export function sättHex(map: MapLibreMap, mem: VisitedIndex, today: number): void {
  const källa = map.getSource<GeoJSONSource>(KÄLLA_HEX);
  if (!källa) return;
  källa.setData(hexGeoJSON(mem, today));
}
