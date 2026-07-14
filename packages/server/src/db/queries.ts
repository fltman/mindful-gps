/**
 * Frågorna. Typade för hand, ingen ORM.
 *
 * Postgres lämnar tillbaka bigint (int8) som sträng — därför går varje H3-cell genom
 * `BigInt()` på vägen in i koden och `.toString()` på vägen ut. Kastningen sker här,
 * vid gränsen, precis som h3-js-kastningen sker i core:s h3util.
 */

import type { Pool, PoolClient } from 'pg';

import type { LngLat, RawTrace } from '@mindful/core';

import type { IngestedCell } from '../ingest.js';

/** En cell på väg tillbaka till klienten. CONTRACT §3.6. */
export interface MemoryRow {
  readonly h3: bigint;
  readonly visits: number;
  readonly lastSeenDay: number;
  readonly axisMask: number;
}

export interface Bbox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

/** Enheten finns. `last_seen` flyttas fram vid varje anrop — enda livstecknet vi har. */
export async function ensureDevice(db: Pool | PoolClient, deviceId: string): Promise<void> {
  await db.query(
    `INSERT INTO devices (id) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET last_seen = now()`,
    [deviceId],
  );
}

/**
 * Skriv turen. Returnerar false om servern redan hade den.
 *
 * Klientens uuid är primärnyckel, och det är hela idempotensen: en tur som skickas om
 * (nätet dog mitt i syncen) får inte räknas som ett andra besök i varenda cell.
 * Anroparen hoppar över celluppdateringen när vi svarar false.
 */
export async function insertTrip(
  tx: PoolClient,
  deviceId: string,
  trace: RawTrace,
  shape: readonly LngLat[],
): Promise<boolean> {
  // Under två punkter finns ingen linje. Råspåret sparas ändå — det är sanningen.
  const geojson = shape.length >= 2
    ? JSON.stringify({ type: 'LineString', coordinates: shape })
    : null;

  const res = await tx.query(
    `INSERT INTO trips
       (id, device_id, started_at, ended_at, mode, polyline6, distance_m, gaps, geom)
     VALUES
       ($1, $2,
        to_timestamp($3::double precision / 1000),
        to_timestamp($4::double precision / 1000),
        $5, $6, $7, $8::jsonb,
        CASE WHEN $9::text IS NULL THEN NULL
             ELSE ST_SetSRID(ST_GeomFromGeoJSON($9), 4326) END)
     ON CONFLICT (id) DO NOTHING`,
    [
      trace.id, deviceId, trace.startedAt, trace.endedAt, trace.mode,
      trace.polyline6, trace.distanceM, JSON.stringify(trace.gaps), geojson,
    ],
  );

  return res.rowCount === 1;
}

/**
 * En rad per cell. Chunkas så att en lång tur inte spränger Postgres parametertak
 * (65 535) — 30 km ger ~1 500 celler à 6 parametrar.
 */
const CHUNK = 800;

/**
 * Bokför besöken. `cells` är redan deduplicerad per tur (se ingest.cellsOfTrace), så en
 * genomkörning ger exakt +1 besök.
 *
 * `last_seen_day` tas som GREATEST och inte som dagens värde: att synka ett gammalt
 * spår i efterhand får inte föryngra en cell vi kört senare.
 */
export async function upsertCells(
  tx: PoolClient,
  deviceId: string,
  cells: readonly IngestedCell[],
  day: number,
): Promise<void> {
  for (let start = 0; start < cells.length; start += CHUNK) {
    const chunk = cells.slice(start, start + CHUNK);

    const values: string[] = [];
    const params: unknown[] = [deviceId];

    for (const c of chunk) {
      const i = params.length;
      values.push(
        `($1, $${i + 1}, 1, $${i + 2}, $${i + 3},`
        + ` ST_SetSRID(ST_MakePoint($${i + 4}, $${i + 5}), 4326))`,
      );
      params.push(c.h3.toString(), day, c.axisMask, c.at[0], c.at[1]);
    }

    await tx.query(
      `INSERT INTO visited_cells (device_id, h3, visits, last_seen_day, axis_mask, pt)
       VALUES ${values.join(', ')}
       ON CONFLICT (device_id, h3) DO UPDATE SET
         visits        = LEAST(255, visited_cells.visits + 1),
         last_seen_day = GREATEST(visited_cells.last_seen_day, EXCLUDED.last_seen_day),
         axis_mask     = visited_cells.axis_mask | EXCLUDED.axis_mask`,
      params,
    );
  }
}

/**
 * Minnet inom en bbox. Klienten bygger om sina shards ur det här efter en ny enhet
 * eller en eviction.
 *
 * `pt && ST_MakeEnvelope(...)` är en indexerad bbox-överlappning på GIST-indexet, inte
 * en exakt geometrifråga — det är precis vad vi vill ha och det enda som är snabbt.
 */
export async function cellsInBbox(
  db: Pool,
  deviceId: string,
  bbox: Bbox,
): Promise<MemoryRow[]> {
  const res = await db.query<{
    h3: string; visits: number; last_seen_day: number; axis_mask: number;
  }>(
    `SELECT h3, visits, last_seen_day, axis_mask
       FROM visited_cells
      WHERE device_id = $1
        AND pt && ST_MakeEnvelope($2, $3, $4, $5, 4326)
      ORDER BY h3`,
    [deviceId, bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
  );

  return res.rows.map((r) => ({
    h3: BigInt(r.h3),
    visits: r.visits,
    lastSeenDay: r.last_seen_day,
    axisMask: r.axis_mask,
  }));
}
