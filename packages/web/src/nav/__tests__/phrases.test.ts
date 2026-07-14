/**
 * Svenskan. Det här testet är inte bara ett korrekthetstest — det är TONEN, låst i kod.
 * Varje mening som produkten säger högt står i en assertion här.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Maneuver, ManeuverModifier, ManeuverType } from '@mindful/core';

import {
  curtPhrase, farText, isSilent, maneuverPhrase, nowText,
  offRouteText, roadLabel, spokenDistance, startText,
} from '../phrases.sv.js';

function mv(
  type: ManeuverType,
  extra: {
    modifier?: ManeuverModifier;
    streetName?: string;
    streetRef?: string;
    roundaboutExit?: number;
    distanceM?: number;
  } = {},
): Maneuver {
  return {
    type,
    ...(extra.modifier !== undefined ? { modifier: extra.modifier } : {}),
    ...(extra.streetName !== undefined ? { streetName: extra.streetName } : {}),
    ...(extra.streetRef !== undefined ? { streetRef: extra.streetRef } : {}),
    ...(extra.roundaboutExit !== undefined ? { roundaboutExit: extra.roundaboutExit } : {}),
    distanceM: extra.distanceM ?? 1000,
    timeS: 60,
    shapeIndex: [0, 1],
  };
}

// ─── roadLabel ──────────────────────────────────────────────────────────────

test('roadLabel: europaväg säges som sitt nummer', () => {
  assert.equal(roadLabel(mv('turn', { streetRef: 'E22' })), 'E22');
  assert.equal(roadLabel(mv('turn', { streetRef: 'E4' })), 'E4');
  // OSM skriver ofta "E 22" med mellanslag. Mellanslaget betyder ingenting.
  assert.equal(roadLabel(mv('turn', { streetRef: 'E 22' })), 'E22');
});

test('roadLabel: riksväg och länsväg får ordet "väg" framför sig', () => {
  assert.equal(roadLabel(mv('turn', { streetRef: '27' })), 'väg 27');
  assert.equal(roadLabel(mv('turn', { streetRef: '9' })), 'väg 9');
  assert.equal(roadLabel(mv('turn', { streetRef: '641' })), 'väg 641');
  assert.equal(roadLabel(mv('turn', { streetRef: '1234' })), 'väg 1234');
});

test('roadLabel: ref vinner över name — det är skylten föraren ser', () => {
  const m = mv('turn', { streetRef: '27', streetName: 'Växjövägen' });
  assert.equal(roadLabel(m), 'väg 27');
});

test('roadLabel: namn används när ref saknas', () => {
  assert.equal(roadLabel(mv('turn', { streetName: 'Storgatan' })), 'Storgatan');
});

test('roadLabel: ett ref vi inte förstår faller tillbaka på namnet', () => {
  // "27;E22" är en vanlig OSM-konstruktion. Rösten ska inte försöka läsa upp den.
  const m = mv('turn', { streetRef: '27;E22', streetName: 'Storgatan' });
  assert.equal(roadLabel(m), 'Storgatan');
});

test('roadLabel: utan ref och utan namn säger vi ingenting om vägen', () => {
  assert.equal(roadLabel(mv('turn')), null);
});

// ─── Manövern ───────────────────────────────────────────────────────────────

test('sväng utan vägnamn är en hel mening ändå', () => {
  const m = mv('turn', { modifier: 'left' });
  assert.equal(maneuverPhrase(m), 'sväng vänster');
  assert.equal(nowText(m, null), 'Vänster.');
});

test('sväng med vägnamn', () => {
  const m = mv('turn', { modifier: 'left', streetRef: '27' });
  assert.equal(maneuverPhrase(m), 'sväng vänster på väg 27');
});

test('rondell: tredje avfarten', () => {
  const m = mv('roundabout_enter', { roundaboutExit: 3 });
  assert.equal(maneuverPhrase(m), 'ta tredje avfarten i rondellen');
  assert.equal(curtPhrase(m), 'tredje avfarten i rondellen');
});

test('rondellen nämner ALDRIG vägnamnet — Valhalla ger rondellens eget namn där', () => {
  // Verifierat mot riktig Valhalla, Växjö→Kalmar: manövern bär "Fagrabäcksrondellen".
  // "in på Fagrabäcksrondellen" vore nonsens. Avfartsnumret är hela instruktionen.
  const m = mv('roundabout_enter', { roundaboutExit: 2, streetName: 'Fagrabäcksrondellen' });
  assert.equal(maneuverPhrase(m), 'ta andra avfarten i rondellen');
  assert.ok(!maneuverPhrase(m)?.includes('Fagrabäck'));
});

test('färjan är vacker och får ingen avståndsbestämning i sig', () => {
  assert.equal(maneuverPhrase(mv('ferry')), 'kör ombord på färjan');
});

test('tysta manövrar säger ingenting', () => {
  assert.ok(isSilent(mv('continue')));
  assert.ok(isSilent(mv('roundabout_exit')));
  assert.ok(isSilent(mv('uturn')));
  assert.equal(curtPhrase(mv('uturn')), null);
});

test('⛔ frasen "gör en U-sväng när det är möjligt" finns inte', () => {
  const u = mv('uturn', { modifier: 'sharp_left', streetRef: '27' });
  assert.equal(maneuverPhrase(u), null);
  assert.equal(curtPhrase(u), null);
  assert.equal(nowText(u, null), '');
  assert.equal(farText(u, null, 400), '');
});

test('framkomsten är ett konstaterande, inte en gratulation', () => {
  assert.equal(nowText(mv('arrive'), null), 'Framme.');
  assert.equal(farText(mv('arrive'), null, 400), 'Om 400 meter är vi framme.');
});

// ─── Avståndet ──────────────────────────────────────────────────────────────

test('spokenDistance: hela ord, aldrig "m"', () => {
  assert.equal(spokenDistance(400), '400 meter');
  assert.equal(spokenDistance(38), '40 meter');
  assert.equal(spokenDistance(600), '600 meter');
  assert.equal(spokenDistance(1000), 'en kilometer');
  assert.equal(spokenDistance(1500), '1,5 kilometer');
  assert.equal(spokenDistance(2000), '2 kilometer');
});

test('spokenDistance: svenskt decimalkomma, aldrig punkt', () => {
  assert.ok(spokenDistance(1500).includes(','));
  assert.ok(!spokenDistance(1500).includes('.'));
});

// ─── Meningarna ─────────────────────────────────────────────────────────────

test('startText: avfärden', () => {
  assert.equal(startText(mv('depart', { streetRef: '27' })), 'Kör ut på väg 27.');
  assert.equal(startText(mv('depart')), 'Kör iväg.');
});

test('farText: den långa cuen nämner vägen', () => {
  const m = mv('turn', { modifier: 'left', streetRef: '27' });
  assert.equal(farText(m, null, 400), 'Om 400 meter, sväng vänster på väg 27.');
});

test('kedjad cue: "Vänster, sedan direkt höger."', () => {
  const vänster = mv('turn', { modifier: 'left' });
  const höger = mv('turn', { modifier: 'right' });
  assert.equal(nowText(vänster, höger), 'Vänster, sedan direkt höger.');
  assert.equal(
    farText(vänster, höger, 400),
    'Om 400 meter, sväng vänster, sedan direkt höger.',
  );
});

test('kedjad cue mot framkomst', () => {
  const m = mv('turn', { modifier: 'right', streetName: 'Storgatan' });
  assert.equal(nowText(m, mv('arrive')), 'Höger, sedan är vi framme.');
});

test('ingen mening saknar punkt, och ingen börjar med gemen', () => {
  const meningar = [
    startText(mv('depart', { streetRef: 'E22' })),
    farText(mv('turn', { modifier: 'right' }), null, 400),
    nowText(mv('turn', { modifier: 'sharp_left' }), null),
    nowText(mv('roundabout_enter', { roundaboutExit: 1 }), null),
  ];
  for (const s of meningar) {
    assert.ok(s.endsWith('.'), `saknar punkt: ${s}`);
    assert.equal(s[0], s[0]?.toLocaleUpperCase('sv-SE'), `börjar gement: ${s}`);
  }
});

test('rösten stressar aldrig: inga förbjudna ord någonstans i ordförrådet', () => {
  const förbjudet = /u-sväng|vänd|omedelbart|snabbast|du sparar|fel väg|omberäkn/i;
  const alla: string[] = [];
  const typer: ManeuverType[] = [
    'depart', 'continue', 'turn', 'fork', 'merge',
    'roundabout_enter', 'roundabout_exit', 'uturn', 'ferry', 'exit', 'arrive',
  ];
  const mods: (ManeuverModifier | undefined)[] = [
    undefined, 'sharp_left', 'left', 'slight_left', 'straight',
    'slight_right', 'right', 'sharp_right',
  ];

  for (const t of typer) {
    for (const mod of mods) {
      const m = mv(t, { ...(mod ? { modifier: mod } : {}), streetRef: '27', roundaboutExit: 2 });
      alla.push(farText(m, null, 400), nowText(m, null), startText(m));
    }
  }
  alla.push(offRouteText(true, 0) ?? '', offRouteText(true, 1) ?? '', offRouteText(true, 2) ?? '');

  for (const s of alla) {
    assert.ok(!förbjudet.test(s), `stressig fras: ${s}`);
  }
});

// ─── Avvikelsen ─────────────────────────────────────────────────────────────

test('känd väg → TYSTNAD. Att inte gnälla betyder också att inte kommentera', () => {
  assert.equal(offRouteText(false, 0), null);
  assert.equal(offRouteText(false, 7), null);
});

test('okänd väg → varm ton', () => {
  assert.equal(offRouteText(true, 0), 'Fint val. Den där har du inte kört.');
});

test('formuleringen varieras så att den inte blir en jingel', () => {
  const a = offRouteText(true, 0);
  const b = offRouteText(true, 1);
  const c = offRouteText(true, 2);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(offRouteText(true, 3), a);   // cyklar runt
});
