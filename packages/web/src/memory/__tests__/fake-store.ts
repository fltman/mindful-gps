/**
 * En MemoryStore i RAM. Node har ingen IndexedDB, och ett minne som bara går att testa
 * i en webbläsare blir i praktiken otestat.
 *
 * Den kopierar allt som skrivs och allt som läses, precis som IndexedDB gör (structured
 * clone). Utan kopian hade testet delat typade arrayer med koden det testar, och en bugg
 * där vi skriver en vy i stället för en kopia hade inte synts.
 */

import type { RawTrace, VisitedShard } from '@mindful/core';
import type { MemoryStore, MetaKey, OutboxEntry } from '../db.js';

const cloneShard = (s: VisitedShard): VisitedShard => ({
  parent: s.parent,
  h3: s.h3.slice(),
  visits: s.visits.slice(),
  lastSeenDay: s.lastSeenDay.slice(),
  axisMask: s.axisMask.slice(),
});

export class FakeStore implements MemoryStore {
  readonly shards = new Map<string, VisitedShard>();
  readonly traces = new Map<string, RawTrace>();
  readonly queue = new Map<string, OutboxEntry>();
  readonly meta = new Map<MetaKey, unknown>();

  async getShard(parent: string): Promise<VisitedShard | undefined> {
    const s = this.shards.get(parent);
    return s ? cloneShard(s) : undefined;
  }

  async putShards(shards: readonly VisitedShard[]): Promise<void> {
    for (const s of shards) this.shards.set(s.parent, cloneShard(s));
  }

  async allShards(): Promise<VisitedShard[]> {
    return [...this.shards.values()].map(cloneShard);
  }

  async getTrace(id: string): Promise<RawTrace | undefined> {
    return this.traces.get(id);
  }

  async putTrace(trace: RawTrace): Promise<void> {
    this.traces.set(trace.id, { ...trace });
  }

  async allTraces(): Promise<RawTrace[]> {
    return [...this.traces.values()];
  }

  async markTracesSynced(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const t = this.traces.get(id);
      if (t) this.traces.set(id, { ...t, synced: true });
      this.queue.delete(id);
    }
  }

  async enqueue(traceId: string): Promise<void> {
    if (!this.queue.has(traceId)) {
      this.queue.set(traceId, { traceId, attempts: 0, nextAttemptAt: 0 });
    }
  }

  async outbox(): Promise<OutboxEntry[]> {
    return [...this.queue.values()];
  }

  async putOutbox(entry: OutboxEntry): Promise<void> {
    this.queue.set(entry.traceId, entry);
  }

  async dropOutbox(traceIds: readonly string[]): Promise<void> {
    for (const id of traceIds) this.queue.delete(id);
  }

  async getMeta(key: MetaKey): Promise<unknown> {
    return this.meta.get(key);
  }

  async setMeta(key: MetaKey, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }
}
