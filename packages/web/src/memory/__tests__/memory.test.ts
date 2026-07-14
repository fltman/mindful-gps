/**
 * 500 km fejkad körning genom hela minnet: skriv → shard → läs tillbaka → exportera →
 * importera → synka.
 *
 * Körs med:  npx tsx --test packages/web/src/memory/__tests__/memory.test.ts
 */

/// <reference types="node" />
// Webbpaketets tsconfig har `types: ["vite/client"]` — utan referensen ovan hittar tsc
// inte node:test. Referensen gäller bara den här filen; appkoden ser fortfarande bara DOM.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encode6, length as pathLength, routeNovelty, todayDay,
  type LngLat, type RawTrace,
} from '@mindful/core';

import { exportMemory, importMemory } from '../export.js';
import { memoryStats } from '../stats.js';
import { type BBox, bboxToShards, shardKey } from '../shards.js';
import { backoffMs, enqueueTrace, syncOutbox } from '../sync.js';
import { VisitedMemory, cellsAlong } from '../visited.js';
import { FakeStore } from './fake-store.js';

const TODAY = todayDay(Date.UTC(2026, 6, 13));
const STEP_M = 25;          // 90 km/h vid 1 Hz — värsta fallet för cellhoppen
const SPEED_MS = 25;

/** En slingrande men i stort nordostlig körning. Deterministisk. */
function drive(start: LngLat, meters: number, seed: number): LngLat[] {
  let state = seed;
  const rnd = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  let [lon, lat] = start;
  let heading = 45;
  const pts: LngLat[] = [[lon, lat]];

  for (let i = 0; i < Math.round(meters / STEP_M); i++) {
    heading += (rnd() - 0.5) * 12 - 0.03 * (heading - 45);   // slingrar, men kommer fram
    const rad = (heading * Math.PI) / 180;
    lat += (STEP_M * Math.cos(rad)) / 111_320;
    lon += (STEP_M * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    pts.push([lon, lat]);
  }
  return pts;
}

function bboxOf(pts: readonly LngLat[]): BBox {
  let minLon = Infinity; let minLat = Infinity;
  let maxLon = -Infinity; let maxLat = -Infinity;
  for (const [lon, lat] of pts) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function traceOf(id: string, pts: readonly LngLat[], startedAt: number): RawTrace {
  return {
    id,
    startedAt,
    endedAt: startedAt + pts.length * 1000,
    mode: 'free',
    polyline6: encode6(pts),
    distanceM: pathLength(pts),
    gaps: [],
    synced: false,
  };
}

/** 500 km i tio turer, skrivna precis som under en riktig körning. */
async function drive500km(store: FakeStore): Promise<{ path: LngLat[]; mem: VisitedMemory }> {
  const path = drive([14.0, 57.0], 500_000, 7);
  const mem = VisitedMemory.open(store);
  const perTrip = Math.floor((path.length - 1) / 10);

  for (let t = 0; t < 10; t++) {
    const leg = path.slice(t * perTrip, (t + 1) * perTrip + 1);
    const speeds = leg.map(() => SPEED_MS);

    // Batcharna är 10-sekunderssvep (§3.4 steg 8), inte hela turen på en gång.
    for (let i = 0; i < leg.length - 1; i += 10) {
      const sweep = leg.slice(i, i + 11);
      await mem.remember(cellsAlong(sweep, speeds.slice(i, i + 11)), TODAY);
      if (i % 100 === 0) await mem.flush();
    }
    await mem.flush();
    await enqueueTrace(store, traceOf(`tur-${t}`, leg, Date.UTC(2026, 6, t + 1)));
  }

  return { path, mem };
}

test('500 km körning: shards sparas, läses tillbaka, och nätet stämmer', async () => {
  const store = new FakeStore();
  const { mem } = await drive500km(store);

  assert.equal(mem.hasUnflushed, false);

  const shards = await store.allShards();
  assert.ok(shards.length > 20, `en 500 km-tur ska röra många res-6-shards, fick ${shards.length}`);

  const stored = shards.reduce((n, s) => n + s.h3.length, 0);
  assert.equal(stored, mem.cellCount);
  // Kontraktets storlekstabell: 500 km ≈ 18 000 celler i res 11.
  assert.ok(stored > 12_000 && stored < 26_000, `oväntat cellantal: ${stored}`);

  // Varje shard är sorterad — annars är binärsökningen i VisitedIndex meningslös.
  for (const s of shards) {
    for (let i = 1; i < s.h3.length; i++) {
      assert.ok((s.h3[i - 1] ?? 0n) < (s.h3[i] ?? 0n), `shard ${s.parent} är osorterad`);
    }
  }

  // Axelmasken ska ha satts: vi körde i 25 m/s, långt över BEARING_MIN_SPEED_MS.
  assert.ok(shards.some((s) => [...s.axisMask].some((m) => m !== 0)));

  const stats = await memoryStats(store);
  assert.equal(stats.tripCount, 10);
  assert.equal(stats.cellCount, stored);
  assert.equal(stats.unsyncedCount, 10);

  // Odometern mäter körd sträcka: 10 turer à 50 km.
  assert.ok(Math.abs(stats.drivenKm - 500) < 5, `drivenKm blev ${stats.drivenKm.toFixed(1)}`);
  // Nätet mäter UNIK väg, ur cellerna. Här är alla 500 km ny väg, så de ska mötas.
  assert.ok(Math.abs(stats.netKm - 500) < 200, `netKm blev ${stats.netKm.toFixed(1)}`);
});

test('nätet växer inte när pendlaren kör samma väg om och om igen', async () => {
  const store = new FakeStore();
  const mem = VisitedMemory.open(store);

  // Samma fyra mil till jobbet, 50 gånger. Odometern rusar. Nätet ska stå still.
  const vagen = drive([15.0, 57.0], 40_000, 3);
  const speeds = vagen.map(() => SPEED_MS);

  for (let t = 0; t < 50; t++) {
    await mem.remember(cellsAlong(vagen, speeds), TODAY);
    await mem.flush();
    await enqueueTrace(store, traceOf(`pendling-${t}`, vagen, Date.UTC(2026, 6, 13) + t * 86_400_000));
  }

  const stats = await memoryStats(store);

  assert.ok(
    stats.drivenKm > 1_900,
    `odometern skulle rusa mot 2 000 km, blev ${stats.drivenKm.toFixed(0)}`,
  );
  assert.ok(
    stats.netKm < 60,
    `nätet skulle stå kvar vid ~40 km, blev ${stats.netKm.toFixed(1)} — ` +
      'summeras odometern gratulerar appen pendlaren för upprepning, ' +
      'vilket är precis det beteende den finns för att bryta',
  );
});

test('en ny session laddar tillbaka exakt samma minne ur shardarna', async () => {
  const store = new FakeStore();
  const { path, mem } = await drive500km(store);

  const fresh = VisitedMemory.open(store);
  await fresh.ensureBBox(bboxOf(path));
  assert.equal(fresh.cellCount, mem.cellCount);

  // bboxToShards måste täcka ALLT som ligger lagrat i bbox:en. En missad shard är
  // minne som tyst försvinner från kartan.
  const covered = new Set(bboxToShards(bboxOf(path)));
  for (const s of await store.allShards()) assert.ok(covered.has(s.parent), `missad shard ${s.parent}`);

  // Den körda vägen är inte ny längre — men en enda genomkörning gör den inte heller
  // helt bekant: 1 - (1 - e^-0,7) = 0,497 är exakt vad kontraktets mättnadskurva säger.
  const driven = path.slice(0, 400);
  const nov = routeNovelty(driven, fresh.index, TODAY);
  assert.ok(nov > 0.44 && nov < 0.51, `nyhet efter en körning: ${nov.toFixed(3)}`);

  const elsewhere = drive([21.0, 64.0], 10_000, 3);
  assert.equal(routeNovelty(elsewhere, fresh.index, TODAY), 1);
});

test('samma väg igen räknas som ett andra besök, inte som fyra', async () => {
  const store = new FakeStore();
  const mem = VisitedMemory.open(store);
  const leg = drive([13.5, 56.5], 3_000, 11);
  const speeds = leg.map(() => SPEED_MS);

  await mem.remember(cellsAlong(leg, speeds), TODAY);
  await mem.flush();

  const visits1 = (await store.allShards()).flatMap((s) => [...s.visits]);
  assert.ok(visits1.every((v) => v === 1), 'en genomkörning ska ge exakt ett besök per cell');

  await mem.remember(cellsAlong(leg, speeds), TODAY);
  await mem.flush();

  const visits2 = (await store.allShards()).flatMap((s) => [...s.visits]);
  assert.ok(visits2.some((v) => v === 2));
  assert.ok(visits2.every((v) => v <= 2), 'densifieringen får inte bokföra samma passage flera gånger');
});

test('export och import ger samma minne — även två gånger', async () => {
  const store = new FakeStore();
  await drive500km(store);

  const file = JSON.parse(JSON.stringify(await exportMemory(store))) as unknown;

  const nyTelefon = new FakeStore();
  const first = await importMemory(nyTelefon, file);
  assert.equal(first.traces, 10);

  const before = await memoryStats(store);
  const after = await memoryStats(nyTelefon);
  assert.equal(after.cellCount, before.cellCount);
  assert.ok(Math.abs(after.netKm - before.netKm) < 0.001);

  // Idempotent: importera samma fil igen ska inte uppfinna körningar som aldrig hände.
  const visitsBefore = (await nyTelefon.allShards()).flatMap((s) => [...s.visits]);
  const second = await importMemory(nyTelefon, file);
  assert.equal(second.traces, 0);
  const visitsAfter = (await nyTelefon.allShards()).flatMap((s) => [...s.visits]);
  assert.deepEqual(visitsAfter, visitsBefore);

  // Och minnet som lästes in fungerar: en fräsch VisitedMemory ovanpå det ser vägen.
  const mem = VisitedMemory.open(nyTelefon);
  await mem.loadAll();
  assert.equal(mem.cellCount, before.cellCount);
});

test('outboxen töms mot servern, och backar av när nätet är nere', async () => {
  const store = new FakeStore();
  await drive500km(store);
  assert.equal((await store.outbox()).length, 10);

  const nere: typeof fetch = async () => new Response('nej', { status: 503 });
  const misslyckat = await syncOutbox(store, { fetch: nere, now: () => 1_000 });
  assert.equal(misslyckat.sent.length, 0);
  assert.equal(misslyckat.failed.length, 10);
  assert.equal(misslyckat.retryInMs, backoffMs(0));

  const köad = await store.outbox();
  assert.ok(köad.every((e) => e.attempts === 1 && e.nextAttemptAt === 1_000 + backoffMs(0)));

  // Innan backoffen löpt ut rör vi inte nätet.
  let anrop = 0;
  const räknare: typeof fetch = async (...args) => {
    anrop++;
    const body = JSON.parse(String((args[1] as RequestInit).body)) as Array<{ id: string }>;
    return Response.json({ accepted: body.map((t) => t.id) });
  };
  const förTidigt = await syncOutbox(store, { fetch: räknare, now: () => 2_000 });
  assert.equal(anrop, 0);
  assert.equal(förTidigt.sent.length, 0);

  const uppe = await syncOutbox(store, { fetch: räknare, now: () => 1_000_000 });
  assert.equal(anrop, 1);
  assert.equal(uppe.sent.length, 10);
  assert.equal((await store.outbox()).length, 0);
  assert.equal((await memoryStats(store)).unsyncedCount, 0);

  // Spåren ligger kvar. Råspåren raderas aldrig.
  assert.equal((await store.allTraces()).length, 10);
});
