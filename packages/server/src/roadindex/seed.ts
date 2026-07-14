/**
 * Seeda vägindexet för en region.
 *
 *   npx tsx packages/server/src/roadindex/seed.ts <lon> <lat> <radie_km> [--overpass] [--tvinga]
 *   npx tsx packages/server/src/roadindex/seed.ts 14.8059 56.8777 25
 *
 * Default är den lokala Sverige-extrakten (`PbfSource`) — sekunder, inga kvoter, ingen
 * volontärdriven server som får betala för vår otålighet. `--overpass` finns för att köra
 * exakt samma väg mot det riktiga API:et när man vill bevisa att det fungerar.
 *
 * `--tvinga` hämtar om även rutor som redan är färska. Det behövs när vi lagt till något
 * som INTE fanns förra gången regionen seedades — sevärdheterna, en ny vägklass — för då
 * är rutan färsk och tom på samma gång, och det är den enda kombination bokföringen inte
 * kan skilja från "här finns inget".
 *
 * Seedningen är samma operation som en cache-miss (`RoadIndex.ensure`), bara i förväg och
 * över en hel region. Två kodvägar för samma sak hade garanterat att de gled isär.
 */

import { pool } from '../db/pool.js';
import { OverpassRoadIndex, OverpassSource } from './OverpassRoadIndex.js';
import type { WaySource } from './RoadIndex.js';
import { PbfSightSource } from '../sights/osmium.js';
import { PbfSource } from './osmium.js';
import { circlePolygon, tilesForRing } from './tiles.js';

const [lonArg, latArg, radiusArg] = process.argv.slice(2);
const useOverpass = process.argv.includes('--overpass');
const tvinga = process.argv.includes('--tvinga');

if (lonArg === undefined || latArg === undefined || radiusArg === undefined) {
  console.error('bruk: seed.ts <lon> <lat> <radie_km> [--overpass]');
  process.exit(1);
}

const center: [number, number] = [Number(lonArg), Number(latArg)];
const radiusM = Number(radiusArg) * 1000;

const ring: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [circlePolygon(center, radiusM).map(([lon, lat]) => [lon, lat])],
};

const tiles = tilesForRing(ring);
const source: WaySource = useOverpass ? new OverpassSource() : new PbfSource();

// Taket på antal hämtningsrutor finns för att skydda Overpass mot en ruttberäkning som
// råkar sakna halva Småland. Seedningen är just den avsiktliga bulkhämtningen taket
// hänvisar till, så här lyfts det.
// Sevärdheterna kommer alltid ur den lokala extrakten, även när vägarna hämtas ur
// Overpass: det finns ingen Overpass-fråga i vår kod som ger dem, och en region med
// vägar men utan sevärdheter är en region där planeraren tyst slutar bry sig om dem.
const index = new OverpassRoadIndex(pool, source, {
  // Taket på antal hämtningsrutor finns för att skydda Overpass mot en ruttberäkning som
  // råkar sakna halva Småland. Seedningen är just den avsiktliga bulkhämtningen taket
  // hänvisar till, så här lyfts det.
  maxFetchTiles: tiles.length,
  sights: new PbfSightSource(),
  // TTL 0 → ingen ruta är någonsin färsk → allt hämtas om.
  ...(tvinga ? { ttlDays: 0 } : {}),
});

console.log(
  `seedar ${tiles.length} bokföringsrutor runt ${center[0]}, ${center[1]}`
  + ` (${radiusArg} km) ur ${source.name} + sevärdheter ur pbf`,
);

const t0 = Date.now();
const { fetched, segments } = await index.ensure(tiles);
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sight');
console.log(
  `${fetched} hämtningsrutor · ${segments} segment · ${rows[0]?.n ?? '0'} sevärdheter`
  + ` · ${seconds} s`,
);
await pool.end();
