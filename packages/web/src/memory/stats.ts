/**
 * Siffrorna om nätet. Kilometer, aldrig procent — "62 av 80 km är nya för dig",
 * aldrig "78 % nytt".
 *
 * `netKm` är UNIK VÄG och räknas ur cellerna, inte ur turernas längd. Kör du samma
 * fyra mil till jobbet 200 gånger står nätet stilla på 40 km. Summerar man i stället
 * odometern får pendlaren "8 000 km i ditt nät" för att ha sett fyra mil — appen
 * gratulerar honom då för upprepning, vilket är precis det beteende den finns för
 * att bryta.
 *
 * `drivenKm` är odometern. Den finns för ärlighet om spårets omfattning, men den är
 * aldrig huvudsiffran och visas aldrig som "ditt nät".
 */

import { netKm as netKmFromCells } from '@mindful/core';

import type { MemoryStore } from './db.js';

export interface MemoryStats {
  /** Unik väg. Ur cellerna. DETTA är "ditt nät". */
  readonly netKm: number;
  /** Odometern: summan av alla turers längd. Aldrig "ditt nät". */
  readonly drivenKm: number;
  readonly cellCount: number;
  readonly tripCount: number;
  /** ms, eller null om användaren inte kört en meter än. */
  readonly firstTripAt: number | null;
  readonly lastTripAt: number | null;
  readonly unsyncedCount: number;
}

export async function memoryStats(store: MemoryStore): Promise<MemoryStats> {
  const [traces, shards] = await Promise.all([store.allTraces(), store.allShards()]);

  let meters = 0;
  let first: number | null = null;
  let last: number | null = null;
  let unsynced = 0;

  for (const t of traces) {
    meters += t.distanceM;
    if (first === null || t.startedAt < first) first = t.startedAt;
    if (last === null || t.endedAt > last) last = t.endedAt;
    if (!t.synced) unsynced++;
  }

  let cells = 0;
  for (const s of shards) cells += s.h3.length;

  return {
    netKm: netKmFromCells(cells),
    drivenKm: meters / 1000,
    cellCount: cells,
    tripCount: traces.length,
    firstTripAt: first,
    lastTripAt: last,
    unsyncedCount: unsynced,
  };
}
