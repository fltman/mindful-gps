/**
 * H3 — och gränsen mot h3-js.
 *
 * ⚠️ h3-js v4 har INGET bigint-API. `latLngToCell()` returnerar en HEX-STRÄNG, och den
 *    vill ha argumenten som (lat, lng) medan hela vårt kontrakt är [lon, lat].
 *
 *    Båda kastningarna sker HÄR, en gång, i den här filen. Utanför den finns bara
 *    bigint och [lon, lat]. Ser du `latLngToCell` någon annanstans i kodbasen är det
 *    en bugg.
 *
 * Varför bigint och inte hex-strängar: 178 000 celler à 15 tecken ≈ 14 MB RAM som
 * Set<string>. Som sorterad BigUint64Array: 1,4 MB, och uppslaget blir en binärsökning
 * i stället för en hashning av en sträng vi ändå måste allokera. Se CONTRACT §3.3/§3.5.
 */

import { cellToParent as h3CellToParent, gridDisk as h3GridDisk,
         gridPathCells as h3GridPathCells, latLngToCell } from 'h3-js';

import { H3_SHARD_RES } from './constants.js';
import { familiarityRank } from './familiarity.js';
import type { LngLat, VisitedCell, VisitedShard } from './types.js';

// ─── Gränsen mot h3-js ──────────────────────────────────────────────────────

/** bigint → h3-js hex. En H3-cell har alltid nollställd toppbit, så aldrig padding. */
const toHex = (h3: bigint): string => h3.toString(16);

/** h3-js hex → bigint. */
const toBig = (hex: string): bigint => BigInt('0x' + hex);

/** Cellen som täcker punkten. Enda stället i kodbasen där [lon,lat] blir (lat,lng). */
export function cell(p: LngLat, res: number): bigint {
  return toBig(latLngToCell(p[1], p[0], res));
}

/** Cellen själv plus alla celler inom `k` steg. k=1 → 7 celler. */
export function gridDisk(h3: bigint, k: number): bigint[] {
  return h3GridDisk(toHex(h3), k).map(toBig);
}

/**
 * `gridDisk` utan att allokera en ny array per anrop: skriver i `out` och returnerar
 * antalet celler. `out` växer vid behov och återanvänds av anroparen.
 *
 * Skillnaden är inte kosmetisk. Ringen slås upp en gång per stark cell när grann-indexet
 * byggs (178 000 gånger på ett veteranminne) och en gång per baselinesampel i `dilate`.
 * Varje `gridDisk` allokerar annars en sträng-array från WASM, en bigint-array och sju
 * bigints — nio objekt som lever i mikrosekunder och sedan städas av GC.
 */
export function gridDiskInto(h3: bigint, k: number, out: bigint[]): number {
  const hex = h3GridDisk(toHex(h3), k);
  for (let i = 0; i < hex.length; i++) {
    const s = hex[i];
    if (s !== undefined) out[i] = toBig(s);
  }
  return hex.length;
}

/**
 * Cellerna längs den räta linjen mellan två celler, ändpunkterna inkluderade.
 *
 * Används för att täppa diagonalhålen mellan konsekutiva fixar (CONTRACT §3.4 steg 6).
 * h3-js kastar om vägen korsar en pentagon; då faller vi tillbaka på de två celler vi
 * FAKTISKT observerat. Vi hittar aldrig på en väg vi inte kört.
 */
export function gridPathCells(a: bigint, b: bigint): bigint[] {
  try {
    return h3GridPathCells(toHex(a), toHex(b)).map(toBig);
  } catch {
    return a === b ? [a] : [a, b];
  }
}

export function cellToParent(h3: bigint, res: number): bigint {
  return toBig(h3CellToParent(toHex(h3), res));
}

// ─── Axlar ──────────────────────────────────────────────────────────────────

/**
 * Bäring → en av fyra AXEL-buckets à 45°, kvantiserade MODULO 180°.
 *
 * En väg har en AXEL, inte en riktning: norrut och söderut på samma väg är samma väg.
 * `axisBucket(10) === axisBucket(190)`. Gör vi tvärtom skickar appen dig tillbaka
 * samma väg du precis kom och kallar det "ny väg" — det läser som en bugg, och all
 * prior art (Wandrer, VeloViewer, CityStrides) är riktningsagnostisk.
 *
 * OBS: detta är bucketens INDEX (0..3), inte masken. Biten sätts med `1 << axisBucket(b)`.
 */
