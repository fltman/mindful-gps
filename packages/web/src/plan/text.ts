/**
 * Meningarna på kortet.
 *
 * Fyra rader, i den ordningen, och de tre sista bara när de har något att säga:
 *
 *   62 av 80 km är nya för dig
 *   1 h 40 min — 25 min längre än snabbaste vägen
 *   2,1 km E4 gick tyvärr inte att undvika
 *   Grus sista biten
 *
 * ⛔ Ingen procent. ⛔ Inget "du sparar". ⛔ Ingen tid i sekunder.
 *    En app som säger "78 % nytt" har gjort din eftermiddag till ett mätvärde.
 *
 * Talen kommer FÄRDIGA från planeraren. Vi räknar inte om dem här — den som räknar om
 * ett tal får förr eller senare ett annat tal, och då tror användaren på ingen av oss.
 */

import type { RoadClass, Route, Span, Surface } from '@mindful/core';

import { roadLabel } from '../nav/index.js';
import { formatDuration, formatKm, kmTillMeter } from '../ui/index.js';

import type { PlanRoute } from './types.js';

/** Under hundra meter ny väg är ingen nyhet. */
const NYHET_MIN_KM = 0.1;

/** Under hundra meter motorväg är det en trafikplats, inte en motorvägssträcka. */
const MOTORVÄG_MIN_KM = 0.1;

/** Under trehundra meter grus är det en infart. */
const GRUS_MIN_KM = 0.3;

/** Ligger allt grus inom sista femtedelen är det "sista biten". */
const SISTA_BITEN = 0.2;

const STORA_VÄGAR: readonly RoadClass[] = ['motorway', 'trunk'];
const OBELAGT: readonly Surface[] = ['gravel', 'dirt'];

/**
 * "62" ur "62 km".
 *
 * Vi klipper `formatKm`s egen utdata i stället för att formatera om talet. Det ser
 * omständligt ut, och det är poängen: avrundningen sker då på exakt ett ställe, och
 * "62 av 80 km" kan aldrig visa ett annat 62 än det "62 km" hade visat.
 */
const utanEnhet = (meter: number): string => formatKm(meter).replace(/\s*km$/u, '');

/** "62 av 80 km är nya för dig". */
export function nyhetsrad(k: PlanRoute): string {
  const nyaM = kmTillMeter(Math.min(k.novelKm, k.route.distanceM / 1000));
  const helaM = k.route.distanceM;

  if (k.novelKm < NYHET_MIN_KM) return 'Den här vägen känner du redan';

  // Bara när båda talen bär samma enhet går de att slå ihop. "300 m av 80 km" skulle
  // annars bli "300 av 80 km", och det är fel med bred marginal.
  const sammaEnhet = nyaM >= 1000 && helaM >= 1000;
  return sammaEnhet
    ? `${utanEnhet(nyaM)} av ${formatKm(helaM)} är nya för dig`
    : `${formatKm(nyaM)} av ${formatKm(helaM)} är nya för dig`;
}

/**
 * "1 h 40 min — 25 min längre än utan omvägar".
 *
 * ⛔ Baslinjen är INTE "snabbaste vägen". Den är den här ruttens egen raka väg: samma
 *    MINDFUL-preferenser, samma motorvägsflykt, bara utan de påtvingade omvägarna. Den
 *    snabbaste vägen Växjö → Kalmar är E22 på 77 minuter, och baslinjen tar 120.
 *
 *    Att kalla baslinjen "snabbaste vägen" gjorde en 44 minuter lång omväg till en tio
 *    minuter lång. Det är en lögn, och den upptäcker användaren första gången hen har en
 *    vanlig GPS i samma bil.
 *
 *    Och vi rättar det inte genom att skriva ut motorvägens tid i stället. Appen håller
 *    aldrig upp E22:ans 77 minuter mot dig — det vore precis den brådska den finns för
 *    att slippa. Vi jämför med den väg vi själva hade tagit, och säger vad den heter.
 */
