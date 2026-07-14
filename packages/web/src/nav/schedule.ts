/**
 * Tystnadsdoktrinen. CONTRACT §6 — FRUSEN REGEL.
 *
 *   MAX TVÅ UTROP PER MANÖVER.
 *     "långt": vid 400 m (600 m om v > 22 m/s)
 *     "nu":    vid  40 m
 *
 * ⛔ Är det 18 km till nästa sväng säger appen INGENTING på 18 km. Det är hela produkten
 *    i ett designbeslut, och det är inte en frånvaro av funktion — det är funktionen.
 *
 * Kedjning: kommer nästa manöver närmare än 400 m efter denna slås de ihop till EN cue —
 * "Vänster, sedan direkt höger." — och den andra manövern tiger helt. Två utrop på tio
 * sekunder är precis den stress vi bygger bort.
 */

import type { Maneuver } from '@mindful/core';

import { farText, isSilent, nowText, startText } from './phrases.sv.js';

// ─── Frusna avstånd ─────────────────────────────────────────────────────────

/** Den långa cuen. */
export const FAR_M = 400;
/** Den långa cuen i landsvägsfart — vid 25 m/s är 400 m sexton sekunder. */
export const FAR_FAST_M = 600;
/** 22 m/s ≈ 79 km/h. */
export const FAST_MS = 22;
/** Den korta cuen. Här ser föraren redan korsningen. */
export const NOW_M = 40;
/** Nästa manöver närmare än så → EN gemensam cue. */
export const CHAIN_M = 400;

export function farDistanceM(speedMs: number): number {
  return speedMs > FAST_MS ? FAR_FAST_M : FAR_M;
}

// ─── Typerna ────────────────────────────────────────────────────────────────

/** CONTRACT §6. */
export interface VoiceCue {
  /** Avstånd till manövern då den ska sägas. */
  readonly atDistanceM: number;
  /** Svensk, färdig, HEL mening. Aldrig ett fragment som konkateneras. */
  readonly text: string;
}

/**
 * `start` sägs vid navigeringens början, oavsett avstånd. `långt` och `nu` sägs bara om
 * de blivit ARMERADE — se `CueQueue`.
 */
export type CueKind = 'start' | 'långt' | 'nu';

export interface ScheduledCue extends VoiceCue {
  readonly kind: CueKind;
  /** Index i `Route.maneuvers` — inte i den talbara delmängden. */
  readonly maneuverIndex: number;
  /** Sägs exakt en gång. */
  readonly id: string;
}

// ─── Bygget ─────────────────────────────────────────────────────────────────

/**
 * Kedjas `m` ihop med `next`?
 *
 * `Maneuver.distanceM` är manöverns EGEN benlängd, alltså avståndet från `m` fram till
 * nästa manöver (Valhallas `length`). Är det under 400 m hinner föraren inte höra två
 * utrop och agera på båda.
 *
 * Avfärden kedjar aldrig: gör den det tystas den första riktiga svängen, och den enda
 * cue som återstår ligger i backspegeln.
 */
export function chainsInto(m: Maneuver, next: Maneuver | null): boolean {
  return next !== null
    && m.type !== 'depart'
    && !isSilent(m)
    && !isSilent(next)
    && m.distanceM < CHAIN_M;
}

function build(
  m: Maneuver,
  chain: Maneuver | null,
  speedMs: number,
  index: number,
): ScheduledCue[] {
  if (isSilent(m)) return [];

  if (m.type === 'depart') {
    return [{
      kind: 'start',
      atDistanceM: 0,
      text: startText(m),
      maneuverIndex: index,
      id: `${index}:start`,
    }];
  }

  const far = farDistanceM(speedMs);
  return [
    {
      kind: 'långt',
      atDistanceM: far,
      text: farText(m, chain, far),
      maneuverIndex: index,
      id: `${index}:långt`,
    },
    {
      kind: 'nu',
      atDistanceM: NOW_M,
      text: nowText(m, chain),
      maneuverIndex: index,
      id: `${index}:nu`,
    },
  ];
}

/** CONTRACT §6. Max två cues, alltid. */
export function cuesFor(m: Maneuver, next: Maneuver | null, speedMs: number): VoiceCue[] {
  const chain = chainsInto(m, next) ? next : null;
  return build(m, chain, speedMs, 0).map(({ atDistanceM, text }) => ({ atDistanceM, text }));
}

