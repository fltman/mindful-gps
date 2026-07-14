/**
 * Shards — minnet uppdelat på H3-res-6-föräldrar (CONTRACT §3.5).
 *
 * En shard är den minsta enhet vi läser och skriver. Kartan visar en bbox; vi laddar
 * shardarna som bbox:en rör, och inget annat. Ett veteranminne på 178 000 celler ligger
 * kvar på disk medan RAM bara håller de tiotal shards användaren faktiskt tittar på.
 *
 * All H3 går genom `@mindful/core/h3util` — hex-strängarna och (lat,lng)-ordningen bor
 * där, i en enda fil. Här finns bara bigint och [lon, lat].
 */

import {
  H3_SHARD_RES, cell, cellToParent, gridDisk,
  type VisitedCell, type VisitedShard,
} from '@mindful/core';

import type { MemoryStore } from './db.js';

/** [minLon, minLat, maxLon, maxLat]. */
export type BBox = readonly [number, number, number, number];

/**
 * En cell på tråden och i exportfilen. Samma tupel i `GET /api/memory` (§3.6) som i
 * exporten — ett format i systemet, inte två.
 */
export type CellTuple = readonly [h3hex: string, visits: number, lastSeenDay: number, axisMask: number];

export const cellTuple = (c: VisitedCell): CellTuple =>
  [c.h3.toString(16), c.visits, c.lastSeenDay, c.axisMask];

/** Tuplar från servern eller en fil. Trasiga rader hoppas över, aldrig hela svaret. */
export function parseCellTuples(raw: unknown): VisitedCell[] {
  if (!Array.isArray(raw)) return [];

  const cells: VisitedCell[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [hex, visits, lastSeenDay, axisMask] = row as unknown[];
    if (typeof hex !== 'string'
      || typeof visits !== 'number'
      || typeof lastSeenDay !== 'number'
      || typeof axisMask !== 'number') continue;
    cells.push({
      h3: BigInt('0x' + hex),
      visits: Math.min(255, Math.max(0, Math.trunc(visits))),
      lastSeenDay: Math.max(0, Math.trunc(lastSeenDay)),
      axisMask: axisMask & 0xff,
    });
  }
  return cells;
}

/**
 * Provtagningssteg när en bbox översätts till shards. En res-6-cell är ~6,5 km bred,
 * alltså en inradie på knappt 3 km — 2 km garanterar att ingen cell hoppas över, och
 * ringdilationen nedan tar de sneda hörnfallen.
 */
const SHARD_SAMPLE_M = 2_000;

const M_PER_DEG_LAT = 111_320;

/** Shard-nyckeln för en res-11-cell: dess res-6-förälder som hex. */
export function shardKey(h3: bigint): string {
  return cellToParent(h3, H3_SHARD_RES).toString(16);
}

/**
 * Shard-nycklarna som en bbox kan röra.
 *
 * Ett rutnät av provpunkter, plus en rings dilation runt varje träffad cell. Det ger
 * en ÖVERMÄNGD: några nycklar finns inte i lagringen, och en `get` som returnerar
 * undefined är billig. Motsatt fel — en missad shard — är minne som tyst försvinner
 * från kartan, och det är inte ett fel vi accepterar.
 *
 * Kostnaden är linjär i bbox-arean. En vy över hela Sverige blir ~60 000 provpunkter
 * och tar tiondelar av en sekund; en normal kartvy tar mikrosekunder.
 */
export function bboxToShards(bbox: BBox): string[] {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return [];

  const latStep = SHARD_SAMPLE_M / M_PER_DEG_LAT;
  const worstLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const shrink = Math.max(0.05, Math.cos((worstLat * Math.PI) / 180));
  const lonStep = latStep / shrink;

  const seeds = new Set<bigint>();
  for (let lat = minLat; ; lat += latStep) {
    const y = Math.min(lat, maxLat);
    for (let lon = minLon; ; lon += lonStep) {
      const x = Math.min(lon, maxLon);
      seeds.add(cell([x, y], H3_SHARD_RES));
      if (x >= maxLon) break;
    }
    if (y >= maxLat) break;
  }

  const keys = new Set<string>();
  for (const seed of seeds) {
    for (const n of gridDisk(seed, 1)) keys.add(n.toString(16));
  }
  return [...keys];
}

export function shardCells(s: VisitedShard): VisitedCell[] {
  const out: VisitedCell[] = [];
  for (let i = 0; i < s.h3.length; i++) {
    const h3 = s.h3[i];
    if (h3 === undefined) continue;
    out.push({
      h3,
      visits: s.visits[i] ?? 0,
      lastSeenDay: s.lastSeenDay[i] ?? 0,
      axisMask: s.axisMask[i] ?? 0,
    });
  }
  return out;
}

