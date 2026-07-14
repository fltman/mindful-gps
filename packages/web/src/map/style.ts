/**
 * Stilen — en produktfunktion, inte dekoration.
 *
 * `style.mindful.json` är det ljusa läget och sanningen: bredder, filter, zoomtrappor.
 * Mörkt läge är SAMMA stil med andra färger. Att ha två fulla stilar hade betytt att
 * en breddändring gjord klockan elva på kvällen bara syns i ett av dem.
 */

import type { StyleSpecification } from 'maplibre-gl';

import { KÄLLA, type TileSource } from './TileSource.js';
import ljusStil from './style.mindful.json';

export type Tema = 'ljust' | 'mörkt';

/** Bakgrundsfärgen bakom kartan (splash, canvas-clear, safe-area). */
export const BOTTEN: Readonly<Record<Tema, string>> = {
  ljust: '#f7f2e7',
  mörkt: '#191713',
};

/** Bara de paint-egenskaper som byter värde i mörkt läge. Resten ärvs från JSON:en. */
type Färgpatch = Readonly<Record<string, string>>;

const MÖRK: Readonly<Record<string, Färgpatch>> = {
  'botten':          { 'background-color': BOTTEN.mörkt },
  'mark-åker':       { 'fill-color': '#221f18' },
  'mark-äng':        { 'fill-color': '#25291b' },
  'mark-skog':       { 'fill-color': '#233020' },
  'mark-park':       { 'fill-color': '#243020' },
  'vatten':          { 'fill-color': '#15252c' },
  'vattendrag':      { 'line-color': '#1b3038' },

  // Motorvägen försvinner nästan helt i mörkret. Det är avsiktligt.
  'väg-motorväg':    { 'line-color': '#2b2823' },
  'väg-riksväg':     { 'line-color': '#332e27' },
  'väg-sekundär':    { 'line-color': '#3d3529' },

  // Småvägarna glöder svagt varmt — det är dem man vill följa.
  'väg-liten-kant':  { 'line-color': '#2b2419' },
  'väg-liten':       { 'line-color': '#5a4b32' },
  'väg-grus':        { 'line-color': '#52432c' },
  'väg-färja':       { 'line-color': '#3f6c78' },

  'etikett-väg':     { 'text-color': '#8a7f6b', 'text-halo-color': BOTTEN.mörkt },
  'etikett-ort':     { 'text-color': '#95897a', 'text-halo-color': BOTTEN.mörkt },
  'etikett-vatten':  { 'text-color': '#5d8894', 'text-halo-color': BOTTEN.mörkt },
};

/** Stilens lager, sedda genom det enda fönster den här filen behöver. */
interface Lager {
  readonly id: string;
  paint?: Record<string, unknown>;
}

/**
 * Vår stil, kopplad till en tile-källa och ett tema.
 *
 * Kopian är djup, och det är inte försiktighet: MapLibre MUTERAR stilobjektet den får,
 * och en JSON-import är samma objekt vid varje anrop. Utan kopian hade det andra
 * temabytet fått en stil som redan var tuggad av det första.
 */
export function buildStyle(source: TileSource, tema: Tema): StyleSpecification {
  const stil = structuredClone(ljusStil) as unknown as StyleSpecification;

  const vektor = stil.sources[KÄLLA];
  if (vektor === undefined || vektor.type !== 'vector') {
    throw new Error(`style.mindful.json saknar vektorkällan '${KÄLLA}'`);
  }
  vektor.url = source.vectorUrl();
  stil.glyphs = source.glyphsUrl();

  if (tema === 'mörkt') {
    for (const lager of stil.layers as unknown as Lager[]) {
      const patch = MÖRK[lager.id];
      if (patch) lager.paint = { ...lager.paint, ...patch };
    }
  }

  return stil;
}
