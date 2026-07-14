/**
 * Finns hävstången i RUTTVALET i stället för i ankarrankningen?
 *
 * `bench/sevardheter.ts` visade att sevärdheter i ankarrankningen inte gör något: rutten
 * blir längre, aldrig tätare. Slutsatsen var att åtta through-punkter à 400 m inte kan
 * styra vad en 14-milsrutt passerar.
 *
 * Men planeraren producerar 8–12 HELA kandidatrutter, och den väljer redan bland dem. Om
 * de skiljer sig åt i sevärdheter per kilometer finns valet där — och då är frågan inte
 * "hur rankar vi ankare" utan "hur poängsätter vi rutter".
 *
 * Den här mätningen svarar bara på en sak: HUR MYCKET skiljer kandidaterna sig åt?
 *
 *   Stor spridning  → det finns något att välja på. En sevärdhetsterm i U(P) skulle bita.
 *   Liten spridning → alla vägar mellan A och B passerar ungefär lika mycket, och då är
 *                     sevärdheter inget att rutta efter. De ska ritas på kartan i stället.
 */

import { MINDFUL, SIGHT_WEIGHT, VisitedIndex, decode6, haversine, todayDay } from '@mindful/core';
import type { LngLat } from '@mindful/core';

import { pool } from '../packages/server/src/db/pool.js';
import { createValhalla } from '../packages/server/src/engine/ValhallaProvider.js';
import { OverpassRoadIndex } from '../packages/server/src/roadindex/OverpassRoadIndex.js';
import { PbfSource } from '../packages/server/src/roadindex/osmium.js';
import { planAB } from '../packages/server/src/planner/planAB.js';
import type { PlanContext } from '../packages/server/src/planner/context.js';
import { sightsInBbox } from '../packages/server/src/sights/queries.js';

const MÄTRADIE_M = 500;

const RUTTER: ReadonlyArray<{ namn: string; från: LngLat; till: LngLat }> = [
  { namn: 'Växjö → Kalmar', från: [14.8059, 56.8777], till: [16.3616, 56.6634] },
  { namn: 'Växjö → Karlskrona', från: [14.8059, 56.8777], till: [15.5869, 56.1612] },
];

const engine = await createValhalla({
  baseUrl: process.env['VALHALLA_URL'] ?? 'http://localhost:8002',
});
const roads = new OverpassRoadIndex(pool, new PbfSource());
const alla = await sightsInBbox(pool, { minLon: 13.4, minLat: 55.6, maxLon: 17.6, maxLat: 57.9 });

function längsRutten(pts: readonly LngLat[]): { antal: number; vikt: number } {
  let antal = 0; let vikt = 0;
  for (const s of alla) {
    for (const p of pts) {
      if (haversine(p, s.at) < MÄTRADIE_M) { antal++; vikt += SIGHT_WEIGHT[s.kind]; break; }
    }
  }
  return { antal, vikt };
}

for (const r of RUTTER) {
  const ctx: PlanContext = {
    engine, roads, mem: VisitedIndex.empty(), today: todayDay(), prefs: MINDFUL,
    sightPull: 0,             // avstängda: vi mäter vad kandidaterna RÅKAR passera
  };

  const { routes } = await planAB(ctx, { from: r.från, to: r.till, epsilon: 0.60 });

  console.log(`\n${r.namn} — ${routes.length} kandidater`);
  console.log('  km      sev   sev/km   vikt/km   sort');

  const tätheter: number[] = [];

  for (const k of routes) {
    const pts = decode6(k.route.geometry);
    const t = längsRutten(pts);
    const km = k.route.distanceM / 1000;
    const täthet = t.vikt / km;
    tätheter.push(täthet);

    console.log(
      `  ${km.toFixed(1).padStart(5)}  ${t.antal.toString().padStart(3)}  `
      + `${(t.antal / km).toFixed(3)}   ${täthet.toFixed(3)}    ${k.kind}`,
    );
  }

  const min = Math.min(...tätheter);
  const max = Math.max(...tätheter);
  const spridning = min > 0 ? (max - min) / min : 0;

  console.log(
    `  spridning i vikt/km: ${min.toFixed(3)} → ${max.toFixed(3)}`
    + `  (${(spridning * 100).toFixed(0)} % mellan sämst och bäst)`,
  );
  console.log(
    spridning < 0.15
      ? '  → FÖR LITEN. Alla vägar dit passerar ungefär lika mycket. Rutta inte efter det.'
      : '  → det finns något att välja på.',
  );
}

await pool.end();
