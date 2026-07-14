/**
 * Kalibrering av sevärdheternas dragkraft (CONTRACT §7).
 *
 *   npx tsx bench/sevardheter.ts
 *
 * ── Frågan bench:en ställer ─────────────────────────────────────────────────
 *
 * INTE "passerar rutten fler sevärdheter". Det gör den alltid om man bara gör den längre —
 * en oändligt lång rutt passerar allt. Den frågan hade gett oss en funktion som ser ut att
 * fungera och i själva verket bara kostar tid.
 *
 * Frågan är: **passerar rutten fler sevärdheter PER KILOMETER?** Blir tätheten högre har vi
 * bytt samma sträcka mot mer att titta på, och det är hela poängen. Blir den lägre har vi
 * bara förlängt turen, och då ska funktionen bort — hur mycket vi än gillar idén.
 *
 * Första mätningen (SIGHT_PULL = 1,0, radie 700 m, Växjö → Kalmar):
 *
 *     utan:  140,4 km · 49 sevärdheter · 0,35 per km
 *     med:   157,6 km · 53 sevärdheter · 0,34 per km      ← 17 km dyrare, INGET bättre
 *
 * Därför den här filen. Vikten var en hypotes, hypotesen föll, och den mäts nu.
 */

import { MINDFUL, SIGHT_WEIGHT, decode6, haversine, todayDay } from '@mindful/core';
import { VisitedIndex } from '@mindful/core';
import type { LngLat, Sight } from '@mindful/core';

import { pool } from '../packages/server/src/db/pool.js';
import { createValhalla } from '../packages/server/src/engine/ValhallaProvider.js';
import { OverpassRoadIndex } from '../packages/server/src/roadindex/OverpassRoadIndex.js';
import { PbfSource } from '../packages/server/src/roadindex/osmium.js';
import { planAB } from '../packages/server/src/planner/planAB.js';
import type { PlanContext } from '../packages/server/src/planner/context.js';
import { sightsInBbox } from '../packages/server/src/sights/queries.js';

/** Sträckor inom det seedade området. Alla med tomt minne — dag ett. */
const RUTTER: ReadonlyArray<{ namn: string; från: LngLat; till: LngLat }> = [
  { namn: 'Växjö → Kalmar',   från: [14.8059, 56.8777], till: [16.3616, 56.6634] },
  { namn: 'Växjö → Karlskrona', från: [14.8059, 56.8777], till: [15.5869, 56.1612] },
  { namn: 'Kalmar → Vetlanda', från: [16.3616, 56.6634], till: [15.0776, 57.4281] },
];

/** Svepet. `pull = 0` är kontrollgruppen: sevärdheterna avstängda. */
const PULL = [0, 0.25, 0.5, 1.0, 2.0];
const RADIE = [250, 700];

/** Så nära vägen en sevärdhet måste ligga för att RÄKNAS som passerad. Fast — det är måttstocken. */
const MÄTRADIE_M = 500;

const idag = todayDay();
const tomtMinne = VisitedIndex.empty();

const engine = await createValhalla({ baseUrl: process.env['VALHALLA_URL'] ?? 'http://localhost:8002' });
const roads = new OverpassRoadIndex(pool, new PbfSource());

/** Alla sevärdheter i Småland/Blekinge, en gång. */
const alla = await sightsInBbox(pool, { minLon: 13.4, minLat: 55.6, maxLon: 17.6, maxLat: 57.9 });
console.log(`${alla.length} sevärdheter i mätområdet\n`);

/** Sevärdheter inom MÄTRADIE_M från rutten, viktade. Varje sevärdhet räknas EN gång. */
function längsRutten(pts: readonly LngLat[]): { antal: number; vikt: number } {
  let antal = 0;
  let vikt = 0;

  for (const s of alla) {
    for (const p of pts) {
      if (haversine(p, s.at) < MÄTRADIE_M) {
        antal++;
        vikt += SIGHT_WEIGHT[s.kind];
        break;
      }
    }
  }
  return { antal, vikt };
}

interface Rad {
  pull: number; radie: number;
  km: number; min: number; antal: number; vikt: number;
}

const rader: Rad[] = [];

for (const radie of RADIE) {
  for (const pull of PULL) {
    // pull = 0 stänger av sevärdheterna helt — radien spelar då ingen roll, kör den en gång.
    if (pull === 0 && radie !== RADIE[0]) continue;

    let km = 0; let min = 0; let antal = 0; let vikt = 0;

    for (const r of RUTTER) {
      const ctx: PlanContext = {
        engine, roads, mem: tomtMinne, today: idag, prefs: MINDFUL,
        sightPull: pull, sightRadiusM: radie,
      };

      const { routes } = await planAB(ctx, { from: r.från, to: r.till, epsilon: 0.60 });
      const bästa = routes[0];
      if (!bästa) { console.log(`  ${r.namn}: ingen rutt`); continue; }

      const pts = decode6(bästa.route.geometry);
      const träff = längsRutten(pts);

      km += bästa.route.distanceM / 1000;
      min += bästa.route.timeS / 60;
      antal += träff.antal;
      vikt += träff.vikt;
    }

    rader.push({ pull, radie, km, min, antal, vikt });
    console.log(
      `pull ${pull.toFixed(2)}  radie ${String(radie).padStart(3)} m  `
      + `${km.toFixed(0).padStart(4)} km  ${antal.toString().padStart(3)} sev  `
      + `${(antal / km).toFixed(3)} sev/km  ${(vikt / km).toFixed(3)} vikt/km`,
    );
  }
}

// ── Domen ───────────────────────────────────────────────────────────────────

const kontroll = rader.find((r) => r.pull === 0);
if (!kontroll) throw new Error('kontrollgruppen saknas');

const bas = kontroll.vikt / kontroll.km;
console.log(`\nkontroll (pull 0): ${(kontroll.antal / kontroll.km).toFixed(3)} sev/km`
  + ` · ${bas.toFixed(3)} vikt/km · ${kontroll.km.toFixed(0)} km\n`);

console.log('pull  radie   Δ vikt/km    Δ km      dom');
for (const r of rader) {
  if (r.pull === 0) continue;

  const täthet = r.vikt / r.km;
  const dTäthet = (täthet - bas) / bas;
  const dKm = (r.km - kontroll.km) / kontroll.km;

  // Sevärdheterna är värda något bara om tätheten stiger. Stiger den mindre än sträckan
  // växer har vi köpt fyra kyrkor för sjutton kilometer, och det är inte en affär.
  const dom = dTäthet <= 0.01 ? '✗ ingen nytta'
    : dTäthet > dKm ? '✓ tätare per km'
      : '~ bara längre';

  console.log(
    `${r.pull.toFixed(2)}  ${String(r.radie).padStart(3)} m  `
    + `${(dTäthet * 100).toFixed(1).padStart(7)} %  `
    + `${(dKm * 100).toFixed(1).padStart(6)} %   ${dom}`,
  );
}

await pool.end();
