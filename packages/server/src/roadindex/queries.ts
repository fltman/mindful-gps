/**
 * Vägindexets SQL. Typad för hand, ingen ORM — precis som db/queries.ts.
 *
 * Postgres lämnar tillbaka int8 som sträng. Varje H3-cell går därför genom `BigInt()`
 * på vägen in i koden och `.toString()` på vägen ut. Kastningen sker här, vid gränsen.
 *
 * ── Varför frågorna ser ut som de gör ────────────────────────────────────────
 *
 * Ingen av dem räknar. De LÄSER förberäknade kolumner (`h3`, `curvature_dpk`) som
 * segmenter.ts fyllde vid ingest. En planeringsomgång drar tusentals segment ur den här
 * tabellen; hade kurvigheten räknats i SQL vore databasen flaskhalsen i en produkt vars
 * hela poäng är att nyhetsmatten kostar noll (CONTRACT §3.3).
 */

import type { Pool, PoolClient } from 'pg';

import { haversine } from '@mindful/core';
import type { LngLat, RoadClass, RoadSegment, Surface } from '@mindful/core';

import { ellipseBudgetM, TILE_TTL_DAYS } from './RoadIndex.js';
import type { DraftSegment } from './RoadIndex.js';
import { bboxOf, ellipsePolygon } from './tiles.js';

/** Så många segment per INSERT. Arrayerna gör att parametertaket aldrig är problemet. */
const INSERT_CHUNK = 2_000;

/** Kolumnerna varje läsfråga hämtar. En rad ⇄ ett RoadSegment. */
const SEGMENT_COLUMNS = `
  id, way_id, cls, surface, name, ref, length_m,
  ST_AsGeoJSON(shape) AS shape, h3, curvature_dpk
`;

interface SegmentRow {
  readonly id: string;
  readonly way_id: string;
  readonly cls: string;
  readonly surface: string;
  readonly name: string | null;
  readonly ref: string | null;
  readonly length_m: number;
  readonly shape: string;              // GeoJSON LineString
  readonly h3: string[];               // int8[] → strängar
  readonly curvature_dpk: number;
}

function toSegment(r: SegmentRow): RoadSegment {
  const geo = JSON.parse(r.shape) as { coordinates: [number, number][] };

  return {
    id: Number(r.id),
    wayId: Number(r.way_id),
    cls: r.cls as RoadClass,
    surface: r.surface as Surface,
    lengthM: r.length_m,
    shape: geo.coordinates.map(([lon, lat]) => [lon, lat] as LngLat),
    h3: r.h3.map(BigInt),
    curvatureDpk: r.curvature_dpk,
    ...(r.name !== null ? { name: r.name } : {}),
    ...(r.ref !== null ? { ref: r.ref } : {}),
  };
}

// ─── Bokföringen ────────────────────────────────────────────────────────────

/**
 * Vilka av rutorna är hämtade och färska nog?
 *
 * En TOM ruta som är hämtad är ett svar ("här finns inga småvägar"), inte ett hål.
 * Utan `road_tile` går de två inte att skilja åt, och vi hade hämtat om Vätterns mitt
 * varje gång någon planerade en tur över den.
 */
export async function freshTiles(
  db: Pool | PoolClient,
  tiles: readonly bigint[],
  ttlDays: number = TILE_TTL_DAYS,
): Promise<Set<bigint>> {
  if (tiles.length === 0) return new Set();

  const res = await db.query<{ h3_6: string }>(
    `SELECT h3_6 FROM road_tile
      WHERE h3_6 = ANY($1::bigint[])
        AND fetched_at > now() - make_interval(days => $2)`,
    [tiles.map(String), ttlDays],
  );

  return new Set(res.rows.map((r) => BigInt(r.h3_6)));
}