/** Osorterade celler → färdiga, sorterade shards. Dubbletter slås ihop med `mergeShard`. */
export function cellsToShards(cells: readonly VisitedCell[]): VisitedShard[] {
  const groups = new Map<string, VisitedCell[]>();
  for (const c of cells) {
    const key = shardKey(c.h3);
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const shards: VisitedShard[] = [];
  for (const [parent, group] of groups) {
    group.sort((a, b) => (a.h3 < b.h3 ? -1 : a.h3 > b.h3 ? 1 : 0));

    const h3 = new BigUint64Array(group.length);
    const visits = new Uint8Array(group.length);
    const lastSeenDay = new Uint16Array(group.length);
    const axisMask = new Uint8Array(group.length);

    let w = -1;
    for (const c of group) {
      if (w >= 0 && h3[w] === c.h3) {
        visits[w] = Math.max(visits[w] ?? 0, Math.min(255, c.visits));
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
    shards.push({
      parent,
      h3: h3.slice(0, n),
      visits: visits.slice(0, n),
      lastSeenDay: lastSeenDay.slice(0, n),
      axisMask: axisMask.slice(0, n),
    });
  }
  return shards;
}

/**
 * Slå ihop två shards för samma förälder. Sorterad merge, ett svep.
 *
 * Regeln är MAX på besök, inte summa: en shard som möter en shard är två BILDER av
 * samma minne (en lokal, en från servern eller en exportfil), inte två körningar.
 * Summering hade gjort en återställning eller en dubbelimport till en fabricerad
 * körhistorik. Att lägga TILL en körning är `VisitedIndex.upsert` — och bara den.
 */
export function mergeShard(a: VisitedShard, b: VisitedShard): VisitedShard {
  const cap = a.h3.length + b.h3.length;
  const h3 = new BigUint64Array(cap);
  const visits = new Uint8Array(cap);
  const lastSeenDay = new Uint16Array(cap);
  const axisMask = new Uint8Array(cap);

  let i = 0;
  let j = 0;
  let w = 0;

  const take = (s: VisitedShard, k: number): void => {
    h3[w] = s.h3[k] ?? 0n;
    visits[w] = s.visits[k] ?? 0;
    lastSeenDay[w] = s.lastSeenDay[k] ?? 0;
    axisMask[w] = s.axisMask[k] ?? 0;
    w++;
  };

  while (i < a.h3.length || j < b.h3.length) {
    const ah = i < a.h3.length ? a.h3[i] : undefined;
    const bh = j < b.h3.length ? b.h3[j] : undefined;

    if (bh === undefined || (ah !== undefined && ah < bh)) {
      if (ah === undefined) break;
      take(a, i++);
    } else if (ah === undefined || bh < ah) {
      take(b, j++);
    } else {
      h3[w] = ah;
      visits[w] = Math.max(a.visits[i] ?? 0, b.visits[j] ?? 0);
      lastSeenDay[w] = Math.max(a.lastSeenDay[i] ?? 0, b.lastSeenDay[j] ?? 0);
      axisMask[w] = (a.axisMask[i] ?? 0) | (b.axisMask[j] ?? 0);
      i++;
      j++;
      w++;
    }
  }

  return {
    parent: a.parent,
    h3: h3.slice(0, w),
    visits: visits.slice(0, w),
    lastSeenDay: lastSeenDay.slice(0, w),
    axisMask: axisMask.slice(0, w),
  };
}

/** Shardarna som finns. Nycklar utan lagrad shard hoppas tyst över. */
export async function loadShards(
  store: MemoryStore,
  parents: Iterable<string>,
): Promise<VisitedShard[]> {
  const found = await Promise.all([...parents].map((p) => store.getShard(p)));
  return found.filter((s): s is VisitedShard => s !== undefined);
}

/** Skriv shards rakt över de lagrade. Anroparen ansvarar för att ha mergat först. */
export function saveShards(store: MemoryStore, shards: readonly VisitedShard[]): Promise<void> {
  return store.putShards(shards);
}

/** Skriv shards och slå ihop med det som redan finns (max-regeln i `mergeShard`). */
export async function mergeShardsInto(
  store: MemoryStore,
  incoming: readonly VisitedShard[],
): Promise<void> {
  const merged = await Promise.all(
    incoming.map(async (s) => {
      const existing = await store.getShard(s.parent);
      return existing ? mergeShard(existing, s) : s;
    }),
  );
  await store.putShards(merged);
}
