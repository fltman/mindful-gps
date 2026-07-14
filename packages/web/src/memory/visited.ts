/**
 * Nyhetsminnet i RAM, mot IndexedDB.
 *
 * `VisitedIndex` från `@mindful/core` äger matten — familiaritet, grann-mjukhet,
 * upsert-regler. Här finns bara det core inte kan veta: VILKA shards som är laddade,
 * vilka som blivit smutsiga, och när de ska skrivas tillbaka.
 *
 * Invarianten som gör tillbakaskrivningen förlustfri:
 *
 *   En shard skrivs ALDRIG utan att först ha lästs in i indexet.
 *
 * `flush` skriver hela shards, inte diffar. Hade vi skrivit en shard vars lagrade celler
 * aldrig laddats hade de cellerna raderats — minnet av en väg du kört hade försvunnit
 * för att du råkade köra där igen utan att kartan visade området. Därför laddar `remember`
 * alltid föräldrarna till de celler den ska skriva, före upserten.
 */

import {
  BEARING_MIN_SPEED_MS, DENSIFY_M, H3_RES, MAX_GAP_M,
  VisitedIndex, axisBucket, bearing, cell, densify, gridPathCells, haversine, todayDay,
  type CellVisit, type LngLat, type VisitedShard,
} from '@mindful/core';

import type { MemoryStore } from './db.js';
import { type BBox, bboxToShards, loadShards, saveShards, shardKey } from './shards.js';

/**
 * Skrivvägen, CONTRACT §3.4 steg 4–7: densifiera, cellifiera, täpp diagonalhålen.
 *
 * `points` är redan filtrerade fixar ([lon, lat], accuracy ≤ 30 m, ≥ 1 s och ≥ 10 m
 * isär). `speedsMs[i]` är farten vid `points[i]`; saknas den sätts ingen axel.
 *
 * Två saker vi INTE gör:
 *  - Vi interpolerar aldrig över ett hål > MAX_GAP_M. Ett stort hål är signalförlust
 *    eller en släckt skärm, och vi hittar aldrig på en väg vi inte observerat. Punkterna
 *    på var sin sida om hålet bokförs — sträckan emellan gör vi inte.
 *  - Vi sätter ingen axelbit under BEARING_MIN_SPEED_MS. Under 5 m/s är GPS-bäringen brus.
 */
export function cellsAlong(
  points: readonly LngLat[],
  speedsMs?: readonly number[],
): CellVisit[] {
  const out: CellVisit[] = [];
  const push = (h3: bigint, axisMask: number): void => {
    out.push({ h3, axisMask });
  };

  const first = points[0];
  if (!first) return out;
  push(cell(first, H3_RES), 0);

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;

    const speed = speedsMs?.[i - 1] ?? 0;
    const mask = speed > BEARING_MIN_SPEED_MS ? 1 << axisBucket(bearing(a, b)) : 0;

    if (haversine(a, b) > MAX_GAP_M) {
      push(cell(b, H3_RES), 0);
      continue;
    }

    const dense = densify([a, b], DENSIFY_M, MAX_GAP_M);
    let prev = cell(a, H3_RES);
    for (let k = 1; k < dense.length; k++) {
      const p = dense[k];
      if (!p) continue;
      const c = cell(p, H3_RES);
      if (c === prev) continue;
      // Två konsekutiva sampel kan ligga i celler som inte är grannar (svängar,
      // kordan är 39,3 m). gridPathCells lägger tillbaka cellerna vi passerade genom.
      for (const step of gridPathCells(prev, c)) push(step, mask);
      prev = c;
    }
  }

  return out;
}

export class VisitedMemory {
  readonly #store: MemoryStore;
  #index: VisitedIndex;
  /** Föräldrar vars shard är inläst i `#index` — även de som inte fanns i lagringen. */
  readonly #loaded = new Set<string>();
  /** Föräldrar vars celler ändrats sedan senaste `flush`. */
  readonly #dirty = new Set<string>();

  private constructor(store: MemoryStore) {
    this.#store = store;
    this.#index = VisitedIndex.empty();
  }

  /** Ett tomt minne. Ingenting läses förrän någon frågar efter en bbox eller skriver. */
  static open(store: MemoryStore): VisitedMemory {
    return new VisitedMemory(store);
  }

  /** Indexet som `routeNovelty`, `novelKm` och planeraren läser. */
  get index(): VisitedIndex {
    return this.#index;
  }

  /** Celler i RAM just nu — inte hela minnet, bara de laddade shardarna. */
  get cellCount(): number {
    return this.#index.size;
  }

  get loadedShards(): number {
    return this.#loaded.size;
  }

  get hasUnflushed(): boolean {
    return this.#dirty.size > 0;
  }

  /** Ladda in allt minne som kartvyn rör. */
  ensureBBox(bbox: BBox): Promise<void> {
    return this.ensureParents(bboxToShards(bbox));
  }

  /** Hela minnet i RAM. För export och för statistik över nätet. */
  async loadAll(): Promise<void> {
    const shards = await this.#store.allShards();
    const fresh = shards.filter((s) => !this.#loaded.has(s.parent));
    for (const s of shards) this.#loaded.add(s.parent);
    this.#absorb(fresh);
  }

  async ensureParents(parents: Iterable<string>): Promise<void> {
    const missing = [...new Set(parents)].filter((p) => !this.#loaded.has(p));
    if (missing.length === 0) return;

    const shards = await loadShards(this.#store, missing);
    // Även föräldrar som saknade shard markeras som laddade: de är tomma, och att fråga
    // lagringen om dem igen ger samma tomma svar.
    for (const p of missing) this.#loaded.add(p);
    this.#absorb(shards);
  }

  /**
   * Bokför en batch passerade celler. En batch är ett svep, aldrig en enskild fix
   * (§3.4 steg 8). Samma cell flera gånger i batchen räknas som ETT besök — det är
   * `VisitedIndex.upsert` som avgör, inte vi.
   */
  async remember(batch: readonly CellVisit[], day: number = todayDay()): Promise<void> {
    if (batch.length === 0) return;

    const parents = new Set<string>();
    for (const v of batch) parents.add(shardKey(v.h3));
    await this.ensureParents(parents);

    this.#index.upsert(batch, day);
    for (const p of parents) this.#dirty.add(p);
  }

  /** Skriv de ändrade shardarna till IndexedDB. Anropas var 10:e sekund under en tur. */
  async flush(): Promise<void> {
    if (this.#dirty.size === 0) return;

    const dirty = new Set(this.#dirty);
    this.#dirty.clear();

    const shards = this.#index.toShards().filter((s) => dirty.has(s.parent));
    await saveShards(this.#store, shards);
  }

  /** Kasta RAM-bilden. Nästa `ensureBBox` läser om från lagringen. */
  async reload(): Promise<void> {
    await this.flush();
    this.#index = VisitedIndex.empty();
    this.#loaded.clear();
  }

  /**
   * Slå in nya shards i indexet.
   *
   * Nya föräldrar är per konstruktion disjunkta från de redan laddade, så
   * `fromShards` kan inte dubbelräkna ett besök här.
   */
  #absorb(fresh: readonly VisitedShard[]): void {
    if (fresh.length === 0) return;
    const current = this.#index.size > 0 ? this.#index.toShards() : [];
    this.#index = VisitedIndex.fromShards([...current, ...fresh]);
  }
}
