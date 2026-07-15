/**
 * GET /api/sight/:id/berattelse   → { text, källor, ljudFinns }
 * GET /api/sight/:id/rost         → audio/mpeg
 *
 * Berättelsen om en sevärdhet, och dess uppläsning. Bådadera på begäran — föraren tryckte
 * på en prick, och det är den enda gången appen säger något om en sevärdhet (se
 * layers.sights.ts och tystnadsdoktrinen).
 *
 * Allt cachas i `sight_story`: komponera en gång, återanvänd för alltid. En sevärdhet i
 * hela Sverige kostar ett par modellanrop TOTALT, inte ett per tryck.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import type { LngLat, Sight, SightKind } from '@mindful/core';

import { BadRequest } from '../device.js';
import { AISaknasError, komponeraBerättelse } from '../sights/berattelse.js';
import type { ORKälla } from '../ai/openrouter.js';
import { RöstSaknasError, talTillLjud } from '../sights/rost.js';

interface Rad {
  readonly text: string;
  readonly sources: ORKälla[];
  readonly harLjud: boolean;
}

/** Sevärdheten ur tabellen — allt berättelsen behöver för att komponeras. */
async function hämtaSevärdhet(pool: Pool, id: bigint): Promise<Sight | null> {
  const res = await pool.query<{ kind: string; name: string; lon: number; lat: number }>(
    'SELECT kind, name, ST_X(at) AS lon, ST_Y(at) AS lat FROM sight WHERE id = $1',
    [id.toString()],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { id: Number(id), kind: r.kind as SightKind, name: r.name, at: [r.lon, r.lat] as LngLat };
}

/** Berättelsen ur cachen, eller `null` om den aldrig komponerats. */
async function hämtaBerättelse(pool: Pool, id: bigint): Promise<Rad | null> {
  const res = await pool.query<{ text: string; sources: ORKälla[]; har_ljud: boolean }>(
    'SELECT text, sources, audio IS NOT NULL AS har_ljud FROM sight_story WHERE sight_id = $1',
    [id.toString()],
  );
  const r = res.rows[0];
  return r ? { text: r.text, sources: r.sources, harLjud: r.har_ljud } : null;
}

/** Komponera och cacha. Anropas bara vid en cache-miss. */
async function skapaBerättelse(pool: Pool, sight: Sight): Promise<Rad> {
  const b = await komponeraBerättelse(sight);
  await pool.query(
    `INSERT INTO sight_story (sight_id, text, sources) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (sight_id) DO UPDATE SET text = EXCLUDED.text, sources = EXCLUDED.sources`,
    [sight.id.toString(), b.text, JSON.stringify(b.källor)],
  );
  return { text: b.text, sources: [...b.källor], harLjud: false };
}

function idAv(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new BadRequest('ogiltigt id');
  return BigInt(raw);
}

export function sightStoryRoutes(app: FastifyInstance, opts: { deps: { pool: Pool } }): void {
  const { pool } = opts.deps;

  app.get('/sight/:id/berattelse', async (req) => {
    const id = idAv((req.params as { id?: unknown }).id);

    const cachad = await hämtaBerättelse(pool, id);
    if (cachad) return { text: cachad.text, källor: cachad.sources, ljudFinns: cachad.harLjud };

    const sight = await hämtaSevärdhet(pool, id);
    if (!sight) throw new BadRequest('okänd sevärdhet');

    const skapad = await skapaBerättelse(pool, sight);
    return { text: skapad.text, källor: skapad.sources, ljudFinns: false };
  });

  app.get('/sight/:id/rost', async (req, reply) => {
    const id = idAv((req.params as { id?: unknown }).id);

    // Har vi redan ljudet? Skicka det direkt.
    const befintligt = await pool.query<{ audio: Buffer | null }>(
      'SELECT audio FROM sight_story WHERE sight_id = $1', [id.toString()],
    );
    const cachatLjud = befintligt.rows[0]?.audio;
    if (cachatLjud) {
      void reply.header('content-type', 'audio/mpeg');
      void reply.header('cache-control', 'public, max-age=604800');
      return reply.send(cachatLjud);
    }

    // Ingen text än? Komponera den först — man kan trycka "läs upp" innan texten cachats.
    let text: string;
    const rad = await hämtaBerättelse(pool, id);
    if (rad) {
      text = rad.text;
    } else {
      const sight = await hämtaSevärdhet(pool, id);
      if (!sight) throw new BadRequest('okänd sevärdhet');
      text = (await skapaBerättelse(pool, sight)).text;
    }

    const ljud = await talTillLjud(text);
    await pool.query('UPDATE sight_story SET audio = $2 WHERE sight_id = $1',
      [id.toString(), ljud]);

    void reply.header('content-type', 'audio/mpeg');
    void reply.header('cache-control', 'public, max-age=604800');
    return reply.send(ljud);
  });
}

export { AISaknasError, RöstSaknasError };
