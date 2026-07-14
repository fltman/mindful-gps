/**
 * Tystnadsdoktrinen, bevisad.
 *
 * Det viktigaste testet i filen heter "18 km till nästa sväng → INGENTING på 18 km".
 * Det är inte ett kantfall. Det är produkten.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Maneuver, ManeuverModifier, ManeuverType } from '@mindful/core';

import {
  CueQueue, FAR_FAST_M, FAR_M, NOW_M,
  chainsInto, cuesFor, farDistanceM, scheduleRoute,
} from '../schedule.js';

/** `distanceM` är manöverns EGET ben — avståndet fram till nästa manöver. */
function mv(
  type: ManeuverType,
  distanceM: number,
  modifier?: ManeuverModifier,
): Maneuver {
  return {
    type,
    ...(modifier ? { modifier } : {}),
    distanceM,
    timeS: Math.round(distanceM / 20),
    shapeIndex: [0, 1],
  };
}

// ─── Två utrop. Aldrig fler. ────────────────────────────────────────────────

test('CONTRACT §6: max två utrop per manöver', () => {
  const cues = cuesFor(mv('turn', 5000, 'left'), null, 15);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues.map((c) => c.atDistanceM), [FAR_M, NOW_M]);
});

test('den långa cuen flyttas ut till 600 m i landsvägsfart', () => {
  assert.equal(farDistanceM(15), FAR_M);
  assert.equal(farDistanceM(22), FAR_M);        // exakt på gränsen: fortfarande 400
  assert.equal(farDistanceM(25), FAR_FAST_M);   // 90 km/h → 600 m

  const cues = cuesFor(mv('turn', 5000, 'right'), null, 25);
  assert.equal(cues[0]?.atDistanceM, FAR_FAST_M);
  assert.equal(cues[0]?.text, 'Om 600 meter, sväng höger.');
});

test('avfärden har EN cue, inte två', () => {
  const cues = cuesFor(mv('depart', 3000), null, 12);
  assert.equal(cues.length, 1);
  assert.equal(cues[0]?.atDistanceM, 0);
});

test('en tyst manöver får inga cues alls', () => {
  assert.equal(cuesFor(mv('continue', 4000, 'straight'), null, 15).length, 0);
  assert.equal(cuesFor(mv('uturn', 4000), null, 15).length, 0);
  assert.equal(cuesFor(mv('roundabout_exit', 4000), null, 15).length, 0);
});

// ─── Kedjningen ─────────────────────────────────────────────────────────────

test('svängar närmare än 400 m slås ihop till EN cue', () => {
  const vänster = mv('turn', 120, 'left');
  const höger = mv('turn', 3000, 'right');
  assert.ok(chainsInto(vänster, höger));

  const cues = cuesFor(vänster, höger, 15);
  assert.equal(cues.length, 2);
  assert.equal(cues[0]?.text, 'Om 400 meter, sväng vänster, sedan direkt höger.');
  assert.equal(cues[1]?.text, 'Vänster, sedan direkt höger.');
});

test('svängar längre isär än 400 m kedjas inte', () => {
  assert.equal(chainsInto(mv('turn', 900, 'left'), mv('turn', 3000, 'right')), false);
});

test('den kedjade manövern öppnar aldrig munnen igen', () => {
  const rutt = [
    mv('depart', 2000),
    mv('turn', 120, 'left'),    // kedjar in i nästa
    mv('turn', 5000, 'right'),  // ...och tiger därför själv
    mv('arrive', 0),
  ];
  const cues = scheduleRoute(rutt, 15);

  // start + (långt, nu) för vänstern + (långt, nu) för framkomsten. Högern: noll.
  assert.equal(cues.filter((c) => c.maneuverIndex === 2).length, 0);
  assert.ok(cues.some((c) => c.text === 'Vänster, sedan direkt höger.'));
});

test('avfärden kedjar aldrig — annars ligger enda cuen i backspegeln', () => {
  assert.equal(chainsInto(mv('depart', 80), mv('turn', 3000, 'left')), false);

  const cues = scheduleRoute([mv('depart', 80), mv('turn', 3000, 'left'), mv('arrive', 0)], 12);
  const svängen = cues.filter((c) => c.maneuverIndex === 1);
  assert.equal(svängen.length, 2, 'svängen måste få sina egna två cues');
});

test('en tyst manöver mellan två svängar räknas ändå in i avståndet', () => {
  // 100 m + 900 m = 1 km mellan svängarna, trots att "fortsätt rakt fram" ligger emellan.
  // Utan att räkna dess ben hade de sett ut att ligga 100 m isär och felaktigt kedjats.
  const rutt = [
    mv('depart', 2000),
    mv('turn', 100, 'left'),
    mv('continue', 900, 'straight'),
    mv('turn', 5000, 'right'),
    mv('arrive', 0),
  ];
  const cues = scheduleRoute(rutt, 15);
  assert.ok(!cues.some((c) => c.text.includes('sedan direkt')), 'fick inte kedjas');
  assert.equal(cues.filter((c) => c.maneuverIndex === 3).length, 2, 'högern ska säga sitt');
});

// ─── ⛔ TYSTNADEN ───────────────────────────────────────────────────────────

