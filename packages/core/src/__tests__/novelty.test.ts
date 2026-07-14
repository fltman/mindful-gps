import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DENSIFY_M, EPOCH_DAY0, H3_RES, MAX_GAP_M, NEIGHBOR_SOFTNESS,
         TAU_DAYS } from '../constants.js';
import { familiarity } from '../familiarity.js';
import { densify } from '../geo.js';
import { cell, gridDisk, gridPathCells, VisitedIndex, type CellVisit } from '../h3util.js';
import { cellNovelty, routeNovelty, segmentNovelty, softFamiliarity,
         todayDay } from '../novelty.js';
import type { LngLat, RoadSegment, VisitedCell } from '../types.js';
import { offset, straight } from './helpers.js';

/**
 * Skrivvägen ur CONTRACT §3.4, steg 4–7: densifiera, cellifiera, täpp diagonalhålen,
 * skriv en batch. Exakt så klienten kommer göra det.
 */
function drive(mem: VisitedIndex, shape: readonly LngLat[], day: number): void {
  const batch: CellVisit[] = [];
  let prev: bigint | undefined;

  for (const p of densify(shape, DENSIFY_M, MAX_GAP_M)) {
    const c = cell(p, H3_RES);
    if (prev !== undefined && prev !== c) {
      for (const h of gridPathCells(prev, c)) batch.push({ h3: h, axisMask: 0 });
    } else {
      batch.push({ h3: c, axisMask: 0 });
    }
    prev = c;
  }

  mem.upsert(batch, day);
}

const cellsAlong = (shape: readonly LngLat[]): bigint[] =>
  [...new Set(densify(shape, DENSIFY_M, MAX_GAP_M).map(p => cell(p, H3_RES)))];

describe('todayDay', () => {
  it('räknar dagar sedan EPOCH_DAY0', () => {
    assert.equal(todayDay(EPOCH_DAY0), 0);
    assert.equal(todayDay(EPOCH_DAY0 + 86_400_000), 1);
    assert.equal(todayDay(EPOCH_DAY0 + 86_400_000 * 1234.5), 1234);
  });

  it('ryms i en u16 långt bortom produktens livslängd', () => {
    assert.ok(todayDay(Date.UTC(2100, 0, 1)) < 65_535);
  });
});

describe('familiarity', () => {
  const c = (visits: number, lastSeenDay: number): VisitedCell =>
    ({ h3: 1n, visits, lastSeenDay, axisMask: 0 });

  it('visits = 0 → 0', () => {
    assert.equal(familiarity(c(0, 1000), 1000), 0);
  });

  it('många besök och kört idag → ~1', () => {
    assert.ok(familiarity(c(255, 1000), 1000) > 0.999);
  });

  it('ett enda besök idag mättar bara till hälften', () => {
    // 1 - exp(-0,7) = 0,503. En körning gör inte en väg välbekant.
    assert.ok(Math.abs(familiarity(c(1, 1000), 1000) - 0.5034) < 1e-3);
  });

  it('recency-decay lever: 3·TAU_DAYS sedan → nära 0', () => {
    // En väg du körde för tre år sedan ÄR i praktiken ny igen. Det är hela skälet
    // till att produkten är meningsfull år 2 i stället för att stelna.
    const f = familiarity(c(255, 1000), 1000 + 3 * TAU_DAYS);
    assert.ok(f < 0.06, `fick ${f}`);
    assert.ok(f > 0.04, `exponentialen ska ge exp(-3) ≈ 0,0498, inte ${f}`);
  });

  it('en cell kan aldrig vara sedd i framtiden', () => {
    // Klockskev får inte ge recency > 1 → familiarity > 1 → NEGATIV nyhet.
    assert.ok(familiarity(c(255, 2000), 1500) <= 1);
  });
});

describe('DET KRITISKA TESTET (CONTRACT §7)', () => {
  // "Kör benchmarken med minnestillståndet pendlare och kontrollera att gamla
  //  riksvägen fortfarande scoras som NY när bara E4:an 200 m bort är körd. Gör den
  //  inte det är hela premissen bruten."
  const TODAY = 2400;

  const e4 = straight([12.0, 57.7], 0, 25, 80);          // 2 km rakt norrut
  const riksvagen = offset(e4, 90, 200);                 // parallell, 200 m österut

  const mem = VisitedIndex.empty();
  for (let i = 0; i < 200; i++) drive(mem, e4, TODAY);   // pendlaren kör E4:an 200 ggr

  it('E4:an är genomkörd — minnet har tagit', () => {
    for (const h3 of cellsAlong(e4)) {
      const c = mem.get(h3);
      assert.ok(c, 'cell saknas i minnet');
      assert.equal(c.visits, 200);
      assert.ok(cellNovelty(h3, mem, TODAY) < 0.1);
    }
  });

  it('gamla riksvägen 200 m bort är FORTFARANDE ny', () => {
    let worst = 1;
    for (const h3 of cellsAlong(riksvagen)) {
      worst = Math.min(worst, cellNovelty(h3, mem, TODAY));
    }
    assert.ok(
      worst > 0.9,
      `sämsta cellen på riksvägen hade nyhet ${worst.toFixed(3)} — `
      + 'grannmjukheten läcker 200 m och hela produktpremissen är bruten',
    );
  });

  it('hela riksvägen scoras som ny rutt', () => {
    assert.ok(routeNovelty(riksvagen, mem, TODAY) > 0.9);
  });

  it('men grannmjukheten LEVER: en väg 50 m bort suddas mjukt', () => {
    // Motprovet. Vore softFamiliarity död hade även den här varit 1,0 — och då hade
    // GPS-brus på ±5–10 m räknats som ny väg varje gång.
    const bredvid = offset(e4, 90, 50);
    const nara = routeNovelty(bredvid, mem, TODAY);
    const langtBort = routeNovelty(riksvagen, mem, TODAY);

    assert.ok(nara < 0.9, `50 m bort borde suddas, fick ${nara.toFixed(3)}`);
    assert.ok(nara < langtBort - 0.2, 'nyheten ska falla med avståndet');
  });
});

