/**
 * Färgerna. Ett ställe, för att guldet i spindelnätet, guldet i rutten och guldet i
 * den delade bilden är SAMMA guld — annars känns delningsbilden som en skärmdump av
 * något annat än appen.
 *
 * Kartans egna färger (bottnar, skog, vatten, vägar) bor i `style.mindful.json` och
 * `MÖRK_STIL` i `style.ts`. Här bor bara det vi ritar OVANPÅ kartan.
 */

/** Spårets kärna. Varm bärnsten, inte gul plast. */
export const GULD = '#f0b64c';

/** Glöden under kärnan. Bredare, mjukare, samma temperatur. */
export const GLÖD = '#ffd98a';

/** Den aktuella turens tråd. Ljusare än historiken — det här händer NU. */
export const LIVE = '#ffe4a3';

/** Rutten: den okända delen. Det är den man ska se. */
export const RUTT_NY = '#f0b64c';

/** Rutten: den redan körda delen. Grå, tunn, tyst. */
export const RUTT_KÖRD_LJUS = '#a8a196';
export const RUTT_KÖRD_MÖRK = '#5c554a';

/** Positionsprickens kärna och ring. */
export const POSITION = '#ffffff';
export const POSITION_RING = '#f0b64c';

/**
 * Svagaste och starkaste ljusstyrka för en tråd i spindelnätet.
 *
 * Botten är inte noll: en tur från 2019 ska fortfarande GLÖDA svagt. Det är skillnaden
 * mellan ett minne och en radering.
 */
export const TRÅD_MIN_LJUS = 0.12;
export const TRÅD_MAX_LJUS = 0.95;

/**
 * Sevärdheterna. Två familjer, inte tolv färger — en karta med tolv prickfärger är en
 * legend man måste lära sig, och den lär sig ingen i nittio i en kurva.
 */
/** Natur: utsikt, vattenfall, naturreservat. Dämpad grön, inte signalgrön. */
export const SEV_NATUR = '#5c7d52';
/** Spår efter människor: runsten, borg, kyrka, fornlämning. Bränd terrakotta. */
export const SEV_SPÅR = '#9c6b48';
/** Halon i mörkt läge — samma botten som kartan (BOTTEN.mörkt). */
export const SEV_MÖRK = '#191713';
