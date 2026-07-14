import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLASS_BEAUTY } from '../constants.js';
import { decode6, encode6, length } from '../geo.js';
import { VisitedIndex } from '../h3util.js';
import { beauty, dilate, fractionOf, isNatural, naturalContext, reversals, routeCells,
         score, selfOverlap, sharing, turnsPerKm, weightedByLength,
         type NaturalContext } from '../scoring.js';
import type { LngLat, Maneuver, RoadClass, Route, Span, Surface } from '../types.js';
import { destination, offset, straight } from './helpers.js';

const START: LngLat = [12.0, 57.7];

function route(shape: readonly LngLat[], over: Partial<Route> = {}): Route {
  const m = length(shape);
  return {
    id: 'r',
    geometry: encode6(shape),
    distanceM: m,
    timeS: m / 20,             // ~72 km/h
    maneuvers: [],
    engine: 'test',
    ...over,
  };
}

const turn = (): Maneuver => ({
  type: 'turn', modifier: 'left', distanceM: 100, timeS: 5, shapeIndex: [0, 1],
});

describe('weightedByLength viktar på LÄNGD, inte på antal noder', () => {
  // Kontraktets pseudokod skickar in `r.distanceM`, ur vilken ett enskilt spanns längd
  // inte går att räkna fram. Den enda funktion som gick att skriva på den signaturen
  // hade viktat på antal shape-index — och polyline-noder sitter tätare i kurvor än på
  // raksträckor. Det här testet är hela skälet till att vi skickar in shapen i stället.

  // 2 km motorväg som två noder, sedan 200 m småväg som tjugo noder.
  const shape: LngLat[] = [START, destination(START, 90, 2000)];
  for (let i = 1; i <= 20; i++) shape.push(destination(START, 90, 2000 + i * 10));

  const spans: Span<RoadClass>[] = [
    { fromIdx: 0, toIdx: 1, value: 'motorway' },        // 2 000 m, 1 kant
    { fromIdx: 1, toIdx: 21, value: 'unclassified' },   //   200 m, 20 kanter
  ];

  it('2 km motorväg väger tyngre än 200 m småväg, trots tjugo gånger färre noder', () => {
    const got = weightedByLength(spans, CLASS_BEAUTY, shape);

    // Längdviktat: (2000·0,00 + 200·0,90) / 2200 = 0,082
    // Indexviktat hade gett: (1·0,00 + 20·0,90) / 21 = 0,857 — tio gånger fel.
    assert.ok(Math.abs(got - 0.0818) < 0.005, `fick ${got.toFixed(4)}`);
    assert.ok(got < 0.2, 'en rutt som är 91 % motorväg får inte vara vacker');
  });

  it('fractionOf mäter andel av LÄNGDEN', () => {
    const f = fractionOf(spans, ['motorway'], shape);
    assert.ok(Math.abs(f - 2000 / 2200) < 0.01, `fick ${f.toFixed(3)}`);
  });

  it('saknade spans är "vet ej" (0,5) för skönhet, men 0 för motorvägsandel', () => {
    // Frånvaro av data är inte bevis för motorväg. En rutt ska inte straffas för ett
    // fält motorn inte råkade fylla i.
    assert.equal(weightedByLength(undefined, CLASS_BEAUTY, shape), 0.5);
    assert.equal(fractionOf(undefined, ['motorway'], shape), 0);
  });
});

describe('beauty', () => {
  const shape = straight(START, 45, 100, 21);   // 2 km

  const withSpans = (cls: RoadClass, surface: Surface): Route => route(shape, {
    roadClassSpans: [{ fromIdx: 0, toIdx: 20, value: cls }],
    surfaceSpans: [{ fromIdx: 0, toIdx: 20, value: surface }],
  });

  it('grusig småväg är vackrare än motorväg', () => {
    const liten = beauty(routeCells(withSpans('unclassified', 'gravel')));
    const e4 = beauty(routeCells(withSpans('motorway', 'paved')));
    assert.ok(liten > e4, `${liten.toFixed(3)} ska slå ${e4.toFixed(3)}`);
  });

  it('ligger i 0..1', () => {
    for (const cls of Object.keys(CLASS_BEAUTY) as RoadClass[]) {
      const b = beauty(routeCells(withSpans(cls, 'gravel')));
      assert.ok(b >= 0 && b <= 1, `${cls} gav ${b}`);
    }
  });

  it('grus är vackert, lera är det inte', () => {
    assert.ok(beauty(routeCells(withSpans('track', 'gravel')))
      > beauty(routeCells(withSpans('track', 'dirt'))));
  });
});

describe('turnsPerKm', () => {
  it('räknar svängar, gafflar och rondelltillfarter — inte utfarter', () => {
    const r = route(straight(START, 0, 100, 21), {   // 2 km
      maneuvers: [
        turn(), turn(),
        { type: 'roundabout_enter', distanceM: 1, timeS: 1, shapeIndex: [0, 1] },
        { type: 'roundabout_exit', distanceM: 1, timeS: 1, shapeIndex: [0, 1] },
        { type: 'depart', distanceM: 1, timeS: 1, shapeIndex: [0, 1] },
        { type: 'arrive', distanceM: 1, timeS: 1, shapeIndex: [0, 1] },
      ],
    });
    assert.ok(Math.abs(turnsPerKm(r) - 1.5) < 0.01);   // 3 svängar på 2 km
  });

  it('en rutt utan längd ger 0, inte NaN', () => {
    assert.equal(turnsPerKm(route([START], { distanceM: 0 })), 0);
  });
});

