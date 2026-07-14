/**
 * POST /api/traces — sync-mottagaren. CONTRACT §3.6.
 *
 *   body: RawTrace[] (utan `synced`)
 *   → 200 { accepted: string[] }   trace-id:n servern nu äger
 *
 * `accepted` betyder "servern har den här turen", inte "servern skrev den nu". En tur
 * vi redan hade räknas som accepterad — annars hade klienten aldrig kunnat tömma sin
 * outbox efter ett avbrutet svar.
 */

import type { FastifyInstance } from 'fastify';

import { decode6 } from '@mindful/core';
import type { Gap, RawTrace } from '@mindful/core';

import { inTransaction, pool } from '../db/pool.js';
import { ensureDevice, insertTrip, upsertCells } from '../db/queries.js';
import { BadRequest, deviceIdOf } from '../device.js';
import { cellsOfTrace, dayOf } from '../ingest.js';

/** Ett svep från klienten är en handfull turer, aldrig hundratals. */
const MAX_TRACES_PER_REQUEST = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ['free', 'nav_ab', 'nav_loop', 'explore'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function parseGaps(v: unknown, where: string): Gap[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new BadRequest(`${where}: gaps måste vara en lista`);

  return v.map((g, i) => {
    if (!isRecord(g)
      || !isFiniteNumber(g['fromIdx']) || !isFiniteNumber(g['toIdx'])
      || !isFiniteNumber(g['distanceM']) || !isFiniteNumber(g['ms'])) {
      throw new BadRequest(`${where}: gaps[${i}] är trasig`);
    }
    return {
      fromIdx: g['fromIdx'], toIdx: g['toIdx'],
      distanceM: g['distanceM'], ms: g['ms'],
    };
  });
}

/**
 * Validera en RawTrace ur ett JSON-body. Fel här är klientens fel → 400, aldrig 500.
 * `synced` finns inte i kontraktets body och ignoreras om den råkar följa med.
 */
function parseTrace(v: unknown, i: number): RawTrace {
  const where = `traces[${i}]`;
  if (!isRecord(v)) throw new BadRequest(`${where} är inte ett objekt`);

  const id = v['id'];
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new BadRequest(`${where}: id måste vara ett uuid`);
  }

  const mode = v['mode'];
  if (typeof mode !== 'string' || !MODES.includes(mode as RawTrace['mode'])) {
    throw new BadRequest(`${where}: okänt mode`);
  }

  const startedAt = v['startedAt'];
  const endedAt = v['endedAt'];
  const distanceM = v['distanceM'];
  const polyline6 = v['polyline6'];

  if (!isFiniteNumber(startedAt) || !isFiniteNumber(endedAt) || endedAt < startedAt) {
    throw new BadRequest(`${where}: startedAt/endedAt är trasiga`);
  }
  if (!isFiniteNumber(distanceM) || distanceM < 0) {
    throw new BadRequest(`${where}: distanceM är trasig`);
  }
  if (typeof polyline6 !== 'string') {
    throw new BadRequest(`${where}: polyline6 saknas`);
  }

  return {
    id: id.toLowerCase(),
    startedAt,
    endedAt,
    mode: mode as RawTrace['mode'],
    polyline6,
    distanceM,
    gaps: parseGaps(v['gaps'], where),
    synced: true,
  };
}

export async function traceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/traces', async (req, reply) => {
    const deviceId = deviceIdOf(req);

    const body = req.body;
    if (!Array.isArray(body)) throw new BadRequest('body måste vara en lista av RawTrace');
    if (body.length > MAX_TRACES_PER_REQUEST) {
      throw new BadRequest(`högst ${MAX_TRACES_PER_REQUEST} turer per anrop`);
    }

    const traces = body.map(parseTrace);
    await ensureDevice(pool, deviceId);

    const accepted: string[] = [];

    // En transaktion per tur, inte en per svep: en trasig tur ska inte kunna riva med
    // sig de nio som gick bra. Klienten synkar om just den och blir inte fast.
    for (const trace of traces) {
      await inTransaction(async (tx) => {
        const isNew = await insertTrip(tx, deviceId, trace, decode6(trace.polyline6));
        if (!isNew) return;                 // hade den redan — räkna inte besöken igen

        const cells = cellsOfTrace(trace);
        if (cells.length > 0) {
          await upsertCells(tx, deviceId, cells, dayOf(trace.endedAt));
        }
      });
      accepted.push(trace.id);
    }

    return reply.send({ accepted });
  });
}
