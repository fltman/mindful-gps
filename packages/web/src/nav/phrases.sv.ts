/**
 * Svenskan. CONTRACT §6.
 *
 * Motorns egen `engineText` används aldrig som röst — dess kadens är fel. Vi bygger
 * meningen själva, av manöver + avstånd + vägnamn, och tonen är lugn och kort. Appen
 * har aldrig bråttom och har aldrig rätt.
 *
 * ⛔ Frasen "gör en U-sväng när det är möjligt" finns inte här. En u-sväng är TYST
 *    (`curtPhrase` → null). Den enda gången motorn föreslår en är när vi redan avvikit,
 *    och då har föraren inte kört fel — hen har hittat en väg till.
 *
 * Distanserna här är RÖSTENS, inte skärmens: rösten säger "400 meter", skärmen skriver
 * "400 m" (`ui/format.ts`). Två olika medier, två olika kadenser — därför två funktioner.
 */

import type { Maneuver, ManeuverModifier } from '@mindful/core';

// ─── Ordförrådet ────────────────────────────────────────────────────────────

const RIKTNING: Record<ManeuverModifier, string> = {
  sharp_left: 'skarpt vänster',
  left: 'vänster',
  slight_left: 'svagt vänster',
  straight: 'rakt fram',
  slight_right: 'svagt höger',
  right: 'höger',
  sharp_right: 'skarpt höger',
};

const ORDNINGSTAL = [
  'första', 'andra', 'tredje', 'fjärde',
  'femte', 'sjätte', 'sjunde', 'åttonde',
] as const;

/** Grov sida. En avfart tas till höger — aldrig "till svagt höger". */
function side(mod: ManeuverModifier | undefined): string | null {
  if (!mod) return null;
  if (mod.endsWith('left')) return 'vänster';
  if (mod.endsWith('right')) return 'höger';
  return null;
}

/** Rondellens avfart som ord. Bortom åttonde blir det siffra igen — då är det ändå kaos. */
function exitOrdinal(n: number | undefined): string | null {
  if (n === undefined || n < 1) return null;
  return ORDNINGSTAL[n - 1] ?? `avfart ${n}`;
}

export function capitalize(s: string): string {
  const first = s.charAt(0);
  return first ? first.toLocaleUpperCase('sv-SE') + s.slice(1) : s;
}

// ─── Vägnamnet ──────────────────────────────────────────────────────────────

/** "E22". Mellanslag i OSM:s `ref` ("E 22") är vanligt och betyder ingenting. */
const EUROPAVAG = /^E\d+$/;
/**
 * Riksväg (1–2 siffror) och länsväg (3–4). Samma mall — "väg 27", "väg 641" — så de får
 * dela regex. Fem siffror är ingen svensk vägnummer och faller igenom till namnet.
 */
const NUMMERVAG = /^\d{1,4}$/;

/**
 * Vad vägen heter, i talad form. `null` = säg ingenting alls om vägen.
 *
 * Svenska riksvägar saknar oftast `name` och har bara `ref`. Läser man bara `streetName`
 * blir varannan instruktion namnlös; läser man bara `streetRef` rått säger rösten "27".
 */
export function roadLabel(m: Maneuver): string | null {
  const ref = m.streetRef?.replace(/\s+/g, '').toUpperCase();
  if (ref) {
    if (EUROPAVAG.test(ref)) return ref;
    if (NUMMERVAG.test(ref)) return `väg ${ref}`;
  }
  // Ett ref vi inte känner igen ("27;E22", "Lv 641") säger vi hellre inget om än fel.
  const name = m.streetName?.trim();
  return name ? name : null;
}

// ─── Manövern ───────────────────────────────────────────────────────────────

/**
 * Kärnan i alla mallar. `label` skickas in i stället för att slås upp, så att den långa
 * formen ("sväng vänster på väg 27") och den korta ("sväng vänster") kommer ur EXAKT
 * samma switch. Två switchar hade betytt två toner.
 *
 * `null` = manövern är TYST. Se tystnadsdoktrinen: att köra rakt fram är ingen
 * instruktion, rondellens avfart är redan sagd vid infarten, och en u-sväng ber vi
 * aldrig om.
 */