test('⛔ 18 km till nästa sväng → appen säger INGENTING på 18 km', () => {
  const rutt = [mv('depart', 18_000), mv('turn', 2000, 'left'), mv('arrive', 0)];
  const kö = new CueQueue(scheduleRoute(rutt, 25));

  // Avfärden.
  assert.equal(kö.due(0, 0).length, 1);

  // 18 km ner till 601 m. En cue per 100 m — och inte ett ord.
  let utrop = 0;
  for (let kvar = 18_000; kvar > FAR_FAST_M; kvar -= 100) {
    utrop += kö.due(1, kvar).length;
  }
  assert.equal(utrop, 0, 'appen sa något under 18 km tystnad');

  // Först vid 600 m öppnar den munnen. Sedan tystnad igen ända ner till 40 m.
  assert.deepEqual(kö.due(1, 600).map((c) => c.text), ['Om 600 meter, sväng vänster.']);
  for (let kvar = 500; kvar > NOW_M; kvar -= 20) {
    assert.equal(kö.due(1, kvar).length, 0, `sa något vid ${kvar} m`);
  }
  assert.deepEqual(kö.due(1, 30).map((c) => c.text), ['Vänster.']);
});

test('varje cue sägs exakt en gång', () => {
  const kö = new CueQueue(scheduleRoute([mv('depart', 5000), mv('turn', 2000, 'left')], 15));
  kö.due(0, 0);
  kö.due(1, 1000);
  assert.equal(kö.due(1, 390).length, 1);
  assert.equal(kö.due(1, 380).length, 0);
  assert.equal(kö.due(1, 370).length, 0);
});

test('ARMERING: en cue vi aldrig varit längre bort än sägs aldrig', () => {
  // Navigeringen startar 150 m från svängen. "Om 400 meter" vore en ren lögn.
  const kö = new CueQueue(scheduleRoute([mv('depart', 150), mv('turn', 2000, 'left')], 12));
  kö.due(0, 0);

  assert.equal(kö.due(1, 150).length, 0, 'sa "om 400 meter" fast vi bara hade 150 m kvar');
  assert.deepEqual(kö.due(1, 35).map((c) => c.text), ['Vänster.']);
});

test('båda cuerna förfaller på samma fix → BARA den närmaste sägs', () => {
  // Svag GPS: ett hopp från 500 m till 20 m. Två utrop i rad är precis vad doktrinen
  // förbjuder — den korta vinner, för den är den enda som fortfarande är sann.
  const kö = new CueQueue(scheduleRoute([mv('depart', 3000), mv('turn', 2000, 'right')], 20));
  kö.due(0, 0);
  kö.due(1, 500);

  const sagt = kö.due(1, 20);
  assert.equal(sagt.length, 1);
  assert.equal(sagt[0]?.text, 'Höger.');
});

test('en passerad manöver sägs aldrig i efterhand', () => {
  const kö = new CueQueue(scheduleRoute(
    [mv('depart', 3000), mv('turn', 2000, 'left'), mv('turn', 2000, 'right')],
    15,
  ));
  kö.due(0, 0);
  kö.due(1, 1000);

  // Vi hoppar rakt till nästa manöver utan att någon cue för den förra hann bli sagd.
  const sagt = kö.due(2, 1500);
  assert.equal(sagt.length, 0);

  // ...och vänstern får inte komma tillbaka och spöka senare heller.
  assert.ok(!kö.due(2, 390).some((c) => c.text.includes('vänster')));
});

test('reset: ny rutt, ny tystnad', () => {
  const kö = new CueQueue(scheduleRoute([mv('depart', 3000), mv('turn', 2000, 'left')], 15));
  kö.due(0, 0);
  kö.due(1, 1000);
  assert.equal(kö.due(1, 390).length, 1);

  kö.reset();
  assert.equal(kö.due(0, 0).length, 1, 'avfärden ska kunna sägas igen');
  kö.due(1, 1000);
  assert.equal(kö.due(1, 390).length, 1);
});

// ─── Budgeten ───────────────────────────────────────────────────────────────

test('en hel rutt håller sig under två utrop per talbar manöver', () => {
  const rutt = [
    mv('depart', 1200),
    mv('turn', 3000, 'left'),
    mv('continue', 2000, 'straight'),
    mv('roundabout_enter', 800),
    mv('roundabout_exit', 1500),
    mv('fork', 4000, 'slight_right'),
    mv('ferry', 6000),
    mv('turn', 900, 'right'),
    mv('arrive', 0),
  ];
  const cues = scheduleRoute(rutt, 18);

  const perManöver = new Map<number, number>();
  for (const c of cues) perManöver.set(c.maneuverIndex, (perManöver.get(c.maneuverIndex) ?? 0) + 1);

  for (const [i, n] of perManöver) {
    assert.ok(n <= 2, `manöver ${i} fick ${n} utrop`);
  }
  // De tysta har inte en enda.
  assert.equal(perManöver.get(2), undefined);
  assert.equal(perManöver.get(4), undefined);
  // Och ingen cue är tom.
  for (const c of cues) assert.ok(c.text.length > 0, `tom cue: ${JSON.stringify(c)}`);
});