describe('segmentNovelty är kontinuerlig, aldrig binär', () => {
  const TODAY = 500;

  const seg = (h3: bigint[]): RoadSegment => ({
    id: 1, wayId: 1, cls: 'tertiary', surface: 'paved',
    lengthM: 400, shape: [], h3, curvatureDpk: 0,
  });

  it('ett halvkört segment ger ~0,5 — inte 0 och inte 1', () => {
    const vag = straight([13.0, 56.0], 0, 25, 32);       // ~800 m
    const cells = cellsAlong(vag);
    const half = cells.slice(0, Math.floor(cells.length / 2));

    const mem = VisitedIndex.empty();
    // Kör bara första halvan, tillräckligt många gånger för att den ska bli välbekant.
    for (let i = 0; i < 20; i++) mem.upsert(half.map(h3 => ({ h3, axisMask: 0 })), TODAY);

    const n = segmentNovelty(seg(cells), mem, TODAY);
    assert.ok(n > 0.3 && n < 0.7, `fraktionell täckning ska ge ~0,5, fick ${n.toFixed(2)}`);
  });

  it('ett helt okört segment är 1', () => {
    const cells = cellsAlong(straight([14.0, 55.6], 90, 25, 20));
    assert.equal(segmentNovelty(seg(cells), VisitedIndex.empty(), TODAY), 1);
  });

  it('ett segment utan celler är 0, inte NaN', () => {
    assert.equal(segmentNovelty(seg([]), VisitedIndex.empty(), TODAY), 0);
  });
});

describe('grann-maxet är förberäknat — men svaret är kontraktets', () => {
  // softFamiliarity slår inte längre upp ringen per sampel; minnet har avgjort vinnaren
  // vid skrivningen. Det här är kontrollen att den genvägen ger EXAKT kontraktets tal.
  const TODAY = 3000;

  /** CONTRACT §3.3, ord för ord: ringen slås upp, alla grannar med visits ≥ 2 vägs. */
  function referens(h3: bigint, mem: VisitedIndex, today: number): number {
    const self = mem.get(h3);
    const own = self ? familiarity(self, today) : 0;
    let best = 0;
    for (const n of gridDisk(h3, 1)) {
      const c = mem.get(n);
      if (c && c.visits >= 2) best = Math.max(best, familiarity(c, today));
    }
    return Math.max(own, NEIGHBOR_SOFTNESS * best);
  }

  const vag = straight([11.97, 57.71], 40, 25, 60);       // 1,5 km
  const grannar = (shape: readonly LngLat[]): bigint[] =>
    [...new Set(cellsAlong(shape).flatMap(h => gridDisk(h, 1)))];

  const mem = VisitedIndex.empty();
  for (let i = 0; i < 3; i++) drive(mem, vag, TODAY - 400 + i);

  it('samma tal som kontraktets formel, cell för cell', () => {
    for (const h3 of grannar(vag)) {
      assert.equal(softFamiliarity(h3, mem, TODAY), referens(h3, mem, TODAY));
    }
  });

  it('och fortfarande samma tal efter att minnet vuxit', () => {
    // Grann-indexet underhålls inkrementellt i upsert. Kör en korsande väg och en till
    // passage på den gamla — båda måste synas i grannarnas mjuka familiaritet.
    const korsande = straight([11.972, 57.713], 130, 25, 60);
    drive(mem, korsande, TODAY);
    drive(mem, vag, TODAY);

    for (const h3 of [...grannar(vag), ...grannar(korsande)]) {
      assert.equal(softFamiliarity(h3, mem, TODAY), referens(h3, mem, TODAY));
    }
  });

  it('en dag långt senare ger också samma tal — vinnaren är dagsoberoende', () => {
    for (const h3 of grannar(vag)) {
      assert.equal(softFamiliarity(h3, mem, TODAY + 3 * TAU_DAYS),
                   referens(h3, mem, TODAY + 3 * TAU_DAYS));
    }
  });
});