function template(m: Maneuver, label: string | null): string | null {
  const dir = m.modifier ? RIKTNING[m.modifier] : null;
  const straight = m.modifier === 'straight' || dir === null;

  switch (m.type) {
    case 'depart':
      return label ? `kör ut på ${label}` : 'kör iväg';

    case 'turn':
      if (straight) return label ? `fortsätt på ${label}` : 'fortsätt rakt fram';
      return label ? `sväng ${dir} på ${label}` : `sväng ${dir}`;

    case 'fork': {
      const d = straight ? 'rakt fram' : dir;
      return label ? `håll ${d} i vägskälet, in på ${label}` : `håll ${d} i vägskälet`;
    }

    case 'merge':
      return label ? `kör in på ${label}` : 'kör in i trafiken';

    case 'exit': {
      if (label) return `ta avfarten mot ${label}`;
      const s = side(m.modifier);
      return s ? `ta avfarten till ${s}` : 'ta avfarten';
    }

    case 'roundabout_enter': {
      // Vägnamnet utelämnas MED FLIT, och det är inte en förenkling.
      //
      // Valhallas `street_names` på infarten är RONDELLENS eget namn, inte avfartens:
      // verifierat mot Växjö→Kalmar, där manövern bär "Fagrabäcksrondellen". "Ta andra
      // avfarten i rondellen, in på Fagrabäcksrondellen" är ren nonsens — man kör inte in
      // på en rondell man redan är i. Avfartsvägens namn sitter på `roundabout_exit`, och
      // den manövern är tyst (avfarten är redan sagd).
      //
      // Avfartsnumret ÄR instruktionen. Föraren behöver inte mer.
      const ord = exitOrdinal(m.roundaboutExit);
      return ord ? `ta ${ord} avfarten i rondellen` : 'kör in i rondellen';
    }

    case 'ferry':
      // Färjan är vacker. Den behöver inget vägnummer.
      return 'kör ombord på färjan';

    case 'arrive':
      return 'då är vi framme';

    case 'continue':
    case 'roundabout_exit':
    case 'uturn':
      return null;
  }
}

/** Hela manövern med vägnamn: "sväng vänster på väg 27". Används i den långa cuen. */
export function maneuverPhrase(m: Maneuver): string | null {
  return template(m, roadLabel(m));
}

/**
 * Manövern utan vägnamn: "sväng vänster". Används i svänglistan på skärmen, där
 * vägnamnet redan står bredvid.
 */
export function shortPhrase(m: Maneuver): string | null {
  return template(m, null);
}

/**
 * Det kortaste som fortfarande är en instruktion: "vänster", "tredje avfarten i
 * rondellen", "framme".
 *
 * Detta är vad rösten säger vid 40 m, när föraren redan ser korsningen och bara behöver
 * ett ord. Och det är svansen i en kedjad cue: "Vänster, sedan direkt höger."
 */
export function curtPhrase(m: Maneuver): string | null {
  const dir = m.modifier ? RIKTNING[m.modifier] : null;

  switch (m.type) {
    case 'depart':
      return 'kör iväg';
    case 'turn':
      return dir && dir !== 'rakt fram' ? dir : 'rakt fram';
    case 'fork':
      return `håll ${dir ?? 'rakt fram'}`;
    case 'merge':
      return 'kör in i trafiken';
    case 'exit': {
      const s = side(m.modifier);
      return s ? `avfarten till ${s}` : 'avfarten';
    }
    case 'roundabout_enter': {
      const ord = exitOrdinal(m.roundaboutExit);
      return ord ? `${ord} avfarten i rondellen` : 'in i rondellen';
    }
    case 'ferry':
      return 'kör ombord på färjan';
    case 'arrive':
      return 'framme';
    case 'continue':
    case 'roundabout_exit':
    case 'uturn':
      return null;
  }
}