export function axisBucket(bearingDeg: number): number {
  const axis = ((bearingDeg % 180) + 180) % 180;
  return Math.min(3, Math.floor(axis / 45));
}

// ─── Minnet ─────────────────────────────────────────────────────────────────

/** En cell som passerats under en körning. En cell per PASSAGE, inte per GPS-fix. */
export interface CellVisit {
  readonly h3: bigint;
  /** `1 << axisBucket(bearing)`. 0 när farten var för låg för att lita på bäringen. */
  readonly axisMask: number;
}

const bigAsc = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** Första index i en sorterad cell-array vars cell är ≥ h3. Binärsökningen. */
function lowerBound(arr: BigUint64Array, h3: bigint): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid];
    if (v !== undefined && v < h3) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** (visits u8, lastSeenDay u16) i ett tal. Sparar en objektallokering per förslag. */
const packWinner = (visits: number, lastSeenDay: number): number => lastSeenDay * 256 + visits;
const winnerVisits = (packed: number): number => packed % 256;
const winnerDay = (packed: number): number => Math.floor(packed / 256);

/**
 * Nyhetsminnet: sorterad BigUint64Array + tre parallella arrayer (struct-of-arrays).
 *
 * Uppslag är en binärsökning, inte en hashning — 30 km rutt = 1 200 sampel och det ska
 * gå på under en millisekund, offline, utan ett enda API-anrop. Det är hela poängen
 * med H3.
 *
 * Invariant: `#h3` är strikt stigande, och alla fyra arrayerna har samma längd.
 * Konstruktorn upprätthåller det; därför är varje index som finns i `#h3` giltigt
 * även i de andra tre.
 *
 * Utöver besöken bär indexet ett förberäknat GRANN-MAX (`strongNeighborOf`). Det är
 * det som gör `softFamiliarity` till två binärsökningar i stället för en `gridDisk`
 * över WASM-gränsen per sampel — se kommentaren vid `#rebuildNeighbors`.
 */
export class VisitedIndex {
  // Inte readonly: `upsert` byter ut hela kvartetten på en gång. Att växa en typad
  // array betyder att allokera om den ändå.
  #h3: BigUint64Array;
  #visits: Uint8Array;
  #lastSeenDay: Uint16Array;
  #axisMask: Uint8Array;

  // Grann-indexet. `undefined` = inte byggt än; det byggs vid första uppslaget och
  // underhålls sedan inkrementellt av `upsert`.
  #nbH3: BigUint64Array | undefined;
  #nbVisits = new Uint8Array(0);
  #nbDay = new Uint16Array(0);

  private constructor(
    h3: BigUint64Array,
    visits: Uint8Array,
    lastSeenDay: Uint16Array,
    axisMask: Uint8Array,
  ) {
    if (visits.length !== h3.length
      || lastSeenDay.length !== h3.length
      || axisMask.length !== h3.length) {
      throw new Error('VisitedIndex: parallella arrayer har olika längd');
    }
    this.#h3 = h3;
    this.#visits = visits;
    this.#lastSeenDay = lastSeenDay;
    this.#axisMask = axisMask;
  }

  static empty(): VisitedIndex {
    return new VisitedIndex(
      new BigUint64Array(0), new Uint8Array(0), new Uint16Array(0), new Uint8Array(0),
    );
  }

  /**
   * Bygg ur en osorterad cell-lista (t.ex. svaret från `GET /api/memory`).
   * Dubbletter slås ihop konservativt: besök summeras (mättar vid 255), senaste dag
   * vinner, axelmasker OR:as.
   */
  static fromCells(cells: readonly VisitedCell[]): VisitedIndex {
    const sorted = [...cells].sort((a, b) => bigAsc(a.h3, b.h3));

    const h3 = new BigUint64Array(sorted.length);
    const visits = new Uint8Array(sorted.length);
    const lastSeenDay = new Uint16Array(sorted.length);
    const axisMask = new Uint8Array(sorted.length);

    let w = -1;
    for (const c of sorted) {
      if (w >= 0 && h3[w] === c.h3) {
        visits[w] = Math.min(255, (visits[w] ?? 0) + c.visits);
        lastSeenDay[w] = Math.max(lastSeenDay[w] ?? 0, c.lastSeenDay);
        axisMask[w] = (axisMask[w] ?? 0) | c.axisMask;
        continue;
      }
      w++;
      h3[w] = c.h3;
      visits[w] = Math.min(255, c.visits);
      lastSeenDay[w] = c.lastSeenDay;
      axisMask[w] = c.axisMask;
    }

    const n = w + 1;
    return new VisitedIndex(
      h3.subarray(0, n), visits.subarray(0, n),
      lastSeenDay.subarray(0, n), axisMask.subarray(0, n),
    );
  }