/**
 * Skriv en hämtnings rutor och segment. Allt eller inget.
 *
 * `delete-och-skriv-om` per bokföringsruta, aldrig upsert per segment: `road_segment.id`
 * är ett serienummer utan mening utanför tabellen, och en way som byggts om i OSM sedan
 * förra hämtningen har inte "samma" segment längre. Att försöka para ihop dem hade varit
 * att uppfinna en identitet OSM inte har.
 *
 * `segments` på rutan är inte statistik utan en försäkran: en ruta som står som hämtad
 * med noll segment har verkligen inga småvägar.
 */
export async function writeTiles(
  tx: PoolClient,
  tiles: readonly bigint[],
  segmentsByTile: ReadonlyMap<bigint, readonly DraftSegment[]>,
): Promise<void> {
  if (tiles.length === 0) return;

  await tx.query(
    `INSERT INTO road_tile (h3_6, fetched_at, segments)
     SELECT t.h3, now(), t.n
       FROM unnest($1::bigint[], $2::integer[]) AS t(h3, n)
     ON CONFLICT (h3_6) DO UPDATE
        SET fetched_at = now(), segments = EXCLUDED.segments`,
    [
      tiles.map(String),
      tiles.map((t) => segmentsByTile.get(t)?.length ?? 0),
    ],
  );

  // Efter rutraden, före de nya segmenten: främmande nyckeln road_segment.tile_h3_6
  // kräver att rutan finns, och de gamla segmenten måste bort innan de nya kommer in.
  await tx.query(
    'DELETE FROM road_segment WHERE tile_h3_6 = ANY($1::bigint[])',
    [tiles.map(String)],
  );

  const rows: Array<{ tile: bigint; seg: DraftSegment }> = [];
  for (const tile of tiles) {
    for (const seg of segmentsByTile.get(tile) ?? []) rows.push({ tile, seg });
  }

  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);

    await tx.query(
      `INSERT INTO road_segment
         (tile_h3_6, way_id, cls, surface, name, ref, length_m, shape, h3, curvature_dpk)
       SELECT r.tile, r.way, r.cls, r.surface, r.name, r.ref, r.len,
              ST_SetSRID(ST_GeomFromGeoJSON(r.shape), 4326),
              r.h3::bigint[],
              r.curv
         FROM unnest(
                $1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::text[],
                $6::text[], $7::double precision[], $8::text[], $9::text[],
                $10::double precision[]
              ) AS r(tile, way, cls, surface, name, ref, len, shape, h3, curv)`,
      [
        chunk.map((r) => r.tile.toString()),
        chunk.map((r) => r.seg.wayId.toString()),
        chunk.map((r) => r.seg.cls),
        chunk.map((r) => r.seg.surface),
        chunk.map((r) => r.seg.name ?? null),
        chunk.map((r) => r.seg.ref ?? null),
        chunk.map((r) => r.seg.lengthM),
        chunk.map((r) => JSON.stringify({
          type: 'LineString',
          coordinates: r.seg.shape,
        })),
        // int8[] skrivs som Postgres arrayliteral och castas i frågan. En parameter per
        // segment i stället för en per cell — ett segment har ~10 celler, och 2 000
        // segment hade annars blivit 20 000 parametrar av parametertakets 65 535.
        chunk.map((r) => `{${r.seg.h3.join(',')}}`),
        chunk.map((r) => r.seg.curvatureDpk),
      ],
    );
  }
}

// ─── Läsfrågorna ────────────────────────────────────────────────────────────

