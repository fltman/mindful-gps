/**
 * Bilden man vill lägga upp.
 *
 * Ingen basemap. Inga vägar. Inga etiketter. Inget varumärke. Bara guldtrådarna på
 * genomskinlig botten — ett rotsystem, ett nervsystem, ett träd. Det ser ut som något
 * man har ODLAT, för det är det man har gjort.
 *
 * Att lyfta bort kartan är inte snålhet: med kartan under blir bilden ett skärmklipp av
 * en app, och ingen delar en app. Utan den blir den ett porträtt av ett år, och det gör
 * man gärna.
 *
 * Vi renderar i en egen, osynlig MapLibre-instans i stället för att läsa av den karta
 * användaren tittar på. Den karta man tittar på har basemap, är fel utsnitt, har fel
 * proportioner och är dessutom mitt i en biltur.
 */

import maplibregl from 'maplibre-gl';

import { monteraNät, sättTrådar, type WebThread } from './layers.web.js';

export interface DelaInställningar {
  /** Kvadratiskt som standard. Det är formatet trådarna vill ha. */
  readonly bredd?: number;
  readonly höjd?: number;
  /** Luft runt nätet, i pixlar. Trådar som tangerar kanten ser avklippta ut. */
  readonly marginal?: number;
}

function omslutande(trådar: readonly WebThread[]): maplibregl.LngLatBounds | null {
  let bounds: maplibregl.LngLatBounds | null = null;

  for (const t of trådar) {
    for (const p of t.shape) {
      if (bounds) bounds.extend([p[0], p[1]]);
      else bounds = new maplibregl.LngLatBounds([p[0], p[1]], [p[0], p[1]]);
    }
  }

  return bounds;
}

/** PNG med transparent bakgrund. Kastar om det inte finns någon körd meter att visa. */
export async function delaBild(
  trådar: readonly WebThread[],
  today: number,
  inst: DelaInställningar = {},
): Promise<Blob> {
  const bounds = omslutande(trådar);
  if (!bounds) throw new Error('Du har inte kört någonstans än.');

  const bredd = inst.bredd ?? 1080;
  const höjd = inst.höjd ?? 1080;

  const behållare = document.createElement('div');
  behållare.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${bredd}px;height:${höjd}px;pointer-events:none`;
  document.body.appendChild(behållare);

  // En stil utan `background`-lager: MapLibre rensar då till genomskinligt, och det är
  // hela poängen. Lägger någon till en botten här försvinner transparensen.
  const map = new maplibregl.Map({
    container: behållare,
    style: { version: 8, sources: {}, layers: [], glyphs: '' },
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    // Utan `preserveDrawingBuffer` är canvasen tom när vi läser av den: WebGL får
    // kasta bufferten så fort rutan är ritad, och det gör den.
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });

  try {
    await new Promise<void>((klar) => { map.once('load', () => klar()); });

    monteraNät(map);
    sättTrådar(map, trådar, today);

    map.fitBounds(bounds, {
      padding: inst.marginal ?? 64,
      animate: false,
      maxZoom: 14,
    });

    await new Promise<void>((klar) => { map.once('idle', () => klar()); });

    return await new Promise<Blob>((klar, fel) => {
      map.getCanvas().toBlob((blob) => {
        if (blob) klar(blob);
        else fel(new Error('Bilden gick inte att skapa.'));
      }, 'image/png');
    });
  } finally {
    map.remove();
    behållare.remove();
  }
}
