import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { latLngToCell } from 'h3-js';

import { H3_RES, H3_SHARD_RES } from '../constants.js';
import { axisBucket, cell, cellToParent, gridDisk, gridPathCells,
         VisitedIndex, type CellVisit } from '../h3util.js';
import type { LngLat, VisitedCell } from '../types.js';
import { destination, straight } from './helpers.js';

const GBG: LngLat = [11.9746, 57.7089];

describe('gränsen mot h3-js', () => {
  it('cell() tar [lon, lat] och h3-js tar (lat, lng)', () => {
    const ours = cell(GBG, H3_RES);
    const theirs = BigInt('0x' + latLngToCell(GBG[1], GBG[0], H3_RES));
    assert.equal(ours, theirs);
  });

  it('en förväxlad argumentordning ger en HELT annan cell', () => {
    // Vakthunden mot [lat,lon]-buggen: hade vi råkat skicka in dem baklänges hade
    // vi hamnat i Indiska oceanen, och alla tester hade fortsatt vara gröna.
    const swapped = BigInt('0x' + latLngToCell(GBG[0], GBG[1], H3_RES));
    assert.notEqual(cell(GBG, H3_RES), swapped);
  });

  it('bigint-rundgången är förlustfri', () => {
    const h = cell(GBG, H3_RES);
    assert.equal(h.toString(16), latLngToCell(GBG[1], GBG[0], H3_RES));
  });

  it('gridDisk(k=1) ger cellen själv plus sex grannar', () => {
    const disk = gridDisk(cell(GBG, H3_RES), 1);
    assert.equal(disk.length, 7);
    assert.ok(disk.includes(cell(GBG, H3_RES)));
  });

  it('gridPathCells binder ihop två celler med ändpunkterna inkluderade', () => {
    const a = cell(GBG, H3_RES);
    const b = cell(destination(GBG, 90, 300), H3_RES);
    const path = gridPathCells(a, b);

    assert.equal(path[0], a);
    assert.equal(path[path.length - 1], b);
    assert.ok(path.length >= 2);
  });

  it('cellToParent klättrar till shard-upplösningen', () => {
    const parent = cellToParent(cell(GBG, H3_RES), H3_SHARD_RES);
    // Två celler 100 m isär hamnar i samma res-6-shard (~36 km).
    const other = cellToParent(cell(destination(GBG, 45, 100), H3_RES), H3_SHARD_RES);
    assert.equal(parent, other);
  });
});

describe('axisBucket', () => {
  it('en väg har en AXEL, inte en riktning', () => {
    // DET KRITISKA: kör du norrut eller söderut på samma väg är det SAMMA väg.
    assert.equal(axisBucket(10), axisBucket(190));
    assert.equal(axisBucket(0), axisBucket(180));
    assert.equal(axisBucket(90), axisBucket(270));
    assert.equal(axisBucket(44.9), axisBucket(224.9));
  });

  it('ger fyra buckets à 45°', () => {
    assert.equal(axisBucket(0), 0);
    assert.equal(axisBucket(44), 0);
    assert.equal(axisBucket(45), 1);
    assert.equal(axisBucket(89), 1);
    assert.equal(axisBucket(90), 2);
    assert.equal(axisBucket(135), 3);
    assert.equal(axisBucket(179.99), 3);
  });

  it('klarar negativa och överfulla bäringar', () => {
    assert.equal(axisBucket(-10), axisBucket(350));
    assert.equal(axisBucket(-90), axisBucket(90));
    assert.equal(axisBucket(720), axisBucket(0));
    assert.ok(axisBucket(-0.001) >= 0 && axisBucket(-0.001) <= 3);
  });
});