  /**
   * Slå ihop shards till ett index.
   *
   * Shards är nycklade på res-6-förälder och därför disjunkta — men vi slår ihop
   * kollisioner ändå (samma regel som `fromCells`), så att ett lokalt minne och ett
   * nedladdat serverminne kan mötas utan att någon cell tappas.
   */
  static fromShards(shards: readonly VisitedShard[]): VisitedIndex {
    const cells: VisitedCell[] = [];
    for (const s of shards) {
      for (let i = 0; i < s.h3.length; i++) {
        const h = s.h3[i];
        if (h === undefined) continue;
        cells.push({
          h3: h,
          visits: s.visits[i] ?? 0,
          lastSeenDay: s.lastSeenDay[i] ?? 0,
          axisMask: s.axisMask[i] ?? 0,
        });
      }
    }
    return VisitedIndex.fromCells(cells);
  }

  get size(): number {
    return this.#h3.length;
  }

  /**
   * Index i de typade arrayerna, eller -1. Allokerar ingenting.
   *
   * `get()` bygger en färsk `VisitedCell` per anrop. Det är rätt för en anropare som
   * vill ha cellen — men `softFamiliarity` slår upp åtta celler per sampel, och en
   * 20-kandidatsplan hade då kastat bort ~190 000 objekt bara för att läsa tre tal.
   */
  indexOf(h3: bigint): number {
    const i = lowerBound(this.#h3, h3);
    return i < this.#h3.length && this.#h3[i] === h3 ? i : -1;
  }

  /** Besök vid ett index ur `indexOf`. */
  visitsAt(i: number): number {
    return this.#visits[i] ?? 0;
  }

  /** Senast sedd (dagar sedan EPOCH_DAY0) vid ett index ur `indexOf`. */
  lastSeenDayAt(i: number): number {
    return this.#lastSeenDay[i] ?? 0;
  }

  get(h3: bigint): VisitedCell | undefined {
    const i = this.indexOf(h3);
    if (i < 0) return undefined;
    return {
      h3,
      visits: this.#visits[i] ?? 0,
      lastSeenDay: this.#lastSeenDay[i] ?? 0,
      axisMask: this.#axisMask[i] ?? 0,
    };
  }

  // ── Grann-maxet ───────────────────────────────────────────────────────────
  //
  // `softFamiliarity` behöver den granne (visits ≥ 2) som maximerar familiarity. Att
  // hämta ringen med gridDisk kostar ~1 µs per sampel — 1 200 sampel = 1,2 ms, alltså
  // hela kontraktets budget innan ett enda uppslag är gjort. Men vilken granne som
  // vinner beror INTE på dagen (se familiarityRank), så vinnaren kan avgöras när cellen
  // skrivs. Kvar i den heta loopen blir två binärsökningar och noll WASM-anrop.
  //
  // Priset: ett sidoindex över dilationen av de starka cellerna — på ett veteranminne
  // (178 000 celler) ~420 000 poster à 11 byte ≈ 4,7 MB. Det byggs lat, vid första
  // uppslaget, så en användare som bara kör och aldrig planerar betalar aldrig för det.

  /**
   * Index i grann-indexet för den starka granne som maximerar familiarity för `h3`,
   * eller -1 om cellen inte har någon granne med visits ≥ 2.
   *
   * Cellen själv ingår inte: `softFamiliarity` tar `max(own, 0,35 · best)`, och
   * 0,35 · familiarity(själv) ≤ familiarity(själv) = own. Den kan alltså aldrig vinna.
   */
  strongNeighborOf(h3: bigint): number {
    let nb = this.#nbH3;
    if (nb === undefined) {
      this.#rebuildNeighbors();
      nb = this.#nbH3 ?? new BigUint64Array(0);
    }
    const i = lowerBound(nb, h3);
    return i < nb.length && nb[i] === h3 ? i : -1;
  }

  /** Besök hos vinnargrannen vid ett index ur `strongNeighborOf`. */
  neighborVisitsAt(i: number): number {
    return this.#nbVisits[i] ?? 0;
  }

  /** Senast sedd hos vinnargrannen vid ett index ur `strongNeighborOf`. */
  neighborLastSeenDayAt(i: number): number {
    return this.#nbDay[i] ?? 0;
  }

  /** Sprid en stark cells rang till sina sex grannar. Ett förslag per granncell. */
  #propose(i: number, best: Map<bigint, number>, rank: Map<bigint, number>,
           disk: bigint[]): void {
    const src = this.#h3[i];
    if (src === undefined) return;

    const visits = this.#visits[i] ?? 0;
    if (visits < 2) return;                       // svaga spår smittar inte (§3.3)

    const day = this.#lastSeenDay[i] ?? 0;
    const r = familiarityRank(visits, day);
    const n = gridDiskInto(src, 1, disk);

    for (let k = 0; k < n; k++) {
      const c = disk[k];
      if (c === undefined || c === src) continue;
      const cur = rank.get(c);
      if (cur === undefined || cur < r) {
        rank.set(c, r);
        best.set(c, packWinner(visits, day));
      }
    }
  }

