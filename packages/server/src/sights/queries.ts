/**
 * Sevärdheterna i PostGIS.
 *
 * Skrivs per bokföringsruta, precis som vägsegmenten, med `delete-och-skriv-om` i stället
 * för upsert: en sevärdhet som tagits bort ur OSM sedan förra hämtningen ska försvinna ur
 * vår tabell också, och en upsert hade låtit den ligga kvar för alltid.
 */

import type { Pool, PoolClient } from 'pg';

import type { LngLat, Sight, SightKind } from '@mindful/core';

import type { Bbox } from '../roadindex/tiles.js';

interface SightRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
}

const radTillSight = (r: SightRow): Sight => ({
  id: Number(r.id),
  kind: r.kind as SightKind,
  name: r.name,
  at: [r.lon, r.lat] as LngLat,
});

/**
 * Skriv en bokföringsrutas sevärdheter.
 *
 * Rutraden i `road_tile` MÅSTE finnas — främmande nyckeln kräver det. Anroparen skriver
 * alltid vägarna först, och det är också den ordning som gör en halvskriven region
 * omöjlig: finns rutan men saknas sevärdheterna vet ingen om det betyder "inga" eller
 * "inte hämtade".
 */
export async function writeSights(
  tx: PoolClient,
  tiles: readonly bigint[],
  sightsByTile: ReadonlyMap<bigint, readonly Sight[]>,
): Promise<void> {
  if (tiles.length === 0) return;

  await tx.query(
    'DELETE FROM sight WHERE tile_h3_6 = ANY($1::bigint[])',
    [tiles.map(String)],
  );

  const rows: Array<{ tile: bigint; s: Sight }> = [];
  for (const tile of tiles) {
    for (const s of sightsByTile.get(tile) ?? []) rows.push({ tile, s });
  }
  if (rows.length === 0) return;

  await tx.query(
    `INSERT INTO sight (id, tile_h3_6, kind, name, at)
     SELECT r.id, r.tile, r.kind, r.name, ST_SetSRID(ST_MakePoint(r.lon, r.lat), 4326)
       FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::text[],
                   $5::double precision[], $6::double precision[])
              AS r(id, tile, kind, name, lon, lat)
     -- Samma sevärdhet kan ligga i två hämtningsrutors överlapp. Först till kvarn.
     ON CONFLICT (id) DO NOTHING`,
    [
      rows.map((r) => r.s.id.toString()),
      rows.map((r) => r.tile.toString()),
      rows.map((r) => r.s.kind),
      rows.map((r) => r.s.name),
      rows.map((r) => r.s.at[0]),
      rows.map((r) => r.s.at[1]),
    ],
  );
}

/**
 * Alla sevärdheter i en bbox.
 *
 * Planeraren hämtar dem EN gång per planering — inte en fråga per ankarsegment. En ellips
 * rymmer några hundra sevärdheter och tiotusentals ankare; att fråga per ankare hade varit
 * tiotusen frågor för att spara några kilobyte, och `sightScore` räknar ändå avstånden i
 * minnet på mikrosekunder.
 */
export async function sightsInBbox(db: Pool | PoolClient, bbox: Bbox): Promise<Sight[]> {
  const res = await db.query<SightRow>(
    `SELECT id, kind, name, ST_X(at) AS lon, ST_Y(at) AS lat
       FROM sight
      WHERE at && ST_MakeEnvelope($1, $2, $3, $4, 4326)`,
    [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
  );

  return res.rows.map(radTillSight);
}
