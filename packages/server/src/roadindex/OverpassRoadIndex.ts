/**
 * RoadIndex mot Overpass + PostGIS. CONTRACT §4.
 *
 * Det här är den halva av produkten ruttmotorn inte kan göra åt oss. Valhalla kan svara
 * "hur kör jag från A till B" hur bra som helst — men den kan inte svara på "var ligger
 * vägarna du INTE har kört". Den frågan ställs mot vårt eget index, och svaret blir de
 * `through`-punkter som TVINGAR rutten genom okänd väg i stället för att hoppas på den.
 *
 * ── Vad som händer, i ordning ────────────────────────────────────────────────
 *
 *   1. Sökrymden (ellipsen eller ringen) → bokföringsrutor, res 6 (`tiles.ts`).
 *   2. Rutor som redan är hämtade och färska (TTL 90 dygn) hoppas över helt.
 *   3. Resten grupperas till hämtningsrutor, res 5 ≈ 20×20 km — z10-rutan i designen.
 *      EN Overpass-fråga fyller alltså sju bokföringsrutor.
 *   4. Overpass → OSM-ways → `segmentWay` → ~400 m-segment med h3-celler och
 *      curvature FÖRBERÄKNADE (`segmenter.ts`).
 *   5. Allt hamnar i PostGIS. Nästa fråga i samma trakt rör aldrig nätet igen.
 *
 * ── Fair use ─────────────────────────────────────────────────────────────────
 *
 * overpass-api.de drivs av volontärer. Därför: EN ruta i taget, aldrig parallellt, en
 * paus mellan anropen, exponentiell backoff på 429/504, och en `User-Agent` som säger
 * vem vi är. Ett cache-lager som inte respekterar den som fyller det är inget cache-lager,
 * det är ett angrepp.
 *
 * Just därför finns också `pbfWaySource` (osmium.ts): för att SEEDA en hel region drar
 * man den ur den lokala Sverige-extrakten på sekunder i stället för att skicka hundratals
 * frågor mot en gratis tjänst. Overpass är för den enstaka rutan som saknas när någon
 * kör bortom det vi hunnit indexera. Samma `RoadIndex`, samma segment, olika källa.
 */

import type { Pool } from 'pg';

import { haversine } from '@mindful/core';
import type { LngLat, RoadClass, RoadIndex, RoadSegment, Sight } from '@mindful/core';

import { inTransaction } from '../db/pool.js';
import { OkartlagdRegion } from './OkartlagdRegion.js';
import type { SightSource } from '../sights/osmium.js';
import { writeSights } from '../sights/queries.js';
import { INDEXED_CLASSES, ROAD_TILE_RES, TILE_TTL_DAYS } from './RoadIndex.js';
import type { DraftSegment, WaySource } from './RoadIndex.js';
import { freshTiles, segmentsInEllipse, segmentsInRing, writeTiles } from './queries.js';
import { midpointOf, segmentWay } from './segmenter.js';
import type { OsmWay } from './segmenter.js';
import {
  fetchParentOf, tileAt, tileBoundary, tilesForEllipse, tilesForRing, tilesUnder,
} from './tiles.js';

// ─── Källan ─────────────────────────────────────────────────────────────────

const OVERPASS_URL = process.env['OVERPASS_URL'] ?? 'https://overpass-api.de/api/interpreter';

/**
 * Kontaktuppgiften i vår `User-Agent`.
 *
 * Overpass fair use kräver att den som frågar går att nå. Den står i miljön och inte i
 * koden av ett enda skäl: repot är publikt, och en e-postadress i ett publikt repo är en
 * e-postadress i varenda skräppostbot inom ett halvår.
 *
 * Saknas den säger vi det rakt ut i stället för att låtsas vara någon. En anonym
 * bulkfrågare är precis det Overpass ber oss att inte vara — men vi ska inte heller
 * VÄGRA fungera för att en miljövariabel saknas, för då slutar seedningen ur den lokala
 * extrakten också att gå att köra.
 */
const KONTAKT = process.env['OVERPASS_CONTACT'] ?? 'ingen kontakt angiven — sätt OVERPASS_CONTACT';

/** Overpass vill ha `highway`-värden, inte vår RoadClass. Enda stället de möts. */
const HIGHWAY_FILTER = INDEXED_CLASSES.join('|');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface OverpassElement {
  readonly type: string;
  readonly id: number;
  readonly tags?: Record<string, string>;
  readonly geometry?: { lat: number; lon: number }[];
}