describe('VisitedIndex', () => {
  const cellsOf = (pts: readonly LngLat[]): bigint[] => pts.map(p => cell(p, H3_RES));

  it('get() på ett tomt index är undefined', () => {
    const mem = VisitedIndex.empty();
    assert.equal(mem.size, 0);
    assert.equal(mem.get(cell(GBG, H3_RES)), undefined);
  });

  it('binärsökningen hittar rätt cell bland många', () => {
    const pts = straight(GBG, 30, 60, 400);       // 24 km → hundratals celler
    const uniq = [...new Set(cellsOf(pts))];

    const cells: VisitedCell[] = uniq.map((h3, i) => ({
      h3,
      visits: (i % 250) + 1,
      lastSeenDay: 1000 + (i % 97),
      axisMask: 1 << (i % 4),
    }));

    const mem = VisitedIndex.fromCells(cells);
    assert.equal(mem.size, uniq.length);

    for (const c of cells) {
      const got = mem.get(c.h3);
      assert.ok(got, `hittade inte ${c.h3.toString(16)}`);
      assert.equal(got.h3, c.h3);
      assert.equal(got.visits, c.visits);
      assert.equal(got.lastSeenDay, c.lastSeenDay);
      assert.equal(got.axisMask, c.axisMask);
    }
  });

  it('get() på en cell som inte finns är undefined', () => {
    const mem = VisitedIndex.fromCells(
      cellsOf(straight(GBG, 0, 60, 50)).map(h3 => ({
        h3, visits: 1, lastSeenDay: 10, axisMask: 0,
      })),
    );
    // 20 km bort — garanterat utanför.
    assert.equal(mem.get(cell(destination(GBG, 90, 20_000), H3_RES)), undefined);
  });

  it('upsert räknar EN passage som ETT besök, hur många fixar den än innehöll', () => {
    const h3 = cell(GBG, H3_RES);
    const mem = VisitedIndex.empty();

    // Densifieringen lägger en punkt var 15:e meter genom en cell som är ~50 m bred.
    // Fyra fixar i samma cell under samma svep är fortfarande EN genomkörning.
    const batch: CellVisit[] = [
      { h3, axisMask: 0b0001 },
      { h3, axisMask: 0b0001 },
      { h3, axisMask: 0b0010 },
      { h3, axisMask: 0b0001 },
    ];
    mem.upsert(batch, 2000);

    const got = mem.get(h3);
    assert.ok(got);
    assert.equal(got.visits, 1, 'fyra fixar i samma cell = ett besök');
    assert.equal(got.axisMask, 0b0011, 'men alla axlar ska OR:as ihop');
  });

  it('upsert räknar upp besök över flera svep och mättar vid 255', () => {
    const h3 = cell(GBG, H3_RES);
    const mem = VisitedIndex.empty();

    for (let day = 0; day < 300; day++) mem.upsert([{ h3, axisMask: 0 }], day);

    const got = mem.get(h3);
    assert.ok(got);
    assert.equal(got.visits, 255, 'u8 mättar');
    assert.equal(got.lastSeenDay, 299);
    assert.equal(mem.size, 1);
  });

  it('upsert föryngrar inte en cell när ett gammalt spår spelas upp i efterhand', () => {
    const h3 = cell(GBG, H3_RES);
    const mem = VisitedIndex.empty();

    mem.upsert([{ h3, axisMask: 0 }], 2000);
    mem.upsert([{ h3, axisMask: 0 }], 1500);   // ett gammalt spår, importerat senare

    const got = mem.get(h3);
    assert.ok(got);
    assert.equal(got.visits, 2);
    assert.equal(got.lastSeenDay, 2000, 'senaste dagen vinner');
  });

  it('upsert håller indexet sorterat och sökbart när nya celler skjuts in', () => {
    const pts = straight(GBG, 75, 40, 200);
    const uniq = [...new Set(cellsOf(pts))];
    const mem = VisitedIndex.empty();

    // Skjut in cellerna i omvänd ordning, i småbitar — sorteringen måste hålla ändå.
    for (let i = uniq.length - 1; i >= 0; i -= 3) {
      const batch: CellVisit[] = [];
      for (let k = i; k > i - 3 && k >= 0; k--) {
        const h3 = uniq[k];
        if (h3 !== undefined) batch.push({ h3, axisMask: 1 });
      }
      mem.upsert(batch, 100);
    }

    assert.equal(mem.size, uniq.length);
    for (const h3 of uniq) {
      const got = mem.get(h3);
      assert.ok(got, `tappade ${h3.toString(16)}`);
      assert.equal(got.visits, 1);
    }
  });

  it('shards överlever en rundgång genom lagringen', () => {
    const pts = straight(GBG, 10, 50, 300);
    const uniq = [...new Set(cellsOf(pts))];
    const mem = VisitedIndex.empty();
    mem.upsert(uniq.map(h3 => ({ h3, axisMask: 0b0100 })), 1234);

    const shards = mem.toShards();
    assert.ok(shards.length >= 1);

    for (const s of shards) {
      // Varje shard måste vara sorterad — binärsökningen förutsätter det.
      for (let i = 1; i < s.h3.length; i++) {
        const a = s.h3[i - 1];
        const b = s.h3[i];
        assert.ok(a !== undefined && b !== undefined && a < b, 'shard osorterad');
      }
      // Alla celler i en shard ska ha shardens förälder.
      for (const h of s.h3) {
        assert.equal(cellToParent(h, H3_SHARD_RES).toString(16), s.parent);
      }
    }

    const back = VisitedIndex.fromShards(shards);
    assert.equal(back.size, mem.size);
    for (const h3 of uniq) {
      const got = back.get(h3);
      assert.ok(got);
      assert.equal(got.visits, 1);
      assert.equal(got.lastSeenDay, 1234);
      assert.equal(got.axisMask, 0b0100);
    }
  });
});
