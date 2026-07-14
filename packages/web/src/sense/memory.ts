/**
 * Sinnenas fönster mot minnet.
 *
 * Recordern behöver exakt tre saker av minnesmodulen, och ska inte veta mer än så. Allt
 * som är IndexedDB, shards och sync ligger på andra sidan `RecorderMemory`.
 *
 * Portens andra syfte: `ephemeralMemory()` gör det möjligt att köra hela skrivvägen —
 * simulator → grind → densifiering → H3 → nyhet — utan lagring alls. Det är så man
 * felsöker recordern utan att först rensa en databas.
 */

import { VisitedIndex, type CellVisit, type RawTrace } from '@mindful/core';

export interface RecorderMemory {
  /** Det levande nyhetsminnet. Svarar på "har jag varit här förut?". */
  readonly visited: VisitedIndex;
  /** En batch passerade celler (CONTRACT §3.4 steg 8: var tionde sekund, aldrig per fix). */
  commitVisits(batch: readonly CellVisit[], day: number): Promise<void>;
  /** Råspåret. Sanningen. Raderas aldrig. */
  putTrace(trace: RawTrace): Promise<void>;
}

/**
 * Minne utan lagring: cellerna hamnar i ett `VisitedIndex` som lever så länge fliken gör
 * det, och spåret kastas. För simulator och felsökning — aldrig i en riktig körning.
 */
export function ephemeralMemory(): RecorderMemory {
  const visited = VisitedIndex.empty();
  return {
    visited,
    commitVisits: async (batch, day) => {
      visited.upsert(batch, day);
    },
    putTrace: async () => {},
  };
}
