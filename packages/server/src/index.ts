/**
 * @mindful/server — sync-mottagaren. Port 8161.
 *
 * Servern äger INGEN nyhetslogik. Den tar emot råspår, kör dem genom samma kod som
 * klienten (@mindful/core) och bokför cellerna. Skulle den räkna själv skulle appen och
 * servern förr eller senare visa två olika tal, och det är precis den buggen CONTRACT
 * finns för att förhindra.
 */

import cors from '@fastify/cors';
import Fastify from 'fastify';

import { migrate, pool } from './db/pool.js';
import { BadRequest } from './device.js';
import { PgCache } from './engine/cache.js';
import { createValhalla } from './engine/ValhallaProvider.js';
import { RouteEngineError } from './engine/RouteProvider.js';
import { OverpassRoadIndex } from './roadindex/OverpassRoadIndex.js';
import { PbfSource } from './roadindex/osmium.js';
import { memoryRoutes } from './routes/memory.js';
import { OkartlagdRegion } from './roadindex/OkartlagdRegion.js';
import { planRoutes } from './routes/plan.js';
import { sightRoutes } from './routes/sights.js';
import { traceRoutes } from './routes/traces.js';

const PORT = Number(process.env.PORT ?? 8161);
const VALHALLA_URL = process.env.VALHALLA_URL ?? 'http://localhost:8002';

// 5 000 km råspår är ~1,5 MB. Ett svep efter en lång tid offline kan bära flera turer.
const BODY_LIMIT = 16 * 1024 * 1024;

const app = Fastify({ logger: true, bodyLimit: BODY_LIMIT });

await app.register(cors, {
  origin: true,
  allowedHeaders: ['Content-Type', 'X-Device-Id'],
});

/**
 * Motorns fel bär redan sin egen kod (CONTRACT §0.6). `no_route` är inte ett serverfel —
 * det är ett ärligt svar på en omöjlig fråga, och användaren ska få höra det.
 */
const HTTP_FOR: Readonly<Record<RouteEngineError['code'], number>> = {
  no_route: 422,
  bad_request: 400,
  rate_limit: 429,
  quota: 402,
  upstream: 502,
};

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
  // Vi vet precis vad som hände, och användaren ska få veta det. 501: vi kan inte svara,
  // men det är inte hens fel och det är inte trasigt.
  if (err instanceof OkartlagdRegion) {
    app.log.warn(`okartlagd region: ${err.saknade} hämtningsrutor saknas`);
    return reply.code(501).send({ error: err.message });
  }
  if (err instanceof RouteEngineError) {
    return reply.code(HTTP_FOR[err.code]).send({ error: err.message, code: err.code });
  }
  app.log.error(err);
  return reply.code(500).send({ error: 'internt fel' });
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

await migrate();

/**
 * Motorn sonderas VID UPPSTART, aldrig gissas (CONTRACT §2.3). Saknar den `through`-punkter
 * eller road-class-filtrerad snappning kastar `createValhalla` — och det ska den. En motor
 * utan dem kan ge rutter, men inte VÅRA rutter, och tystnad här hade blivit "appen känns
 * konstig" i juli i stället för ett tydligt fel nu.
 */
const engine = await createValhalla({
  baseUrl: VALHALLA_URL,
  cache: new PgCache(pool, (err) => app.log.warn({ err }, 'motorcachen svarade inte')),
  log: (line) => app.log.info(line),
});

// Vägindexet läser ur PostGIS. `PbfSource` fyller på ur den lokala Sverige-extrakten när en
// ruta saknas — Overpass drivs av volontärer och ska inte betala för en ruttberäkning.
const roads = new OverpassRoadIndex(pool, new PbfSource());

await app.register(traceRoutes, { prefix: '/api' });
await app.register(memoryRoutes, { prefix: '/api' });
await app.register(planRoutes, { prefix: '/api', deps: { engine, roads } });
await app.register(sightRoutes, { prefix: '/api', deps: { pool } });

await app.listen({ port: PORT, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
}
