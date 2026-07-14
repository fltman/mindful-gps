/**
 * Kopplingen mellan sinnena och den riktiga lagringen.
 *
 * Hela beroendet till minnesmodulen bor här. Recordern ser bara `RecorderMemory` och vet
 * ingenting om shards, outbox eller IndexedDB.
 *
 * `visited` är en getter och inte ett värde: `VisitedMemory` byter ut hela sitt
 * `VisitedIndex` när nya shards läses in, och en sparad referens hade tyst blivit ett
 * gammalt minne — vi hade då kallat väg vi faktiskt kört för ny.
 *
 * Skalet får `store` och `nät` med på köpet. Det är avsiktligt: statistiken, spindelnätet
 * och sync-kön behöver samma lagring som recordern skriver till. Öppnade de databasen
 * själva hade det funnits två `VisitedMemory` med var sitt `VisitedIndex` — det ena
 * uppdaterat, det andra inte — och appen hade mints olika saker beroende på vem man frågar.
 */

import { idbStore, openMemoryDb, type MemoryStore } from '../memory/db.js';
import { enqueueTrace } from '../memory/sync.js';
import { VisitedMemory } from '../memory/visited.js';

import type { RecorderMemory } from './memory.js';

export interface IdbMemory extends RecorderMemory {
  /** Lagringen. Skalet läser statistik, spår och sync-kö ur den. */
  readonly store: MemoryStore;
  /** Nyhetsminnet i RAM. Skalet läser in det INNAN en tur börjar — se `app/state.ts`. */
  readonly nät: VisitedMemory;
}

export async function idbMemory(): Promise<IdbMemory> {
  const store = idbStore(await openMemoryDb());
  const nät = VisitedMemory.open(store);

  return {
    store,
    nät,

    get visited() {
      return nät.index;
    },

    async commitVisits(batch, day) {
      await nät.remember(batch, day);
      await nät.flush();
    },

    // Spåret läggs samtidigt i sync-kön. Ett spår som bara finns på telefonen är ett spår
    // som försvinner med telefonen.
    putTrace: (trace) => enqueueTrace(store, trace),
  };
}
