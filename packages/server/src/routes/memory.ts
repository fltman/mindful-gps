/**
 * GET /api/memory?bbox=minLon,minLat,maxLon,maxLat — CONTRACT §3.6.
 *
 *   → 200 { cells: Array<[h3hex, visits, lastSeenDay, axisMask]> }
 *
 * Återställning på ny enhet: klienten bygger om sina shards ur det här. Cellerna går
 * som hex-strängar därför att JSON inte kan bära en u64 — klienten kastar dem till
 * bigint i sin h3util, precis som servern gör åt andra hållet.
 */

import type { FastifyInstance } from 'fastify';

import { pool } from '../db/pool.js';
import { cellsInBbox } from '../db/queries.js';
import type { Bbox } from '../db/queries.js';
import { BadRequest, deviceIdOf } from '../device.js';

/** [h3hex, visits, lastSeenDay, axisMask] */
type WireCell = readonly [string, number, number, number];

/** bbox som `minLon,minLat,maxLon,maxLat`. Koordinater är alltid [lon, lat]. */
function parseBbox(raw: unknown): Bbox {
  if (typeof raw !== 'string') throw new BadRequest('bbox saknas');

  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new BadRequest('bbox ska vara minLon,minLat,maxLon,maxLat');
  }

  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];

  if (minLon > maxLon || minLat > maxLat) throw new BadRequest('bbox är inverterad');
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new BadRequest('bbox ligger utanför jorden');
  }

  return { minLon, minLat, maxLon, maxLat };
}

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/memory', async (req, reply) => {
    const deviceId = deviceIdOf(req);
    const query = req.query as Record<string, unknown>;
    const bbox = parseBbox(query['bbox']);

    const rows = await cellsInBbox(pool, deviceId, bbox);

    const cells: WireCell[] = rows.map(
      (r) => [r.h3.toString(16), r.visits, r.lastSeenDay, r.axisMask] as const,
    );

    return reply.send({ cells });
  });
}
