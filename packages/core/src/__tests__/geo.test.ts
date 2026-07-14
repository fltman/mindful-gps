import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_GAP_M } from '../constants.js';
import { angleDiff, bearing, decode6, densify, encode6, haversine, length,
         projectOnPolyline, resample } from '../geo.js';
import type { LngLat } from '../types.js';
import { circle, destination, straight } from './helpers.js';

const GBG: LngLat = [11.9746, 57.7089];

describe('haversine och bearing', () => {
  it('mäter ett känt avstånd', () => {
    // Göteborg → Stockholm, ~398 km fågelvägen.
    const sthlm: LngLat = [18.0686, 59.3293];
    const d = haversine(GBG, sthlm);
    assert.ok(Math.abs(d - 398_000) < 5_000, `fick ${Math.round(d)} m`);
  });

  it('mäter avstånd konstruerade med destination()', () => {
    const p = destination(GBG, 42, 1234);
    assert.ok(Math.abs(haversine(GBG, p) - 1234) < 0.1);
  });

  it('ger rätt bäring norrut och österut', () => {
    assert.ok(Math.abs(bearing(GBG, destination(GBG, 0, 500)) - 0) < 0.01);
    assert.ok(Math.abs(bearing(GBG, destination(GBG, 90, 500)) - 90) < 0.01);
    assert.ok(Math.abs(bearing(GBG, destination(GBG, 270, 500)) - 270) < 0.01);
  });

  it('angleDiff tar kortaste vägen runt 0°', () => {
    assert.equal(angleDiff(350, 10), 20);
    assert.equal(angleDiff(10, 350), -20);
    assert.equal(Math.abs(angleDiff(0, 180)), 180);
    assert.equal(angleDiff(90, 90), 0);
  });
});

describe('polyline6', () => {
  it('decode6(encode6(pts)) ≈ pts', () => {
    const pts: LngLat[] = [
      [11.9746, 57.7089],
      [11.9800, 57.7100],
      [12.0000, 57.7500],
      [-12.3456, -5.6789],   // negativa deltan måste också överleva
      [0, 0],
      [179.999999, 89.999999],
    ];

    const back = decode6(encode6(pts));
    assert.equal(back.length, pts.length);

    for (const [i, p] of pts.entries()) {
      const q = back[i];
      assert.ok(q, `punkt ${i} saknas`);
      assert.ok(Math.abs(q[0] - p[0]) < 1e-5, `lon ${i}: ${q[0]} ≠ ${p[0]}`);
      assert.ok(Math.abs(q[1] - p[1]) < 1e-5, `lat ${i}: ${q[1]} ≠ ${p[1]}`);
    }
  });

  it('överlever en lång rutt utan att ackumulera fel', () => {
    const pts = straight(GBG, 33, 40, 500);   // 20 km
    const back = decode6(encode6(pts));

    for (const [i, p] of pts.entries()) {
      const q = back[i];
      assert.ok(q);
      assert.ok(haversine(p, q) < 0.2, `punkt ${i} drev ${haversine(p, q)} m`);
    }
  });

  it('tom polyline kodar och avkodar till tomt', () => {
    assert.equal(encode6([]), '');
    assert.deepEqual(decode6(''), []);
  });
});

describe('resample', () => {
  it('ger jämna avstånd och behåller ändpunkterna', () => {
    const src = circle(GBG, 800, 3);          // en båge med varierande nodavstånd
    const first = src[0];
    const last = src[src.length - 1];
    assert.ok(first && last);

    const out = resample(src, 100);

    assert.deepEqual(out[0], first, 'startpunkten ska vara kvar');
    assert.deepEqual(out[out.length - 1], last, 'slutpunkten ska vara kvar');

    // Alla intervall utom det sista ska vara exakt spacingM.
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1];
      const b = out[i];
      assert.ok(a && b);
      const d = haversine(a, b);
      assert.ok(Math.abs(d - 100) < 0.5, `intervall ${i} var ${d.toFixed(2)} m`);
    }

    // Det sista intervallet är resten — kortare än, men aldrig längre än, spacingM.
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    assert.ok(a && b);
    assert.ok(haversine(a, b) <= 100 + 0.5);
  });

  it('behåller längden', () => {
    const src = straight(GBG, 12, 137, 40);   // ~5,3 km
    const out = resample(src, 25);
    assert.ok(Math.abs(length(out) - length(src)) < 1);
  });

  it('en polyline kortare än steget blir bara sina ändpunkter', () => {
    const src: LngLat[] = [GBG, destination(GBG, 90, 10)];
    const out = resample(src, 100);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], src[0]);
    assert.deepEqual(out[1], src[1]);
  });
});

describe('densify', () => {
  it('lägger in punkter så att inget avstånd överstiger steget', () => {
    const src = straight(GBG, 0, 100, 10);    // 100 m mellan noderna
    const out = densify(src, 15);

    let prev: LngLat | undefined;
    for (const p of out) {
      if (prev) assert.ok(haversine(prev, p) <= 15 + 0.01);
      prev = p;
    }
    assert.ok(out.length > src.length);
  });

  it('densifierar ALDRIG över ett hål större än MAX_GAP_M', () => {
    // Signalförlust: 500 m mellan två fixar. Vi hittar inte på en väg vi inte kört.
    const a = GBG;
    const b = destination(GBG, 0, 500);
    const out = densify([a, b], 15, MAX_GAP_M);

    assert.equal(out.length, 2, 'hålet ska lämnas orört');
    assert.deepEqual(out[0], a);
    assert.deepEqual(out[1], b);
  });

  it('densifierar upp till hålgränsen men inte över den', () => {
    const under = densify([GBG, destination(GBG, 0, MAX_GAP_M - 1)], 15, MAX_GAP_M);
    const over = densify([GBG, destination(GBG, 0, MAX_GAP_M + 1)], 15, MAX_GAP_M);
    assert.ok(under.length > 2);
    assert.equal(over.length, 2);
  });
});

describe('projectOnPolyline', () => {
  it('hittar närmaste punkt, segment och avstånd längs linjen', () => {
    const line = straight(GBG, 90, 100, 11);      // 1 km rakt österut
    const onLine = destination(GBG, 90, 250);     // 250 m in
    const beside = destination(onLine, 0, 30);    // 30 m norr om den

    const p = projectOnPolyline(beside, line);
    assert.ok(p);
    assert.ok(Math.abs(p.distanceM - 30) < 0.5, `avstånd ${p.distanceM}`);
    assert.ok(Math.abs(p.alongM - 250) < 1, `alongM ${p.alongM}`);
    assert.equal(p.segmentIndex, 2);              // mellan nod 2 (200 m) och 3 (300 m)
    assert.ok(haversine(p.at, onLine) < 1);
  });

  it('klampar till ändpunkterna', () => {
    const line = straight(GBG, 90, 100, 5);
    const before = destination(GBG, 270, 200);    // 200 m före starten

    const p = projectOnPolyline(before, line);
    assert.ok(p);
    assert.ok(Math.abs(p.alongM) < 1e-6);
    assert.ok(Math.abs(p.distanceM - 200) < 0.5);
  });

  it('tom polyline ger undefined', () => {
    assert.equal(projectOnPolyline(GBG, []), undefined);
  });
});