interface OverpassAnswer {
  readonly elements?: OverpassElement[];
  /** Overpass svarar 200 OK med en `remark` när frågan dog av minnesbrist eller timeout. */
  readonly remark?: string;
}

export interface OverpassOptions {
  readonly endpoint?: string;
  /** Paus mellan anrop. Fair use, inte prestandajustering. */
  readonly politeDelayMs?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/**
 * Ways ur Overpass, en ruta i taget.
 *
 * `out geom;` ger geometrin inline på varje way — inga noder att slå upp, ingen andra
 * runda. `(poly:...)` i stället för bbox: rutan ÄR en hexagon, och en bbox runt den hade
 * dragit in 27 % överskott som ändå filtreras bort av mittpunktsfördelningen.
 */
export class OverpassSource implements WaySource {
  readonly name = 'overpass';

  private readonly endpoint: string;
  private readonly politeDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private lastCallAt = 0;

  constructor(opts: OverpassOptions = {}) {
    this.endpoint = opts.endpoint ?? OVERPASS_URL;
    this.politeDelayMs = opts.politeDelayMs ?? 2_000;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  async *ways(fetchTile: bigint): AsyncIterable<OsmWay> {
    // Overpass talar (lat, lon) — vår ring är [lon, lat]. Kastningen sker här, en gång.
    // Sista hörnet är en upprepning av det första; `poly` sluter ringen själv.
    const ring = tileBoundary(fetchTile).slice(0, -1);
    const poly = ring.map(([lon, lat]) => `${lat.toFixed(6)} ${lon.toFixed(6)}`).join(' ');

    const query = `[out:json][timeout:${Math.floor(this.timeoutMs / 1000)}];`
      + `way["highway"~"^(${HIGHWAY_FILTER})$"](poly:"${poly}");`
      + 'out geom;';

    const answer = await this.ask(query);
    if (answer.remark !== undefined) {
      throw new Error(`Overpass gav upp: ${answer.remark}`);
    }

    for (const el of answer.elements ?? []) {
      if (el.type !== 'way' || !el.geometry) continue;
      yield { id: el.id, tags: el.tags ?? {}, geometry: el.geometry };
    }
  }

  /**
   * Ett anrop, med backoff.
   *
   * 429 (för många frågor) och 504 (servern överbelastad) är Overpass sätt att be oss
   * vänta. Vi väntar. Allt annat — 400, trasig JSON — är vårt eget fel och ska smälla
   * direkt i stället för att maskeras av fyra omförsök.
   */
  private async ask(query: string): Promise<OverpassAnswer> {
    for (let attempt = 0; ; attempt++) {
      const since = Date.now() - this.lastCallAt;
      if (since < this.politeDelayMs) await sleep(this.politeDelayMs - since);
      this.lastCallAt = Date.now();

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': `mindful-gps/0.1 (vägindex; ${KONTAKT})`,
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.ok) return await res.json() as OverpassAnswer;

      const busy = res.status === 429 || res.status === 504;
      if (!busy || attempt >= this.maxRetries) {
        throw new Error(`Overpass svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      // 5 s, 10, 20, 40. Overpass slot-fönster är i den storleksordningen.
      await sleep(5_000 * 2 ** attempt);
    }
  }
}

// ─── Indexet ────────────────────────────────────────────────────────────────

export interface RoadIndexOptions {
  readonly ttlDays?: number;
  /**
   * Tak på hur många hämtningsrutor EN fråga får dra hem. Ellipsen för en 14-milstur är
   * ~130 rutor; att skicka dem mot Overpass mitt i en ruttberäkning vore både oförskämt
   * och obrukbart långsamt. Nås taket kastar vi — hellre ett tydligt fel som säger
   * "seeda regionen först" än en tyst halv sökrymd som ger användaren sämre rutter utan
   * att någon förstår varför.
   */
  readonly maxFetchTiles?: number;
  /**
   * Sevärdheterna, om de ska med. De skrivs i SAMMA transaktion som vägsegmenten —
   * en ruta kan aldrig ha vägar men sakna sevärdheter, för då hade planeraren tyst
   * slutat bry sig om dem just där, utan att någon märkte något.
   *
   * Utelämnad (Overpass-vägen, en enstaka ruta som saknas mitt i en körning) skrivs
   * inga sevärdheter. Rutan får dem nästa gång regionen seedas.
   */
  readonly sights?: SightSource;
}

export class OverpassRoadIndex implements RoadIndex {
  private readonly ttlDays: number;
  private readonly maxFetchTiles: number;
  private readonly sights: SightSource | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly source: WaySource = new OverpassSource(),
    opts: RoadIndexOptions = {},
  ) {
    this.ttlDays = opts.ttlDays ?? TILE_TTL_DAYS;
    this.maxFetchTiles = opts.maxFetchTiles ?? 24;
    this.sights = opts.sights;
  }

  /**
   * `d0M` är baslinjeruttens längd. Vägindexet har ingen ruttmotor och kan inte veta den,
   * så det frusna interfacet (CONTRACT §4) skickar den inte — utelämnad faller den
   * tillbaka på fågelvägen A→B. Det är ärligt men snålt: den riktiga rutten är alltid
   * längre än fågelvägen, så ellipsen blir mindre än den borde. Planeraren, som HAR
   * baslinjen, skickar in den.
   */
  async segmentsInEllipse(
    a: LngLat, b: LngLat, epsilon: number, classes: readonly RoadClass[], d0M?: number,
  ): Promise<RoadSegment[]> {
    const d0 = d0M ?? haversine(a, b);
    await this.ensure(tilesForEllipse(a, b, epsilon, d0));
    return segmentsInEllipse(this.pool, a, b, epsilon, classes, d0);
  }

  async segmentsInRing(
    _center: LngLat, ring: GeoJSON.Polygon, classes: readonly RoadClass[],
  ): Promise<RoadSegment[]> {
    await this.ensure(tilesForRing(ring));
    return segmentsInRing(this.pool, ring, classes);
  }


  /**
   * Se till att rutorna finns i PostGIS och är färskare än TTL:en.
   *
   * Publik därför att seedningen (`seed.ts`) är samma operation som en cache-miss —
   * bara i förväg, och över en hel region i stället för en ruta. Två kodvägar för samma
   * sak hade garanterat att de gled isär.
   */
  async ensure(tiles: readonly bigint[]): Promise<{ fetched: number; segments: number }> {
    const fresh = await freshTiles(this.pool, tiles, this.ttlDays);
    const stale = tiles.filter((t) => !fresh.has(t));
    if (stale.length === 0) return { fetched: 0, segments: 0 };

    const parents = [...new Set(stale.map(fetchParentOf))];
    if (parents.length > this.maxFetchTiles) {
      // Inte ett `Error`: det här är ett förutsett tillstånd med ett svar på svenska.
      // `seed.ts` lyfter taket och är den avsiktliga vägen runt det.
      throw new OkartlagdRegion(parents.length);
    }

    let segments = 0;
    // Sekventiellt. Overpass drivs av volontärer, och en fan-out hade varit att ta
    // deras kapacitet för att spara några sekunder av vår.
    for (const parent of parents) segments += await this.fetchInto(parent);

    return { fetched: parents.length, segments };
  }

  /**
   * Hämta EN hämtningsruta och skriv dess sju bokföringsrutor.
   *
   * Segmentet bokförs i rutan dess MITTPUNKT ligger i. Det gör fördelningen till en
   * partition: varje segment hamnar i exakt en ruta, oavsett hur många rutor wayen
   * korsar. Segment som faller utanför den här hämtningsrutans sju barn kastas — de
   * tillhör grannrutan, och den hämtar dem själv, bit för bit identiskt (`segmentWay`
   * är en ren funktion av wayens geometri).
   */
  private async fetchInto(parent: bigint): Promise<number> {
    const children = tilesUnder(parent);
    const mine = new Set(children);

    const byTile = new Map<bigint, DraftSegment[]>();
    let count = 0;

    for await (const way of this.source.ways(parent)) {
      for (const seg of segmentWay(way)) {
        const tile = tileAt(midpointOf(seg.shape), ROAD_TILE_RES);
        if (!mine.has(tile)) continue;

        const bucket = byTile.get(tile);
        if (bucket) bucket.push(seg);
        else byTile.set(tile, [seg]);
        count++;
      }
    }

    const sightsByTile = new Map<bigint, Sight[]>();
    if (this.sights) {
      for await (const s of this.sights.sights(parent)) {
        const tile = tileAt(s.at, ROAD_TILE_RES);
        if (!mine.has(tile)) continue;      // grannrutans sevärdhet. Den hämtar den själv.

        const bucket = sightsByTile.get(tile);
        if (bucket) bucket.push(s);
        else sightsByTile.set(tile, [s]);
      }
    }

    await inTransaction(async (tx) => {
      await writeTiles(tx, children, byTile);
      // Efter vägarna: `sight.tile_h3_6` pekar på `road_tile`, och raden måste finnas.
      if (this.sights) await writeSights(tx, children, sightsByTile);
    });

    return count;
  }
}
