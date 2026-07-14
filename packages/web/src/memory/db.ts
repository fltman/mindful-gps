/**
 * IndexedDB — nyhetsminnets lagring. Schemat är CONTRACT §3.5, exakt.
 *
 * Fyra stores:
 *   'traces'   key: id            — råspåren. Sanningen. Raderas aldrig.
 *   'visited'  key: res-6-förälder — H3-minnet, shardat. Ladda BARA det som behövs.
 *   'meta'     key: deviceId | home | settings | lastSync
 *   'outbox'   key: traceId       — sync-kön.
 *
 * BigUint64Array och de andra typade arrayerna klarar structured clone, så en
 * `VisitedShard` går rakt in i IndexedDB utan serialisering. Det är hela poängen med
 * struct-of-arrays: 1,4 MB i stället för 14 MB, både i RAM och på disk.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RawTrace, VisitedShard } from '@mindful/core';

export const DB_NAME = 'mindful';
export const DB_VERSION = 1;

export type MetaKey = 'deviceId' | 'home' | 'settings' | 'lastSync';

/** En post i sync-kön. `attempts` räknar MISSLYCKADE försök och styr backoffen. */
export interface OutboxEntry {
  readonly traceId: string;
  readonly attempts: number;
  readonly nextAttemptAt: number;   // ms
}

export interface MindfulSchema extends DBSchema {
  traces: { key: string; value: RawTrace };
  visited: { key: string; value: VisitedShard };
  meta: { key: MetaKey; value: unknown };
  outbox: { key: string; value: OutboxEntry };
}

export type MindfulDB = IDBPDatabase<MindfulSchema>;

/**
 * Allt minnet behöver av lagringen — och ingenting mer.
 *
 * Anledningen till att det finns ett interface och inte bara en `IDBPDatabase`:
 * IndexedDB finns inte i Node, och ett minne som bara går att testa i en webbläsare
 * blir i praktiken otestat. Testerna kör samma kod mot en Map-baserad implementation.
 */
export interface MemoryStore {
  getShard(parent: string): Promise<VisitedShard | undefined>;
  putShards(shards: readonly VisitedShard[]): Promise<void>;
  allShards(): Promise<VisitedShard[]>;

  getTrace(id: string): Promise<RawTrace | undefined>;
  putTrace(trace: RawTrace): Promise<void>;
  allTraces(): Promise<RawTrace[]>;
  /** Sätter `synced` och tömmer motsvarande outbox-poster i samma svep. */
  markTracesSynced(ids: readonly string[]): Promise<void>;

  enqueue(traceId: string): Promise<void>;
  outbox(): Promise<OutboxEntry[]>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  dropOutbox(traceIds: readonly string[]): Promise<void>;

  getMeta(key: MetaKey): Promise<unknown>;
  setMeta(key: MetaKey, value: unknown): Promise<void>;
}

export function openMemoryDb(): Promise<MindfulDB> {
  return openDB<MindfulSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('traces', { keyPath: 'id' });
        db.createObjectStore('visited', { keyPath: 'parent' });
        db.createObjectStore('meta');
        db.createObjectStore('outbox', { keyPath: 'traceId' });
      }
    },
  });
}

export function idbStore(db: MindfulDB): MemoryStore {
  return {
    getShard: (parent) => db.get('visited', parent),

    async putShards(shards) {
      const tx = db.transaction('visited', 'readwrite');
      await Promise.all([...shards.map((s) => tx.store.put(s)), tx.done]);
    },

    allShards: () => db.getAll('visited'),

    getTrace: (id) => db.get('traces', id),

    async putTrace(trace) {
      await db.put('traces', trace);
    },

    allTraces: () => db.getAll('traces'),

    async markTracesSynced(ids) {
      const tx = db.transaction(['traces', 'outbox'], 'readwrite');
      const traces = tx.objectStore('traces');
      const outbox = tx.objectStore('outbox');
      for (const id of ids) {
        const t = await traces.get(id);
        if (t) await traces.put({ ...t, synced: true });
        await outbox.delete(id);
      }
      await tx.done;
    },

    async enqueue(traceId) {
      // Ett redan köat spår behåller sin backoff — annars skulle en ny tur nollställa
      // väntetiden för ett spår som servern just nu inte vill ta emot.
      const tx = db.transaction('outbox', 'readwrite');
      const existing = await tx.store.get(traceId);
      if (!existing) await tx.store.put({ traceId, attempts: 0, nextAttemptAt: 0 });
      await tx.done;
    },

    outbox: () => db.getAll('outbox'),

    async putOutbox(entry) {
      await db.put('outbox', entry);
    },

    async dropOutbox(traceIds) {
      const tx = db.transaction('outbox', 'readwrite');
      await Promise.all([...traceIds.map((id) => tx.store.delete(id)), tx.done]);
    },

    getMeta: (key) => db.get('meta', key),

    async setMeta(key, value) {
      await db.put('meta', value, key);
    },
  };
}

/**
 * Be webbläsaren att inte kasta ut lagringen.
 *
 * iOS-kvoten är ~1 GB per origin — storleken är inte problemet, EVICTION är. Safari ITP
 * raderar script-skriven lagring efter sju dagars inaktivitet. Persistent storage +
 * hemskärmsikon + serversync är de tre benen; det här är ett av dem.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
