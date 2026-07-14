/**
 * Nyhetsminnet — appens själ som data.
 *
 * Resten av appen rör aldrig IndexedDB direkt. Den öppnar minnet här, frågar `index`
 * om nyhet (matten bor i @mindful/core), och lägger avslutade turer i kön.
 */

export {
  DB_NAME, DB_VERSION, idbStore, openMemoryDb, requestPersistentStorage,
  type MemoryStore, type MetaKey, type MindfulDB, type MindfulSchema, type OutboxEntry,
} from './db.js';

export {
  bboxToShards, cellTuple, cellsToShards, loadShards, mergeShard, mergeShardsInto,
  parseCellTuples, saveShards, shardCells, shardKey,
  type BBox, type CellTuple,
} from './shards.js';

export { VisitedMemory, cellsAlong } from './visited.js';

export {
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, SYNC_POLL_MS,
  backoffMs, deviceId, enqueueTrace, restoreFromServer, startSync, syncOutbox,
  type SyncOptions, type SyncResult,
} from './sync.js';

export {
  EXPORT_VERSION, downloadMemory, exportMemory, importMemory, importMemoryFile,
  type ImportResult, type MemoryExport,
} from './export.js';

export { memoryStats, type MemoryStats } from './stats.js';
