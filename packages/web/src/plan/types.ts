/**
 * Vad planeraren svarar. Spegling av serverns `PlanCandidate` — och inget mer.
 *
 * Klienten räknar INTE om talen. Nyheten planeraren optimerade mot och nyheten kortet
 * visar måste vara samma tal, och det enda sättet att garantera det är att inte ha två
 * räknare (CONTRACT, ingressen). Servern har redan kört @mindful/core på våra celler.
 */

import type { Route, Waypoint } from '@mindful/core';

export type PlanMode = 'ab' | 'loop' | 'explore';

export interface PlanRoute {
  readonly route: Route;
  /** "62 av 80 km är nya för dig". Aldrig procent. */
  readonly novelKm: number;
  readonly beauty: number;
  /** "2,1 km E4 gick tyvärr inte att undvika". Motorväg + trunk. */
  readonly motorwayKm: number;
  /** "Grus sista biten". */
  readonly gravelKm: number;
  readonly score: number;
  /** Baslinjen finns alltid kvar som "raka vägen", så att man kan jämföra. */
  readonly kind: 'baseline' | 'candidate';
  /**
   * De okända vägbitarna rutten tvingades genom. Tom för baslinjen.
   *
   * Fältet ser dekorativt ut och är det inte: det är vad en AVVIKELSE ärver. Svänger föraren
   * av räknar vi om rutten genom samma punkter, och turen behåller sin karaktär. Utan dem
   * blir första omruttningen "snabbaste vägen tillbaka" — och då är det här en vanlig GPS.
   */
  readonly through: readonly Waypoint[];
}
