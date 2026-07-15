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

import { SIGHT_WEIGHT, decode6, type LngLat, type Sight, type SightKind } from '@mindful/core';

import { BadRequest } from '../device.js';
import { harÖppenRouterNyckel } from '../ai/openrouter.js';
import { AISaknasError, komponeraBerättelse } from '../sights/berattelse.js';
import type { ORKälla } from '../ai/openrouter.js';
import { RöstSaknasError, talTillLjud } from '../sights/rost.js';

/**
 * De sorter som ritas på översikten och alltså är värda att förhandshämta — samma tröskel
 * som TUNG_NOG i layers.sights.ts. En hembygdsstuga längs vägen är ingen man kör för att
 * se; en utsikt eller en runsten kan vara det.
 */
const TUNGA_SORTER: readonly SightKind[] = (Object.keys(SIGHT_WEIGHT) as SightKind[])
  .filter((k) => SIGHT_WEIGHT[k] >= 0.7);

/** Kör `jobb` över `saker` med högst `bredd` samtidigt. En enkel semafor, ingen dep. */
async function iPar<T>(saker: readonly T[], bredd: number, jobb: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const arbetare = Array.from({ length: Math.min(bredd, saker.length) }, async () => {
    while (i < saker.length) {
      const min = saker[i++];
      if (min !== undefined) await jobb(min);
    }
  });
  await Promise.all(arbetare);
}

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

  /**
   * POST /api/sight/prefetch  { polyline, radiusM?, max? }
   *
   * Värm textcachen för sevärdheterna längs en rutt, INNAN körningen. Då finns berättelsen
   * på ett tryck även i täckningsskugga — och det är precis där de vackra små vägarna
   * ligger. Fire-and-forget från klienten: den startar körningen direkt och bryr sig inte
   * om svaret.
   *
   * ⛔ Bara TEXT, aldrig röst. Texten är offline-vinsten; ElevenLabs är dyrt och behöver
   *    ändå nät. Och bara de som SAKNAS — kör man samma rutt igen kostar det ingenting.
   */
  app.post('/sight/prefetch', async (req) => {
    if (!harÖppenRouterNyckel()) return { funna: 0, cachade: 0, komponerade: 0, hoppade: 0 };

    const body = (req.body ?? {}) as { polyline?: unknown; radiusM?: unknown; max?: unknown };
    if (typeof body.polyline !== 'string') throw new BadRequest('polyline saknas');

    const coords = decode6(body.polyline);
    if (coords.length < 2) return { funna: 0, cachade: 0, komponerade: 0, hoppade: 0 };

    // 1200 m: det relevanta avståndet är inte hur långt man SER, utan vad som hamnar på
    // kartan under körningen — och den följer bilen på körzoom (~1 km i bild). Det är de
    // prickarna föraren kan trycka på. Bredare vore att värma upp texter för platser som
    // aldrig kommer i bild; snävare (mätt: 300 m gav noll på Växjö→Kalmar) missar allt.
    const radie = typeof body.radiusM === 'number' ? body.radiusM : 1200;
    const max = typeof body.max === 'number' ? body.max : 12;

    const wkt = `LINESTRING(${coords.map(([lon, lat]) => `${lon} ${lat}`).join(',')})`;

    const res = await pool.query<{
      id: string; kind: string; name: string; lon: number; lat: number; cachad: boolean;
    }>(
      `SELECT s.id, s.kind, s.name, ST_X(s.at) AS lon, ST_Y(s.at) AS lat,
              (st.sight_id IS NOT NULL) AS cachad
         FROM sight s
         LEFT JOIN sight_story st ON st.sight_id = s.id
        WHERE s.kind = ANY($2::text[])
          AND ST_DWithin(
                s.at::geography,
                ST_Simplify(ST_GeomFromText($1, 4326), 0.0008)::geography,
                $3)`,
      [wkt, TUNGA_SORTER as unknown as string[], radie],
    );

    // Tyngst först, sedan taket. Det som ryms är det man helst vill ha berättat.
    const sorterade = res.rows.sort(
      (a, b) => SIGHT_WEIGHT[b.kind as SightKind] - SIGHT_WEIGHT[a.kind as SightKind],
    );
    const valda = sorterade.slice(0, max);
    const hoppade = sorterade.length - valda.length;

    const attKomponera = valda.filter((r) => !r.cachad);
    let komponerade = 0;

    await iPar(attKomponera, 3, async (r) => {
      const sight: Sight = {
        id: Number(r.id), kind: r.kind as SightKind, name: r.name, at: [r.lon, r.lat] as LngLat,
      };
      try {
        await skapaBerättelse(pool, sight);
        komponerade += 1;
      } catch (e) {
        // En miss är ingen kris: trycket under körningen hämtar den live i stället.
        req.log.warn(`prefetch: ${sight.name || sight.kind} gick inte att förbereda (${String(e)})`);
      }
    });

    if (hoppade > 0) {
      req.log.info(`prefetch: ${valda.length} förbereds, ${hoppade} sevärdheter över taket (${max})`);
    }

    return {
      funna: sorterade.length,
      cachade: valda.length - attKomponera.length,
      komponerade,
      hoppade,
    };
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
