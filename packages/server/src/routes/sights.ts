/**
 * GET /api/sights?bbox=minLon,minLat,maxLon,maxLat
 *
 * Sevärdheterna i kartans utsnitt. Kartan frågar när användaren panorerar; svaret är rent
 * läsande och kan cachas hårt av webbläsaren — OSM ändrar sig inte medan man kör.
 *
 * ⛔ Ingen ruttlogik här. Sevärdheterna STYR INTE rutten (se core/sights.ts) — de ritas,
 *    och föraren svänger av om hen vill.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { BadRequest } from '../device.js';
import { sightsInBbox } from '../sights/queries.js';

/**
 * Tak på hur stor bbox som får frågas.
 *
 * Vid låg zoom är hela Sverige i bild, och 40 000 sevärdheter i ett svar är varken en
 * karta eller en användbar bild — det är en grå fläck. Kartan ritar dem ändå först från
 * zoom 11, och då är utsnittet några mil.
 */
const MAX_GRADER = 3.0;

export async function sightRoutes(app: FastifyInstance, opts: { deps: { pool: Pool } }): Promise<void> {
  const { pool } = opts.deps;

  app.get('/sights', async (req, reply) => {
    const raw = (req.query as { bbox?: unknown }).bbox;
    if (typeof raw !== 'string') throw new BadRequest('bbox saknas');

    const delar = raw.split(',').map(Number);
    if (delar.length !== 4 || delar.some((n) => !Number.isFinite(n))) {
      throw new BadRequest('bbox ska vara minLon,minLat,maxLon,maxLat');
    }

    const [minLon, minLat, maxLon, maxLat] = delar as [number, number, number, number];
    if (maxLon - minLon > MAX_GRADER || maxLat - minLat > MAX_GRADER) {
      throw new BadRequest('utsnittet är för stort');
    }

    const sights = await sightsInBbox(pool, { minLon, minLat, maxLon, maxLat });

    // En dag. OSM:s sevärdheter ändrar sig inte medan någon kör till Kalmar.
    void reply.header('cache-control', 'public, max-age=86400');
    return { sights };
  });
}
