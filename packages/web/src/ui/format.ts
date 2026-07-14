/**
 * Talen som användaren läser. Aldrig procent, aldrig sekunder, aldrig "du sparar fyra minuter".
 *
 * Enligt CONTRACT.md är alla distanser i meter och alla tider i sekunder ända fram hit.
 * Konverteringen till något en människa kan läsa sker på exakt ett ställe: här.
 */

const SV = 'sv-SE';

/** Under en kilometer avrundas till närmaste tiotal meter — GPS:en är ändå inte bättre. */
export function formatKm(meter: number): string {
  const m = Math.max(0, meter);
  const tiotal = Math.round(m / 10) * 10;
  if (tiotal < 1000) return `${tiotal} m`;

  const km = m / 1000;
  // Decimalen avgörs efter avrundningen, annars blir 9 950 m till "10,0 km".
  const decimaler = Math.round(km * 10) / 10 < 10 ? 1 : 0;
  const tal = new Intl.NumberFormat(SV, {
    minimumFractionDigits: decimaler,
    maximumFractionDigits: decimaler,
  }).format(km);
  return `${tal} km`;
}

/** "1 h 17 min". Sekunder visas aldrig — de finns bara för att räkna med. */
export function formatDuration(sekunder: number): string {
  const minuter = Math.round(Math.max(0, sekunder) / 60);
  if (minuter < 1) return 'under en minut';

  const timmar = Math.floor(minuter / 60);
  const rest = minuter % 60;
  if (timmar === 0) return `${rest} min`;
  if (rest === 0) return `${timmar} h`;
  return `${timmar} h ${rest} min`;
}

/** Skärmarna får kilometer från storen, men formatKm talar meter. Här är bron. */
export const kmTillMeter = (km: number): number => km * 1000;
