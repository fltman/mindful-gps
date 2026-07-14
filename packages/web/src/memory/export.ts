/**
 * Nödutgången.
 *
 * Hela minnet i en JSON-fil användaren äger själv: råspåren och cellerna. Den kan läsas
 * in igen, på vilken telefon som helst, utan server och utan konto. Ett minne man inte
 * kan ta med sig är ett minne man har lånat.
 *
 * Cellformatet är samma tupel som `GET /api/memory` (§3.6) — ett format i systemet,
 * inte två.
 */

import type { RawTrace } from '@mindful/core';

import type { MemoryStore } from './db.js';
import {
  type CellTuple, cellTuple, cellsToShards, mergeShardsInto, parseCellTuples, shardCells,
} from './shards.js';

export const EXPORT_VERSION = 1;

export interface MemoryExport {
  readonly version: number;
  readonly exportedAt: string;      // ISO 8601
  readonly deviceId: string | null;
  readonly traces: readonly RawTrace[];
  readonly cells: readonly CellTuple[];
}

export async function exportMemory(store: MemoryStore): Promise<MemoryExport> {
  const [traces, shards, deviceId] = await Promise.all([
    store.allTraces(),
    store.allShards(),
    store.getMeta('deviceId'),
  ]);

  const cells: CellTuple[] = [];
  for (const shard of shards) {
    for (const c of shardCells(shard)) cells.push(cellTuple(c));
  }

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    deviceId: typeof deviceId === 'string' ? deviceId : null,
    traces,
    cells,
  };
}

function fileName(now: Date): string {
  const d = now.toISOString().slice(0, 10);
  return `mindful-gps-${d}.json`;
}

/** Exporten som en nedladdad fil. */
export async function downloadMemory(store: MemoryStore): Promise<void> {
  const data = await exportMemory(store);
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(new Date());
  a.click();

  URL.revokeObjectURL(url);
}

function isTrace(v: unknown): v is RawTrace {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t['id'] === 'string'
    && typeof t['startedAt'] === 'number'
    && typeof t['endedAt'] === 'number'
    && typeof t['polyline6'] === 'string'
    && typeof t['distanceM'] === 'number'
    && Array.isArray(t['gaps']);
}

export interface ImportResult {
  readonly traces: number;
  readonly cells: number;
}

/**
 * Läs in en exportfil.
 *
 * Sammanslagningen är max på besök, inte summa — att importera sin egen fil två gånger
 * ska ge samma minne, inte ett dubbelt så välkört. Spår som redan finns rörs inte;
 * spår som inte är synkade läggs i kön.
 */
export async function importMemory(store: MemoryStore, data: unknown): Promise<ImportResult> {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Filen är inte ett giltigt minne.');
  }
  const doc = data as Record<string, unknown>;
  if (doc['version'] !== EXPORT_VERSION) {
    throw new Error(`Okänd exportversion: ${String(doc['version'])}`);
  }

  const traces = Array.isArray(doc['traces']) ? doc['traces'].filter(isTrace) : [];
  let written = 0;
  for (const trace of traces) {
    if (await store.getTrace(trace.id)) continue;
    await store.putTrace(trace);
    if (!trace.synced) await store.enqueue(trace.id);
    written++;
  }

  const cells = parseCellTuples(doc['cells']);
  if (cells.length > 0) await mergeShardsInto(store, cellsToShards(cells));

  return { traces: written, cells: cells.length };
}

/** Fil från en `<input type="file">` → inläst minne. */
export async function importMemoryFile(store: MemoryStore, file: File): Promise<ImportResult> {
  return importMemory(store, JSON.parse(await file.text()) as unknown);
}