/**
 * ADGW-ellipsen (CONTRACT §4, design-v1 §3 steg 2):
 *
 *     haversine(A, v) + haversine(v, B) ≤ (1 + ε) · D0 / 0,85
 *
 * En via-punkt utanför ellipsen kan BEVISLIGEN inte klara tidsbudgeten — den prunas
 * gratis, utan ett enda ruttanrop. Nämnaren 0,85 kompenserar för att småvägen är
 * krokigare än fågelvägen antyder; utan den hade ellipsen varit för snäv och kastat bort
 * just de omvägar produkten finns för.
 *
 * `v` är segmentets MITTPUNKT — samma punkt som blir `through`-waypoint när planeraren
 * väljer segmentet (jfr `midpointOf` i segmenter.ts). Testet svarar därför på exakt den
 * fråga planeraren ställer, inte på en approximation av den.
 *
 * Två steg, och det är avsiktligt:
 *   1. `shape && envelope` — bbox-överlappning på GIST-indexet. Slår ut 99 % av tabellen
 *      utan att röra en enda geometri.
 *   2. Exakt ellipstest med ST_DistanceSphere (haversine, samma sfär som core:s `geo`).
 *      Ellipsen fyller ~78 % av sin bbox — utan steg 2 hade var femte kandidat legat
 *      utanför budgeten.
 *
 * `d0M` är baslinjeruttens längd. Vägindexet kan inte känna till den (det har ingen
 * ruttmotor), så det frusna interfacet i CONTRACT §4 skickar den inte. Utelämnad faller
 * den tillbaka på fågelvägen A→B — ärligt, men snålt: den riktiga rutten är alltid
 * längre, och ellipsen blir därmed mindre än den borde. Planeraren, som HAR baslinjen,
 * skickar in den.
 */
export async function segmentsInEllipse(
  db: Pool | PoolClient,
  a: LngLat,
  b: LngLat,
  epsilon: number,
  classes: readonly RoadClass[],
  d0M?: number,
): Promise<RoadSegment[]> {
  if (classes.length === 0) return [];

  const beeline = haversine(a, b);
  const d0 = d0M ?? beeline;
  const budget = ellipseBudgetM(epsilon, d0);

  // Under fokalavståndet är ellipsen degenererad — det finns ingen väg alls som klarar
  // budgeten. Hellre en tom lista än en imaginär lillaxel.
  if (budget < beeline) return [];

  const bbox = bboxOf(ellipsePolygon(a, b, epsilon, d0));

  const res = await db.query<SegmentRow>(
    `WITH kandidat AS (
       SELECT id, way_id, cls, surface, name, ref, length_m, shape, h3, curvature_dpk,
              ST_LineInterpolatePoint(shape, 0.5) AS mitt
         FROM road_segment
        WHERE cls = ANY($1::text[])
          AND shape && ST_MakeEnvelope($2, $3, $4, $5, 4326)
     )
     SELECT ${SEGMENT_COLUMNS}
       FROM kandidat
      WHERE ST_DistanceSphere(mitt, ST_SetSRID(ST_MakePoint($6, $7), 4326))
          + ST_DistanceSphere(mitt, ST_SetSRID(ST_MakePoint($8, $9), 4326))
          <= $10
      ORDER BY id`,
    [
      classes, bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat,
      a[0], a[1], b[0], b[1], budget,
    ],
  );

  return res.rows.map(toSegment);
}

/**
 * Segmenten som skär ringen (slingläget, design-v1 läge (b)).
 *
 * Polygonens hål räknas som utanför — ST_Intersects respekterar dem. En isokronring
 * med ett hål i mitten föreslår alltså inte hemtrakten en gång till.
 *
 * `ST_Intersects` gör bbox-förfiltret själv (`&&` mot GIST-indexet) innan den rör
 * geometrin. Att skriva ut det för hand hade bara upprepat planeraren.
 */
export async function segmentsInRing(
  db: Pool | PoolClient,
  ring: GeoJSON.Polygon,
  classes: readonly RoadClass[],
): Promise<RoadSegment[]> {
  if (classes.length === 0) return [];

  const res = await db.query<SegmentRow>(
    `SELECT ${SEGMENT_COLUMNS}
       FROM road_segment
      WHERE cls = ANY($1::text[])
        AND ST_Intersects(shape, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
      ORDER BY id`,
    [classes, JSON.stringify(ring)],
  );

  return res.rows.map(toSegment);
}