/**
 * Hela ruttens cues, en gång vid start.
 *
 * Tysta manövrar (rakt fram, rondellens utfart, u-svängar) hoppas över helt — men deras
 * BENLÄNGD räknas ändå med i avståndet fram till nästa talbara manöver. Annars hade en
 * "fortsätt rakt fram" mitt emellan två svängar felaktigt sett ut som en kedjning.
 */
export function scheduleRoute(
  maneuvers: readonly Maneuver[],
  speedMs: number,
): ScheduledCue[] {
  // Handlingspunkten för manöver i, mätt i meter längs rutten.
  const atM = new Float64Array(maneuvers.length);
  for (let i = 1; i < maneuvers.length; i++) {
    atM[i] = (atM[i - 1] ?? 0) + (maneuvers[i - 1]?.distanceM ?? 0);
  }

  const talbara: number[] = [];
  for (let i = 0; i < maneuvers.length; i++) {
    const m = maneuvers[i];
    if (m && !isSilent(m)) talbara.push(i);
  }

  const cues: ScheduledCue[] = [];

  for (let k = 0; k < talbara.length; k++) {
    const i = talbara[k];
    const m = i === undefined ? undefined : maneuvers[i];
    if (i === undefined || !m) continue;

    const j = talbara[k + 1];
    const next = j === undefined ? null : maneuvers[j] ?? null;
    const gapM = j === undefined ? Infinity : (atM[j] ?? 0) - (atM[i] ?? 0);

    const chain = next !== null && m.type !== 'depart' && gapM < CHAIN_M ? next : null;
    cues.push(...build(m, chain, speedMs, i));

    // Den kedjade manövern är redan sagd. Den får inte öppna munnen igen.
    if (chain) k++;
  }

  return cues;
}

// ─── Uppspelningen ──────────────────────────────────────────────────────────

/**
 * Vad som ska sägas just nu — och ingenting annat.
 *
 * ARMERING: en cue sägs bara om vi någon gång VARIT längre bort än dess avstånd. Startar
 * navigeringen 150 m från en sväng vore "Om 400 meter, sväng vänster" en lögn, och en
 * GPS som ljuger om avstånd är precis den vi inte bygger. Då säger vi bara "Vänster."
 *
 * Kommer båda cuerna på samma fix (svag GPS, hög fart) sägs BARA den närmaste. Två utrop
 * i rad är vad doktrinen förbjuder.
 */
export class CueQueue {
  readonly #cues: readonly ScheduledCue[];
  #spoken = new Set<string>();
  #armed = new Set<string>();
  #started = false;

  constructor(cues: readonly ScheduledCue[]) {
    this.#cues = cues;
  }

  /**
   * @param maneuverIndex Nästa manöver att utföra (från `Follower`).
   * @param toManeuverM   Avstånd dit, längs rutten.
   */
  due(maneuverIndex: number, toManeuverM: number): ScheduledCue[] {
    const ut: ScheduledCue[] = [];

    if (!this.#started) {
      this.#started = true;
      for (const c of this.#cues) {
        if (c.kind === 'start' && !this.#spoken.has(c.id)) {
          this.#spoken.add(c.id);
          ut.push(c);
        }
      }
    }

    const aktuella: ScheduledCue[] = [];

    for (const c of this.#cues) {
      if (c.kind === 'start' || this.#spoken.has(c.id)) continue;

      // En passerad manöver sägs aldrig i efterhand. Den är redan körd.
      if (c.maneuverIndex < maneuverIndex) {
        this.#spoken.add(c.id);
        continue;
      }
      if (c.maneuverIndex > maneuverIndex) continue;

      if (toManeuverM > c.atDistanceM) {
        this.#armed.add(c.id);
        continue;
      }
      if (this.#armed.has(c.id)) aktuella.push(c);
    }

    if (aktuella.length > 0) {
      aktuella.sort((a, b) => a.atDistanceM - b.atDistanceM);
      for (const c of aktuella) this.#spoken.add(c.id);
      const närmast = aktuella[0];
      if (närmast) ut.push(närmast);
    }

    return ut;
  }

  /** Ny rutt, ny tystnad. */
  reset(): void {
    this.#spoken = new Set();
    this.#armed = new Set();
    this.#started = false;
  }
}
