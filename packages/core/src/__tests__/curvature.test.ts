import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { curvatureDegPerKm, curvatureScore } from '../curvature.js';
import type { LngLat } from '../types.js';
import { circle, straight } from './helpers.js';

const GBG: LngLat = [11.9746, 57.7089];

describe('curvatureDegPerKm', () => {
  it('en spikrak väg är ~0°/km', () => {
    const line = straight(GBG, 27, 100, 60);   // 6 km rakt
    const dpk = curvatureDegPerKm(line);
    assert.ok(dpk < 1, `rak linje gav ${dpk.toFixed(2)}°/km`);
  });

  it('en cirkelbåge med radie 500 m är ~114°/km', () => {
    // Härledning: ett varv är 360° på 2π·0,5 km → 360/3,1416 = 114,6°/km.
    // Resampling till 50 m kortar av bågen till kordor, så det uppmätta värdet
    // hamnar någon procent under. Det är sanity-checken, inte en exakthetsövning.
    const dpk = curvatureDegPerKm(circle(GBG, 500, 2));
    assert.ok(Math.abs(dpk - 114.6) < 10, `radie 500 m gav ${dpk.toFixed(1)}°/km`);
  });

  it('skalar linjärt: halva radien ger dubbla slingrigheten', () => {
    const wide = curvatureDegPerKm(circle(GBG, 500, 2));
    const tight = curvatureDegPerKm(circle(GBG, 250, 2));
    assert.ok(Math.abs(tight / wide - 2) < 0.15, `kvot ${(tight / wide).toFixed(2)}`);
  });

  it('för få punkter ger 0', () => {
    assert.equal(curvatureDegPerKm([]), 0);
    assert.equal(curvatureDegPerKm([GBG]), 0);
  });
});

describe('curvatureScore', () => {
  it('rakt och tråkigt bottnar, slingrigt toppar', () => {
    assert.equal(curvatureScore(20), 0);      // motorväg
    assert.equal(curvatureScore(40), 0);      // tröskeln
    assert.equal(curvatureScore(300), 1);     // härligt slingrigt
    assert.equal(curvatureScore(900), 1);     // serpentiner klampas
  });

  it('är linjär däremellan', () => {
    assert.ok(Math.abs(curvatureScore(170) - 0.5) < 1e-9);
  });
});
