/**
 * Var kartans bakgrund kommer ifrån.
 *
 * Vi håller källan bakom ett interface av samma skäl som ruttmotorn: den dag vi vill
 * kunna köra Sverige offline ur ett PMTiles-arkiv i telefonen ska INGEN annan fil
 * behöva ändras.
 */

/** Vektorkällans namn i vår stil. Byter man den byter man den i `style.mindful.json` med. */
export const KÄLLA = 'openmaptiles';

export interface TileSource {
  readonly name: string;

  /**
   * En färdig MapLibre-stil att falla tillbaka på om vår egen inte går att läsa.
   *
   * Vår egen stil (`style.mindful.json`) är produkten — motorvägen ska se trist ut och
   * grusvägen ska se inbjudande ut. Den här URL:en är bara fallskärmen: en karta som
   * ser fel ut är fortfarande bättre än ingen karta alls när man står vid en vägkorsning.
   */
  styleUrl(): string;

  /** TileJSON- eller tile-URL som vår egen stil pekar sin vektorkälla mot. */
  vectorUrl(): string;

  /** `glyphs` i stilen. Utan fonter renderas inga etiketter alls. */
  glyphsUrl(): string;
}

/** OpenFreeMap. Nyckellös, ingen kvot, inget konto. Därför är det den vi kör på. */
export class OpenFreeMapSource implements TileSource {
  readonly name = 'openfreemap';

  styleUrl(): string {
    return 'https://tiles.openfreemap.org/styles/positron';
  }

  vectorUrl(): string {
    return 'https://tiles.openfreemap.org/planet';
  }

  glyphsUrl(): string {
    return 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  }
}

/**
 * Sverige i en fil, på telefonen, utan nät. Stubbe.
 *
 * Vägen dit är kort men inte gratis: `pmtiles`-protokollet måste registreras hos
 * MapLibre innan en `pmtiles://`-URL betyder något, och arkivet (~1 GB) måste hämtas
 * och lagras med samma persistensgarantier som minnet. Det är ett eget beslut, inte en
 * detalj i kartlagret — så tills det är taget står den här klassen och pekar på ett
 * arkiv den inte kan öppna, och det ska den göra HÖGLJUTT.
 */
export class PMTilesSource implements TileSource {
  readonly name = 'pmtiles';

  constructor(private readonly arkiv: string) {}

  styleUrl(): string {
    throw new Error('PMTilesSource: ingen fallback-stil finns offline');
  }

  vectorUrl(): string {
    return `pmtiles://${this.arkiv}`;
  }

  glyphsUrl(): string {
    // Fonterna måste packas med arkivet; hämtas de över nätet är kartan inte offline.
    throw new Error('PMTilesSource: fonter måste packas med arkivet');
  }
}