export function tidsrad(k: PlanRoute, baslinje: PlanRoute | undefined): string {
  const tid = formatDuration(k.route.timeS);

  // En slinga och ett utsvep har ingen baslinje, och kan inte ha en: det finns ingen
  // "raka vägen" hem till sig själv. Då står tiden ensam. "utan omvägar" om en slinga vore
  // rent nonsens — hela turen ÄR en omväg, det är det som är beställningen.
  if (!baslinje) return tid;
  if (k.kind === 'baseline') return `${tid} — utan omvägar`;

  const längre = Math.round((k.route.timeS - baslinje.route.timeS) / 60);
  if (längre < 1) return `${tid} — lika kort som utan omvägar`;
  return `${tid} — ${längre} min längre än utan omvägar`;
}

/** "2,1 km E4 gick tyvärr inte att undvika". `null` när det inte finns något att säga. */
export function motorvägsrad(k: PlanRoute): string | null {
  if (k.motorwayKm < MOTORVÄG_MIN_KM) return null;

  const namn = störstaVägnamn(k.route);
  const km = formatKm(kmTillMeter(k.motorwayKm));
  return namn
    ? `${km} ${namn} gick tyvärr inte att undvika`
    : `${km} motorväg gick tyvärr inte att undvika`;
}

/** "Grus sista biten". `null` när vägen är belagd hela vägen. */
export function grusrad(k: PlanRoute): string | null {
  if (k.gravelKm < GRUS_MIN_KM) return null;

  const spann = (k.route.surfaceSpans ?? []).filter((s) => OBELAGT.includes(s.value));
  const slut = sistaIndex(k.route);

  if (spann.length > 0 && slut > 0) {
    const första = Math.min(...spann.map((s) => s.fromIdx));
    const sista = Math.max(...spann.map((s) => s.toIdx));

    if (första >= slut * (1 - SISTA_BITEN)) return 'Grus sista biten';
    if (sista <= slut * SISTA_BITEN) return 'Grus första biten';
  }

  return `Grus på ${formatKm(kmTillMeter(k.gravelKm))} av vägen`;
}

// ─── Vägnamnet ──────────────────────────────────────────────────────────────

/**
 * Namnet på den stora vägen rutten inte kom undan.
 *
 * Motorvägsspannen bär bara vägKLASS; namnet ("E4") bor i manövrarna. Vi lägger ihop
 * sträckan per namn över de manövrar som överlappar ett motorvägs- eller trunk-spann,
 * och tar det längsta. Två kilometer E4 och trehundra meter riksväg 25 ska bli "E4".
 *
 * `roadLabel` är navigeringens — samma regel för "väg 27" och "E22" i rösten som på
 * kortet. Två regler hade blivit två sätt att kalla samma väg.
 */
function störstaVägnamn(r: Route): string | null {
  const spann = (r.roadClassSpans ?? []).filter((s) => STORA_VÄGAR.includes(s.value));
  if (spann.length === 0) return null;

  const meterPerNamn = new Map<string, number>();

  for (const m of r.maneuvers) {
    const [start, slut] = m.shapeIndex;
    if (!spann.some((s) => överlappar(start, slut, s))) continue;

    const namn = roadLabel(m);
    if (!namn) continue;
    meterPerNamn.set(namn, (meterPerNamn.get(namn) ?? 0) + m.distanceM);
  }

  let bäst: string | null = null;
  let mest = 0;
  for (const [namn, meter] of meterPerNamn) {
    if (meter > mest) {
      mest = meter;
      bäst = namn;
    }
  }
  return bäst;
}

const överlappar = (start: number, slut: number, s: Span<RoadClass>): boolean =>
  start < s.toIdx && slut > s.fromIdx;

/** Sista nodindexet rutten talar om. Noll om motorn inte gav oss några spann. */
function sistaIndex(r: Route): number {
  let sist = 0;
  for (const s of r.roadClassSpans ?? []) sist = Math.max(sist, s.toIdx);
  for (const s of r.surfaceSpans ?? []) sist = Math.max(sist, s.toIdx);
  for (const m of r.maneuvers) sist = Math.max(sist, m.shapeIndex[1]);
  return sist;
}
