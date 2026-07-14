/**
 * Motorns cache. CONTRACT §2 — men framför allt en konsekvens av §2.3:
 * `requestsPerSecond` säger hur fort vi FÅR fråga, cachen bestämmer hur ofta vi BEHÖVER.
 *
 * Tre livslängder, och de är olika av verkliga skäl:
 *
 *   baseline   24 h   Vägnätet ändras inte över en natt, men tilesetet byts ibland.
 *                     Ett dygn är kort nog att en ny tile syns i morgon, och långt nog
 *                     att ett andra försök på samma tur är gratis.
 *   locate     90 d   En snappning är en egenskap hos vägnätet, inte hos resan. Samma
 *                     ankarpunkt frågas om och om igen av planeraren — den ska kosta
 *                     noll efter första gången.
 *   isochrone  30 d   Dyrast av alla anrop och nästan helt stabil. Upptäcktsläget
 *                     ritar samma ring runt hemmet varje gång.
 *
 * Nyckeln är koordinater avrundade till 4 decimaler (≈ 11 m — under en H3-cells bredd,
 * så vi slår aldrig ihop två punkter som minnet håller isär), plus en hash av
 * preferenserna, plus de extra delar anroparen skickar med (planeraren lägger t.ex. ε
 * i baseline-nyckeln — cachen behöver inte veta vad ε är, bara att den ingår).
 *
 * Två lager: minnet först (samma process svarar på mikrosekunder), Postgres bakom
 * (överlever omstart, delas mellan enheter — vägnätet är ju inte personligt).
 * Tabellen skapas här och inte i db/schema.sql därför att cachen är motorns ensak: går
 * den sönder ska den kunna slängas utan att någon rör produktens schema.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import type { LngLat, RoadPreference } from '@mindful/core';

export type CacheKind = 'baseline' | 'locate' | 'isochrone';

export const CACHE_TTL_S: Readonly<Record<CacheKind, number>> = {
  baseline: 24 * 3600,
  locate: 90 * 24 * 3600,
  isochrone: 30 * 24 * 3600,
};

export interface EngineCache {
  get<T>(kind: CacheKind, key: string): Promise<T | undefined>;
  set<T>(kind: CacheKind, key: string, value: T): Promise<void>;
}

// ─── Nycklar ────────────────────────────────────────────────────────────────

/**
 * 4 decimaler ≈ 11 m på våra breddgrader.
 *
 * `Math.round` och inte `toFixed` direkt: `(-0.00004).toFixed(4)` är `"-0.0000"`, och
 * `"-0.0000"` och `"0.0000"` är samma plats men olika nycklar. Vi normaliserar bort
 * minus noll innan strängen görs.
 */
export function coordKey(p: LngLat): string {
  const r = (x: number): string => (Math.round(x * 1e4) / 1e4 + 0).toFixed(4);
  return `${r(p[0])},${r(p[1])}`;
}

export function coordsKey(pts: readonly LngLat[]): string {
  return pts.map(coordKey).join(';');
}

/**
 * Preferenserna som en kort hash. Fälten läses i en fast ordning — objektets
 * nyckelordning får aldrig avgöra om vi får en träff eller inte.
 */
export function prefsHash(p: RoadPreference): string {
  const canonical = [
    p.motorway, p.trunk, p.track, p.livingStreet, p.ferry, p.tolls,
    p.maxSpeedKph ?? '-', p.maneuverPenaltyS ?? '-',
  ].join('|');
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12);
}

/** Sätt ihop en nyckel av delar. `undefined` faller bort — den bär ingen information. */
export function cacheKey(...parts: readonly (string | number | undefined)[]): string {
  return parts.filter((p) => p !== undefined).join('|');
}

// ─── Minnet ─────────────────────────────────────────────────────────────────

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/**
 * Minnescache med tak. Utan tak växer ett planeringssvep på 12 kandidater × en
 * hel sommar tills processen dör — och den som får OOM en söndagseftermiddag kommer
 * aldrig gissa att det var ruttcachen.
 *
 * Vräkningen är enkel: när taket nås slängs den äldst insatta (Map bevarar
 * insättningsordning). Ingen LRU-bokföring — träffarna vi bryr oss om är
 * baseline och locate under ETT svep, och de hinner aldrig bli äldst.
 */
export class MemoryCache implements EngineCache {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = 5_000) {}

  async get<T>(kind: CacheKind, key: string): Promise<T | undefined> {
    const k = `${kind}:${key}`;
    const hit = this.#entries.get(k);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.#entries.delete(k);
      return undefined;
    }
    return hit.value as T;
  }

  async set<T>(kind: CacheKind, key: string, value: T): Promise<void> {
    const k = `${kind}:${key}`;
    this.#entries.delete(k);
    this.#entries.set(k, { value, expiresAt: Date.now() + CACHE_TTL_S[kind] * 1000 });

    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

// ─── Postgres ───────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_cache (
  kind        text        NOT NULL,
  key         text        NOT NULL,
  value       jsonb       NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS engine_cache_expires_idx ON engine_cache (expires_at);
`;

/**
 * Postgres bakom minnet.
 *
 * ⚠️ Ett cachefel är ALDRIG ett ruttfel. Går databasen ner ska planeraren fortsätta
 * fråga motorn, långsammare men rätt. Därför sväljs fel här och kastas aldrig vidare —
 * det enda stället i kodbasen där en tyst catch är rätt svar.
 */
export class PgCache implements EngineCache {
  readonly #memory: MemoryCache;
  #ready: Promise<void> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly onError: (err: unknown) => void = () => {},
    maxMemoryEntries = 5_000,
  ) {
    this.#memory = new MemoryCache(maxMemoryEntries);
  }

  /** Idempotent. Anropas av `get`/`set` — ingen behöver komma ihåg att initiera cachen. */
  async migrate(): Promise<void> {
    this.#ready ??= this.pool.query(SCHEMA).then(() => undefined);
    await this.#ready;
  }

  async get<T>(kind: CacheKind, key: string): Promise<T | undefined> {
    const warm = await this.#memory.get<T>(kind, key);
    if (warm !== undefined) return warm;

    try {
      await this.migrate();
      const res = await this.pool.query<{ value: T }>(
        'SELECT value FROM engine_cache WHERE kind = $1 AND key = $2 AND expires_at > now()',
        [kind, key],
      );
      const row = res.rows[0];
      if (!row) return undefined;

      await this.#memory.set(kind, key, row.value);
      return row.value;
    } catch (err) {
      this.onError(err);
      return undefined;
    }
  }

  async set<T>(kind: CacheKind, key: string, value: T): Promise<void> {
    await this.#memory.set(kind, key, value);

    try {
      await this.migrate();
      await this.pool.query(
        `INSERT INTO engine_cache (kind, key, value, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4))
         ON CONFLICT (kind, key) DO UPDATE
           SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [kind, key, JSON.stringify(value), CACHE_TTL_S[kind]],
      );
    } catch (err) {
      this.onError(err);
    }
  }

  /** Städa bort det som gått ut. Körs när det passar — inget hänger på att den körs. */
  async vacuum(): Promise<number> {
    try {
      await this.migrate();
      const res = await this.pool.query('DELETE FROM engine_cache WHERE expires_at <= now()');
      return res.rowCount ?? 0;
    } catch (err) {
      this.onError(err);
      return 0;
    }
  }
}

/** Ingen cache. Bench och tester vill mäta motorn, inte vårt minne av den. */
export const NO_CACHE: EngineCache = {
  async get() { return undefined; },
  async set() { /* medvetet tomt */ },
};