/** Har manövern någon röst alls? Tysta manövrar får inga cues (schedule.ts). */
export function isSilent(m: Maneuver): boolean {
  return curtPhrase(m) === null;
}

// ─── Avståndet, talat ───────────────────────────────────────────────────────

const SV = 'sv-SE';

/**
 * "400 meter", "en kilometer", "1,5 kilometer".
 *
 * Rösten säger hela ord. "400 m" läses upp som "fyrahundra em" av vissa TTS-motorer,
 * och det är precis den sortens småstress produkten finns för att slippa.
 */
export function spokenDistance(meter: number): string {
  const m = Math.max(0, meter);

  if (m >= 1000) {
    const km = Math.round(m / 100) / 10;
    if (km === 1) return 'en kilometer';
    const tal = new Intl.NumberFormat(SV, { maximumFractionDigits: 1 }).format(km);
    return `${tal} kilometer`;
  }

  return `${Math.round(m / 10) * 10} meter`;
}

// ─── Meningarna ─────────────────────────────────────────────────────────────

/** Svansen i en kedjad cue. `chain` är manövern som kommer direkt efter denna. */
function chainTail(chain: Maneuver | null): string {
  if (!chain) return '';
  if (chain.type === 'arrive') return ', sedan är vi framme';
  const curt = curtPhrase(chain);
  return curt ? `, sedan direkt ${curt}` : '';
}

/** Enda cuen för avfärden, vid start: "Kör ut på väg 27." */
export function startText(m: Maneuver): string {
  return `${capitalize(maneuverPhrase(m) ?? 'kör iväg')}.`;
}

/**
 * Den långa cuen: "Om 400 meter, sväng vänster på väg 27, sedan direkt höger."
 * Här — och bara här — nämns vägnamnet. Vid 40 m ser föraren redan skylten.
 */
export function farText(m: Maneuver, chain: Maneuver | null, atDistanceM: number): string {
  const d = spokenDistance(atDistanceM);
  if (m.type === 'arrive') return `Om ${d} är vi framme.`;

  const phrase = maneuverPhrase(m);
  if (!phrase) return '';
  return `Om ${d}, ${phrase}${chainTail(chain)}.`;
}

/** Den korta cuen, vid 40 m: "Vänster." · "Vänster, sedan direkt höger." · "Framme." */
export function nowText(m: Maneuver, chain: Maneuver | null): string {
  if (m.type === 'arrive') return 'Framme.';

  const curt = curtPhrase(m);
  if (!curt) return '';
  return `${capitalize(curt)}${chainTail(chain)}.`;
}

// ─── Avvikelsen ─────────────────────────────────────────────────────────────

/**
 * Att köra av rutten är INTE ett fel. Har föraren svängt någon annanstans har hen inte
 * kört fel — hen har hittat en väg till. Rösten säger aldrig "vänd", aldrig "du har
 * lämnat rutten", och aldrig något om tid.
 *
 * Tre formuleringar, inte en. En avvikelse är vanlig i den här appen — den är själva
 * beteendet vi vill ha — och samma mening ordagrant sju gånger på en söndagstur blir
 * en jingel i stället för ett erkännande.
 */
const NY_VÄG = [
  'Fint val. Den där har du inte kört.',
  'Ny väg. Jag hänger med.',
  'Den här är ny för dig. Vi tar den.',
] as const;

/**
 * Vad rösten säger när vi räknat om.
 *
 * `null` = TYSTNAD, och det är det vanliga fallet. Kör föraren en väg hen redan kan
 * finns det ingenting att säga. Att inte gnälla betyder också att inte kommentera.
 *
 * @param nyVäg  Är vägen föraren valde okänd för hen?
 * @param antal  Hur många gånger vi redan sagt något om ny väg under den här färden.
 */
export function offRouteText(nyVäg: boolean, antal: number): string | null {
  if (!nyVäg) return null;
  const i = Math.max(0, Math.trunc(antal)) % NY_VÄG.length;
  return NY_VÄG[i] ?? null;
}