describe('sharing', () => {
  const a = straight(START, 0, 50, 60);   // 3 km

  it('en rutt delar allt med sig själv', () => {
    assert.ok(sharing(routeCells(route(a)), dilate(a)) > 0.99);
  });

  it('två parallella vägar 200 m isär delar ingenting', () => {
    // Samma premiss som §7: 200 m isär är två olika vägar. Punkt.
    assert.ok(sharing(routeCells(route(a)), dilate(offset(a, 90, 200))) < 0.01);
  });
});

describe('reversals och selfOverlap', () => {
  const rakt = straight(START, 0, 100, 41);              // 4 km rakt
  const framOchTillbaka = [...rakt, ...[...rakt].reverse().slice(1)];

  it('en rak rutt vänder aldrig och korsar aldrig sig själv', () => {
    assert.equal(reversals(routeCells(route(rakt))), 0);
    assert.equal(selfOverlap(routeCells(route(rakt))), 0);
  });

  it('fram och tillbaka samma väg är en omkastning och en överlappning', () => {
    assert.ok(reversals(routeCells(route(framOchTillbaka))) >= 1);
    assert.ok(selfOverlap(routeCells(route(framOchTillbaka))) > 0.4);
  });
});

describe('isNatural — ett HÅRT filter', () => {
  const shape = straight(START, 0, 100, 61);             // 6 km
  const ctx: NaturalContext = {
    baselineTurnsPerKm: 2,
    baselineCells: dilate(offset(shape, 90, 3000)),     // en helt annan väg
    Tmax: 3600,
  };

  it('släpper igenom en lugn rutt', () => {
    assert.equal(isNatural(routeCells(route(shape, { maneuvers: [turn(), turn()] })), ctx), true);
  });

  it('stoppar en u-sväng', () => {
    const uturn: Maneuver = { type: 'uturn', distanceM: 1, timeS: 1, shapeIndex: [0, 1] };
    assert.equal(isNatural(routeCells(route(shape, { maneuvers: [uturn] })), ctx), false);
  });

  it('stoppar zigzag: mer än 1,6× baselines svängtäthet', () => {
    // 2 × 1,6 = 3,2 svängar/km. 6 km × 4 svängar/km = 24 svängar.
    const zigzag = route(shape, { maneuvers: Array.from({ length: 24 }, turn) });
    assert.equal(isNatural(routeCells(zigzag), ctx), false);
  });

  it('stoppar en rutt som vänder tillbaka', () => {
    const tillbaka = [...shape, ...[...shape].reverse().slice(1)];
    assert.equal(isNatural(routeCells(route(tillbaka)), ctx), false);
  });

  it('stoppar en rutt som spränger tidsbudgeten — den är HÅRD', () => {
    assert.equal(isNatural(routeCells(route(shape, { timeS: ctx.Tmax + 1 })), ctx), false);
  });

  it('stoppar en rutt som bara är baseline igen', () => {
    const samma: NaturalContext = { ...ctx, baselineCells: dilate(shape) };
    assert.equal(isNatural(routeCells(route(shape)), samma), false);
  });

  it('naturalContext bygger baselinemängden ur baselinerutten', () => {
    // Svepets ena dyra mängd. Byggs en gång, inte en gång per kandidat.
    const bas = route(offset(shape, 90, 3000), { maneuvers: [turn(), turn(), turn(), turn()] });
    const byggd = naturalContext(bas, 3600);
    assert.ok(Math.abs(byggd.baselineTurnsPerKm - turnsPerKm(bas)) < 1e-9);
    assert.equal(isNatural(routeCells(route(shape, { maneuvers: [turn()] })), byggd), true);
    assert.equal(isNatural(routeCells(bas), byggd), false, 'baseline delar allt med sig själv');
  });
});

describe('score', () => {
  const shape = straight(START, 0, 100, 41);            // 4 km
  const baseline = route(offset(shape, 90, 2000), { maneuvers: [turn(), turn()] });

  const input = {
    route: routeCells(route(shape, {
      maneuvers: [turn()],
      roadClassSpans: [{ fromIdx: 0, toIdx: 40, value: 'unclassified' as const }],
      surfaceSpans: [{ fromIdx: 0, toIdx: 40, value: 'gravel' as const }],
    })),
    baseline,
    baselineCells: dilate(decode6(baseline.geometry)),
    T0: baseline.timeS,
    Tmax: baseline.timeS * 1.35,
    mem: VisitedIndex.empty(),
    today: 2400,
  };

  it('en helt ny, vacker väg inom budget scoras högt', () => {
    const u = score(input);
    assert.ok(Number.isFinite(u));
    assert.ok(u > 1.0, `nyhet 1,0 + skönhet ska ge över 1,0, fick ${u.toFixed(3)}`);
  });

  it('motorväg drar ner poängen', () => {
    const e4 = score({
      ...input,
      route: routeCells(route(shape, {
        maneuvers: [turn()],
        roadClassSpans: [{ fromIdx: 0, toIdx: 40, value: 'motorway' as const }],
        surfaceSpans: [{ fromIdx: 0, toIdx: 40, value: 'paved' as const }],
      })),
    });
    assert.ok(e4 < score(input));
  });

  it('en baseline utan en enda sväng ger inte NaN', () => {
    // 0 svängar/km i nämnaren. Utan spärr blir turnCost 0/0.
    const u = score({ ...input, baseline: route(offset(shape, 90, 2000)) });
    assert.ok(Number.isFinite(u), `fick ${u}`);
  });
});
