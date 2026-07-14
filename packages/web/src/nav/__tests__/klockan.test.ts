/// <reference types="node" />

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ankomstMening, klockslagIOrd } from '../klockan.sv.js';

/** Lokal tid — meningen läses av en förare i en bil, inte av en server i UTC. */
const kl = (h: number, m: number): Date => new Date(2026, 6, 14, h, m, 0, 0);

test('kvarten sägs som man säger den', () => {
  assert.equal(klockslagIOrd(kl(19, 0)), 'sju');
  assert.equal(klockslagIOrd(kl(19, 15)), 'kvart över sju');
  assert.equal(klockslagIOrd(kl(19, 45)), 'kvart i åtta');
});

test('halv pekar FRAMÅT: 19.30 är halv åtta, inte halv sju', () => {
  assert.equal(klockslagIOrd(kl(19, 30)), 'halv åtta');
  assert.equal(klockslagIOrd(kl(7, 30)), 'halv åtta');
});

test('timmen rundas till närmaste kvart', () => {
  assert.equal(klockslagIOrd(kl(19, 7)), 'sju');             // 7 min → nedåt
  assert.equal(klockslagIOrd(kl(19, 8)), 'kvart över sju');  // 8 min → uppåt
  assert.equal(klockslagIOrd(kl(19, 52)), 'kvart i åtta');   // närmare 19.45 än 20.00
  assert.equal(klockslagIOrd(kl(19, 53)), 'åtta');           // rundas över timskiftet
});

test('tolvtimmars: midnatt och middag heter tolv, inte noll', () => {
  assert.equal(klockslagIOrd(kl(0, 0)), 'tolv');
  assert.equal(klockslagIOrd(kl(12, 0)), 'tolv');
  assert.equal(klockslagIOrd(kl(12, 30)), 'halv ett');
  assert.equal(klockslagIOrd(kl(0, 45)), 'kvart i ett');
});

test('meningen', () => {
  assert.equal(ankomstMening(kl(19, 15), 'Kalmar'), 'Du är framme i Kalmar cirka kvart över sju.');
  // En slinga har inget mål att vara framme *i*.
  assert.equal(ankomstMening(kl(19, 30), null), 'Du är framme cirka halv åtta.');
});

test('ingen siffra, ingen kolon, ingen sekund — någonsin', () => {
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const s = ankomstMening(kl(h, m), 'Kalmar');
      assert.ok(!/\d/u.test(s), `${h}:${m} gav en siffra: ${s}`);
      assert.ok(!s.includes(':'), `${h}:${m} gav ett kolon: ${s}`);
    }
  }
});
