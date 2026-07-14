/**
 * Var på rutten är vi?
 *
 * Projicerar GPS-fixen på ruttens polyline och svarar på tre frågor: hur långt till nästa
 * manöver, hur mycket är kvar, och är vi av rutten.
 *
 * ⚡ GLIDANDE FÖNSTER. En 100 km-rutt har ~10 000 noder. Att söka igenom alla varje
 *    sekund är 10 000 haversine per fix i en app som ska kunna gå i timmar på en telefon
 *    i en varm bilhållare. Vi söker i stället i ett fönster runt förra träffen: O(k).
 *    Bara när vi tappat rutten helt (> REACQUIRE_M) görs en full sökning — och då är den
 *    värd sitt pris, för då letar vi efter vägen tillbaka.
 *
 * All geometri kommer ur @mindful/core. Ingen matte dupliceras här.
 */

import {
  clamp01, decode6, haversine, projectOnPolyline,
  type LngLat, type Maneuver, type Route,
} from '@mindful/core';

/** Bakåt i fönstret: GPS-brus kan lägga fixen någon nod bakom oss. */
export const WINDOW_BACK_M = 100;
/** Framåt: ett tapp på tio sekunder i 110 km/h är 300 m. Marginalen är billig. */
export const WINDOW_FWD_M = 600;
/** Längre bort än så från fönstret → vi har tappat rutten. Sök om hela. */
export const REACQUIRE_M = 150;

/** Rutten, förberedd en gång. Att avkoda polylinen per fix vore rent slöseri. */
export interface FollowedRoute {
  readonly shape: readonly LngLat[];
  /** Meter längs rutten fram till nod i. Monotont växande. */
  readonly cumM: Float64Array;
  readonly maneuvers: readonly Maneuver[];
  /** Manöverns handlingspunkt, meter längs rutten. Sorterad. */
  readonly maneuverAtM: Float64Array;
  /** Sekunder fram till manöverns handlingspunkt, enligt motorns egen tidsuppskattning. */
  readonly maneuverAtS: Float64Array;
  readonly distanceM: number;
  readonly timeS: number;
}

export interface FollowState {
  /** Fixen projicerad på rutten — det är den vi ritar bilen på. */
  readonly at: LngLat;
  readonly alongM: number;
  /** Vinkelrätt avstånd från fixen till rutten. */
  readonly offRouteM: number;
  /** Nästa manöver att utföra. Index i `maneuvers`. */
  readonly maneuverIndex: number;
  readonly toManeuverM: number;
  readonly remainingM: number;
  readonly remainingS: number;
}

export function prepare(route: Route): FollowedRoute {
  const shape = decode6(route.geometry);

  const cumM = new Float64Array(shape.length);
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1];
    const b = shape[i];
    cumM[i] = (cumM[i - 1] ?? 0) + (a && b ? haversine(a, b) : 0);
  }

  const n = route.maneuvers.length;
  const maneuverAtM = new Float64Array(n);
  const maneuverAtS = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const m = route.maneuvers[i];
    if (!m) continue;
    // Formindexet är sanningen om VAR manövern sker; benlängderna är motorns avrundade
    // summor. Blandar man dem glider handlingspunkten några meter per manöver.
    const idx = Math.min(Math.max(m.shapeIndex[0], 0), shape.length - 1);
    maneuverAtM[i] = cumM[idx] ?? 0;
    if (i > 0) {
      maneuverAtS[i] = (maneuverAtS[i - 1] ?? 0) + (route.maneuvers[i - 1]?.timeS ?? 0);
    }
  }

  return {
    shape,
    cumM,
    maneuvers: route.maneuvers,
    maneuverAtM,
    maneuverAtS,
    distanceM: route.distanceM,
    timeS: route.timeS,
  };
}

/** Första manövern som ligger framför oss. Binärsökning — listan är sorterad. */
function nextManeuverIndex(atM: Float64Array, alongM: number): number {
  let lo = 0;
  let hi = atM.length - 1;
  if (hi < 0) return 0;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((atM[mid] ?? 0) > alongM) hi = mid;
    else lo = mid + 1;
  }
  // Är allt passerat pekar vi på den sista manövern — `arrive`. Vi är framme.
  return (atM[lo] ?? 0) > alongM ? lo : atM.length - 1;
}

export class Follower {
  readonly #r: FollowedRoute;
  #along = 0;
  #primed = false;

  constructor(route: FollowedRoute) {
    this.#r = route;
  }

  update(p: LngLat): FollowState {
    const { shape, cumM } = this.#r;
    const n = shape.length;

    let lo = 0;
    let hi = n - 1;

    if (this.#primed) {
      lo = this.#nodeBefore(this.#along - WINDOW_BACK_M);
      hi = this.#nodeAfter(this.#along + WINDOW_FWD_M);
    }

    const window = shape.slice(lo, hi + 1);
    let pr = projectOnPolyline(p, window);
    let alongM = pr ? (cumM[lo] ?? 0) + pr.alongM : this.#along;
    let offRouteM = pr ? pr.distanceM : Infinity;

    // Tappat rutten? Då — och bara då — är en full sökning värd sitt pris. Det är så vi
    // hittar tillbaka efter en avstickare, utan att den kostat något medan vi låg rätt.
    if (this.#primed && offRouteM > REACQUIRE_M) {
      const full = projectOnPolyline(p, shape);
      if (full && full.distanceM < offRouteM) {
        pr = full;
        alongM = full.alongM;
        offRouteM = full.distanceM;
      }
    }

    const at = pr ? pr.at : (shape[0] ?? p);
    this.#along = alongM;
    this.#primed = true;

    const maneuverIndex = nextManeuverIndex(this.#r.maneuverAtM, alongM);

    return {
      at,
      alongM,
      offRouteM,
      maneuverIndex,
      toManeuverM: Math.max(0, (this.#r.maneuverAtM[maneuverIndex] ?? 0) - alongM),
      remainingM: Math.max(0, this.#r.distanceM - alongM),
      remainingS: this.#remainingS(alongM, maneuverIndex),
    };
  }

  /** Kasta positionen. Nästa `update` söker igenom hela rutten igen. */
  reset(): void {
    this.#along = 0;
    this.#primed = false;
  }

  /**
   * Tiden kvar, interpolerad i det ben vi kör på just nu.
   *
   * Ingen klocka, ingen nedräkning. Skärmen skriver "1 h 17 min" och rör sig långsamt —
   * det är hela skillnaden mot en GPS som räknar ner sekunder åt dig.
   */
  #remainingS(alongM: number, maneuverIndex: number): number {
    const { maneuverAtM, maneuverAtS, maneuvers, timeS } = this.#r;

    const i = Math.max(0, maneuverIndex - 1);
    const fromM = maneuverAtM[i] ?? 0;
    const toM = maneuverAtM[maneuverIndex] ?? fromM;
    const legM = toM - fromM;
    const del = legM > 0 ? clamp01((alongM - fromM) / legM) : 1;

    const förbrukat = (maneuverAtS[i] ?? 0) + (maneuvers[i]?.timeS ?? 0) * del;
    return Math.max(0, timeS - förbrukat);
  }

  #nodeBefore(meter: number): number {
    const cum = this.#r.cumM;
    let i = 0;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] ?? 0) <= meter) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return i;
  }

  #nodeAfter(meter: number): number {
    const cum = this.#r.cumM;
    let i = cum.length - 1;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] ?? 0) >= meter) { i = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return i;
  }
}
