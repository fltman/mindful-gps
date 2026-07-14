/**
 * Familiaritetsmatten. CONTRACT §3.3 — FRUSEN.
 *
 * Egen fil av ett enda skäl: både nyhetsberäkningen (novelty.ts) och det förberäknade
 * grann-maxet i minnet (h3util.ts) måste räkna på EXAKT samma formel. Låg den kvar i
 * novelty.ts hade h3util behövt en egen kopia — två implementationer, två siffror.
 */

import { TAU_DAYS, VISIT_SATURATION } from './constants.js';
import type { VisitedCell } from './types.js';

/**
 * 0..1. Hur välbekant är en cell med `visits` besök, senast sedd dag `lastSeenDay`?
 *
 * Recency-decay är det som gör produkten meningsfull ÅR 2 i stället för att stelna.
 * En väg du körde en gång för tre år sedan ÄR i praktiken ny igen.
 */
export function familiarityOf(visits: number, lastSeenDay: number, today: number): number {
  const saturation = 1 - Math.exp(-VISIT_SATURATION * visits);
  // max(0, …): en cell får aldrig vara sedd i framtiden. Utan spärren skulle en klocka
  // som gått fel ge recency > 1 → familiarity > 1 → NEGATIV nyhet.
  const age = Math.max(0, today - lastSeenDay);
  const recency = Math.exp(-age / TAU_DAYS);
  return saturation * recency;
}

/** Kontraktets signatur. Samma tal som `familiarityOf`, med cellen som fasad. */
export function familiarity(c: VisitedCell, today: number): number {
  return familiarityOf(c.visits, c.lastSeenDay, today);
}

/**
 * Rangordningen mellan två celler — oberoende av vilken dag det är.
 *
 *     familiarity(c, today) = S(visits) · exp(lastSeenDay/τ) · exp(−today/τ)
 *
 * Den sista faktorn är gemensam för alla celler. VILKEN av två celler som är mest
 * välbekant beror alltså inte på `today` — bara på (visits, lastSeenDay). Det är hela
 * skälet till att grann-maxet kan avgöras EN gång, när cellen skrivs, i stället för
 * 1 200 gånger per kandidat i den heta loopen (se `VisitedIndex.strongNeighborOf`).
 *
 * Nyckeln väljer bara vinnaren. Själva VÄRDET räknas alltid med `familiarityOf` ovan,
 * så talet är bit-identiskt med den frusna formeln.
 *
 * Undantaget: en cell daterad i FRAMTIDEN får sin ålder klämd till 0 i `familiarityOf`,
 * medan nyckeln fortsätter räkna upp den. Det kräver en trasig klocka, och klient och
 * server ger fortfarande samma svar — de bygger indexet ur samma data.
 */
export function familiarityRank(visits: number, lastSeenDay: number): number {
  return (1 - Math.exp(-VISIT_SATURATION * visits)) * Math.exp(lastSeenDay / TAU_DAYS);
}
