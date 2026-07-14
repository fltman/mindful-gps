/**
 * Sync — outbox → servern, och servern → en ny telefon (CONTRACT §3.6).
 *
 * Det här är ett ÖVERLEVNADSKRAV, inte en optimering. Safari ITP raderar all
 * script-skriven lagring efter sju dagars inaktivitet. En användare som kör i maj,
 * lägger telefonen i en låda över sommaren och öppnar appen i augusti har inget minne
 * kvar — om vi inte skickat upp det. Nätet är det enda användaren inte kan bygga om.
 *
 * Kontraktet:
 *   POST /api/traces   body: RawTrace[] (utan `synced`) → 200 { accepted: string[] }
 *   GET  /api/memory?bbox=minLon,minLat,maxLon,maxLat
 *                      → 200 { cells: Array<[h3hex, visits, lastSeenDay, axisMask]> }
 *
 * Båda anropen bär `X-Device-Id`. Det står inte i §3.6 — men servern har ingen
 * inloggning i v1, och utan enheten vet den inte VEMS nät den bokför. Nyckeln finns
 * redan i kontraktets meta-store ('deviceId'), så det är ingen ny idé, bara den
 * saknade halvan av en.
 */

import type { RawTrace } from '@mindful/core';

import type { MemoryStore, OutboxEntry } from './db.js';
import { type BBox, cellsToShards, mergeShardsInto, parseCellTuples } from './shards.js';

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** Hur ofta vi tittar efter en förfallen outbox-post medan appen är öppen. */
export const SYNC_POLL_MS = 60_000;

export interface SyncOptions {
  /** Tom sträng = samma origin. Servern ligger bakom /api. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface SyncResult {
  readonly sent: string[];
  readonly failed: string[];
  /** ms till nästa försök, eller null när kön är tom. */
  readonly retryInMs: number | null;
}

/** Exponentiell backoff på misslyckade försök: 5 s, 10 s, 20 s … tak 15 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts));
}

/** Lägg ett avslutat spår i lagringen och i kön. */
export async function enqueueTrace(store: MemoryStore, trace: RawTrace): Promise<void> {
  await store.putTrace(trace);
  if (!trace.synced) await store.enqueue(trace.id);
}

/**
 * Enhetens uuid — användarens identitet tills konton finns (Fas 3).
 *
 * Genereras vid första synken och ändras sedan aldrig: byter den värde blir turerna
 * en ny enhets turer, och nätet på servern delas i två. Därför skrivs den en gång och
 * läses för alltid.
 */
export async function deviceId(store: MemoryStore): Promise<string> {
  const sparad = await store.getMeta('deviceId');
  if (typeof sparad === 'string' && sparad.length > 0) return sparad;

  const färsk = crypto.randomUUID();
  await store.setMeta('deviceId', färsk);
  return färsk;
}

interface AcceptedResponse {
  readonly accepted?: unknown;
}

function acceptedIds(body: unknown): string[] {
  const accepted = (body as AcceptedResponse | null)?.accepted;
  if (!Array.isArray(accepted)) return [];
  return accepted.filter((id): id is string => typeof id === 'string');
}

/**
 * Töm outboxen. Idempotent — servern får se samma spår två gånger, `accepted` avgör.
 *
 * Alla förfallna spår går i ETT anrop. Misslyckas det räknas backoffen upp för dem
 * allihop; det är samma nätverk som gick ner för dem allihop.
 */
export async function syncOutbox(
  store: MemoryStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now?.() ?? Date.now();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl ?? '';

  const queue = await store.outbox();
  if (queue.length === 0) return { sent: [], failed: [], retryInMs: null };

  const due = queue.filter((e) => e.nextAttemptAt <= now);
  if (due.length === 0) {
    const soonest = Math.min(...queue.map((e) => e.nextAttemptAt));
    return { sent: [], failed: [], retryInMs: Math.max(0, soonest - now) };
  }

  const traces: RawTrace[] = [];
  const orphans: string[] = [];
  for (const entry of due) {
    const trace = await store.getTrace(entry.traceId);
    if (trace) traces.push(trace);
    else orphans.push(entry.traceId);
  }
  if (orphans.length > 0) await store.dropOutbox(orphans);
  if (traces.length === 0) return { sent: [], failed: [], retryInMs: null };

  const body = traces.map(({ synced: _synced, ...rest }) => rest);

  let accepted: string[] = [];
  try {
    const res = await doFetch(`${base}/api/traces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': await deviceId(store),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /api/traces: ${res.status}`);
    accepted = acceptedIds(await res.json());
  } catch {
    accepted = [];
  }

  const sent = new Set(accepted);
  const failed: string[] = [];
  let soonestRetry = Number.POSITIVE_INFINITY;

  if (sent.size > 0) await store.markTracesSynced([...sent]);

  for (const entry of due) {
    if (sent.has(entry.traceId) || orphans.includes(entry.traceId)) continue;
    failed.push(entry.traceId);

    const wait = backoffMs(entry.attempts);
    soonestRetry = Math.min(soonestRetry, wait);

    const next: OutboxEntry = {
      traceId: entry.traceId,
      attempts: entry.attempts + 1,
      nextAttemptAt: now + wait,
    };
    await store.putOutbox(next);
  }

  if (sent.size > 0) await store.setMeta('lastSync', now);

  return {
    sent: [...sent],
    failed,
    retryInMs: Number.isFinite(soonestRetry) ? soonestRetry : null,
  };
}

/**
 * Starta synken: vid appstart, när nätet kommer tillbaka, och medan appen är öppen.
 * Efter en avslutad tur anropar turen `syncOutbox` själv — den ska inte vänta på en poll.
 *
 * Returnerar en avslutare.
 */
export function startSync(store: MemoryStore, opts: SyncOptions = {}): () => void {
  let stopped = false;

  const run = (): void => {
    if (stopped) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void syncOutbox(store, opts);
  };

  run();
  const timer = setInterval(run, SYNC_POLL_MS);
  globalThis.addEventListener?.('online', run);

  return () => {
    stopped = true;
    clearInterval(timer);
    globalThis.removeEventListener?.('online', run);
  };
}

/**
 * Hämta tillbaka minnet från servern och bygg om shardarna.
 *
 * Ny telefon, eller en ITP-radering. Sammanslagningen är `mergeShard`s max-regel, så
 * en återställning kan köras hur många gånger som helst utan att uppfinna körningar
 * som aldrig ägde rum.
 *
 * Returnerar antalet celler servern hade i bbox:en.
 */
export async function restoreFromServer(
  store: MemoryStore,
  bbox: BBox,
  opts: SyncOptions = {},
): Promise<number> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.baseUrl ?? '';

  const res = await doFetch(`${base}/api/memory?bbox=${bbox.join(',')}`, {
    headers: { 'x-device-id': await deviceId(store) },
  });
  if (!res.ok) throw new Error(`GET /api/memory: ${res.status}`);

  const body = (await res.json()) as { cells?: unknown } | null;
  const cells = parseCellTuples(body?.cells);
  if (cells.length === 0) return 0;

  await mergeShardsInto(store, cellsToShards(cells));
  return cells.length;
}
