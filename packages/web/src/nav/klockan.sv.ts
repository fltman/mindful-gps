/**
 * Ankomsten, sagd som en människa säger den.
 *
 *   Du är framme i Kalmar cirka kvart över sju.
 *
 * ⛔ Aldrig "19:17". ⛔ Aldrig en nedräkning. ⛔ Aldrig sekunder.
 *
 * Ett klockslag på minuten är ett löfte, och ett löfte är något man kan bryta. Säger
 * appen 19:17 har den fel klockan 19:19, och då sitter föraren och kör ikapp en siffra
 * en app hittade på. "Cirka kvart över sju" kan inte bli fel på samma sätt — den är redan
 * ungefärlig, och det är sanningen om en biltur.
 *
 * Kvarten är också det grövsta mått som fortfarande svarar på frågan man faktiskt ställer,
 * som är "hinner jag hem till maten", inte "hur många minuter".
 */

const KVART_MS = 15 * 60 * 1000;

/** Timmarna i ord. Index 0 är tolv — svenskan säger inte "noll". */
const TIMMAR = [
  'tolv', 'ett', 'två', 'tre', 'fyra', 'fem',
  'sex', 'sju', 'åtta', 'nio', 'tio', 'elva',
] as const;

/** 19 → "sju", 12 → "tolv", 0 → "tolv". Tolvtimmars, som i tal. */
function timme(h24: number): string {
  return TIMMAR[((h24 % 12) + 12) % 12] as string;
}

/**
 * "kvart över sju", "halv åtta", "kvart i åtta", "sju".
 *
 * Halv och kvart i pekar FRAMÅT mot nästa timme — "halv åtta" är 19:30, inte 20:30. Det
 * är den enda fällan i svensk klockan, och den är värd sin egen rad.
 */
export function klockslagIOrd(at: Date): string {
  const kvartar = Math.round(at.getTime() / KVART_MS);
  const rundad = new Date(kvartar * KVART_MS);

  const h = rundad.getHours();
  const m = rundad.getMinutes();

  switch (m) {
    case 15: return `kvart över ${timme(h)}`;
    case 30: return `halv ${timme(h + 1)}`;
    case 45: return `kvart i ${timme(h + 1)}`;
    default: return timme(h);
  }
}

/**
 * "Du är framme i Kalmar cirka kvart över sju."
 *
 * Utan mål — en slinga, ett utsvep — finns ingen ort att vara framme *i*, och meningen
 * blir "Du är framme cirka kvart över sju."
 */
export function ankomstMening(ankomst: Date, mål: string | null): string {
  const när = `cirka ${klockslagIOrd(ankomst)}`;
  return mål ? `Du är framme i ${mål} ${när}.` : `Du är framme ${när}.`;
}