  /**
   * Slå ihop förslagen med det befintliga grann-indexet.
   *
   * Rangen kan bara VÄXA — `upsert` höjer visits och skjuter lastSeenDay framåt, aldrig
   * bakåt, och celler tas aldrig bort. Därför räcker en max-sammanslagning: ett förslag
   * kan aldrig göra ett befintligt grann-max ogiltigt, bara bättre.
   */
  #mergeNeighbors(best: Map<bigint, number>, rank: Map<bigint, number>): void {
    const oldH3 = this.#nbH3 ?? new BigUint64Array(0);
    const fresh = [...best.keys()].sort(bigAsc);

    const cap = oldH3.length + fresh.length;
    const h3 = new BigUint64Array(cap);
    const visits = new Uint8Array(cap);
    const day = new Uint16Array(cap);

    let i = 0;   // in i det befintliga grann-indexet
    let j = 0;   // in i förslagen
    let w = 0;   // ut

    const put = (c: bigint, packed: number): void => {
      h3[w] = c;
      visits[w] = winnerVisits(packed);
      day[w] = winnerDay(packed);
      w++;
    };

    while (i < oldH3.length || j < fresh.length) {
      const old = i < oldH3.length ? oldH3[i] : undefined;
      const add = j < fresh.length ? fresh[j] : undefined;

      if (add === undefined || (old !== undefined && old < add)) {
        if (old === undefined) break;
        put(old, packWinner(this.#nbVisits[i] ?? 0, this.#nbDay[i] ?? 0));
        i++;
      } else if (old === undefined || add < old) {
        put(add, best.get(add) ?? 0);
        j++;
      } else {
        const oldRank = familiarityRank(this.#nbVisits[i] ?? 0, this.#nbDay[i] ?? 0);
        const newRank = rank.get(add) ?? 0;
        put(add, newRank > oldRank
          ? (best.get(add) ?? 0)
          : packWinner(this.#nbVisits[i] ?? 0, this.#nbDay[i] ?? 0));
        i++;
        j++;
      }
    }

    this.#nbH3 = h3.subarray(0, w);
    this.#nbVisits = visits.subarray(0, w);
    this.#nbDay = day.subarray(0, w);
  }

  /** Bygg grann-indexet från grunden: varje stark cell sprider sin rang till sin ring. */
  #rebuildNeighbors(): void {
    this.#nbH3 = new BigUint64Array(0);
    this.#nbVisits = new Uint8Array(0);
    this.#nbDay = new Uint16Array(0);

    const best = new Map<bigint, number>();
    const rank = new Map<bigint, number>();
    const disk: bigint[] = [];

    for (let i = 0; i < this.#h3.length; i++) this.#propose(i, best, rank, disk);

    this.#mergeNeighbors(best, rank);
  }

  /**
   * Skriv in en batch passerade celler. En batch = ett svep (CONTRACT §3.4 steg 8:
   * IndexedDB i 10-sekundersbatchar, aldrig per fix).
   *
   * Samma cell FLERA gånger i samma batch räknas som ETT besök. Densifieringen lägger
   * en punkt var 15:e meter genom en cell som är ~50 m bred — utan den här dedupen
   * hade en enda genomkörning bokförts som tre till fyra, och `familiarity` hade
   * sprungit från 0,50 till 0,94 på en körning.
   */
  upsert(batch: readonly CellVisit[], day: number): void {
    if (batch.length === 0) return;

    const seen = new Map<bigint, number>();
    for (const v of batch) seen.set(v.h3, (seen.get(v.h3) ?? 0) | v.axisMask);
    const fresh = [...seen.keys()].sort(bigAsc);

    const n = this.#h3.length;
    const cap = n + fresh.length;

    const h3 = new BigUint64Array(cap);
    const visits = new Uint8Array(cap);
    const lastSeenDay = new Uint16Array(cap);
    const axisMask = new Uint8Array(cap);

    let i = 0;   // in i det befintliga indexet
    let j = 0;   // in i batchen
    let w = 0;   // ut

    while (i < n || j < fresh.length) {
      const old = i < n ? this.#h3[i] : undefined;
      const add = j < fresh.length ? fresh[j] : undefined;

      if (add === undefined || (old !== undefined && old < add)) {
        if (old === undefined) break;
        h3[w] = old;
        visits[w] = this.#visits[i] ?? 0;
        lastSeenDay[w] = this.#lastSeenDay[i] ?? 0;
        axisMask[w] = this.#axisMask[i] ?? 0;
        i++;
      } else if (old === undefined || add < old) {
        h3[w] = add;
        visits[w] = 1;
        lastSeenDay[w] = day;
        axisMask[w] = seen.get(add) ?? 0;
        j++;
      } else {
        h3[w] = old;
        visits[w] = Math.min(255, (this.#visits[i] ?? 0) + 1);
        // max(), inte day: att spela upp ett gammalt spår i efterhand får inte
        // föryngra en cell vi kört senare.
        lastSeenDay[w] = Math.max(this.#lastSeenDay[i] ?? 0, day);
        axisMask[w] = (this.#axisMask[i] ?? 0) | (seen.get(add) ?? 0);
        i++;
        j++;
      }
      w++;
    }

    this.#h3 = h3.subarray(0, w);
    this.#visits = visits.subarray(0, w);
    this.#lastSeenDay = lastSeenDay.subarray(0, w);
    this.#axisMask = axisMask.subarray(0, w);

    // Grann-indexet, om det finns, underhålls inkrementellt: bara cellerna i batchen
    // kan ha ändrat rang, och rangen kan bara växa. Finns det inte byggs det lat vid
    // första uppslaget — en användare som bara kör betalar aldrig för det.
    if (this.#nbH3 === undefined) return;

    const best = new Map<bigint, number>();
    const rank = new Map<bigint, number>();
    const disk: bigint[] = [];

    for (const c of fresh) {
      const at = this.indexOf(c);
      if (at >= 0) this.#propose(at, best, rank, disk);
    }

    if (best.size > 0) this.#mergeNeighbors(best, rank);
  }

  /** Dela upp minnet i shards för lagring. Varje shard förblir sorterad. */
  toShards(): VisitedShard[] {
    const groups = new Map<string, number[]>();

    for (let i = 0; i < this.#h3.length; i++) {
      const h = this.#h3[i];
      if (h === undefined) continue;
      const parent = toHex(cellToParent(h, H3_SHARD_RES));
      const bucket = groups.get(parent);
      if (bucket) bucket.push(i);
      else groups.set(parent, [i]);
    }

    const shards: VisitedShard[] = [];
    for (const [parent, idx] of groups) {
      const h3 = new BigUint64Array(idx.length);
      const visits = new Uint8Array(idx.length);
      const lastSeenDay = new Uint16Array(idx.length);
      const axisMask = new Uint8Array(idx.length);

      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (i === undefined) continue;
        h3[k] = this.#h3[i] ?? 0n;
        visits[k] = this.#visits[i] ?? 0;
        lastSeenDay[k] = this.#lastSeenDay[i] ?? 0;
        axisMask[k] = this.#axisMask[i] ?? 0;
      }

      shards.push({ parent, h3, visits, lastSeenDay, axisMask });
    }

    return shards;
  }
}
