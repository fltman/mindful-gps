/**
 * Sevärdheter ur den lokala OSM-extrakten.
 *
 * Samma väg som vägindexet går (`roadindex/osmium.ts`), och medvetet så: en gång osmium
 * extract till en temporärfil, en gång osmium export därifrån. Skillnaden är formen.
 *
 * ── Punkter OCH ytor ────────────────────────────────────────────────────────
 *
 * En runsten är en nod. Ett naturreservat är en relation som täcker sex kvadratkilometer.
 * En borg är en way runt en mur. Tog vi bara noder hade halva Sverige försvunnit — och
 * det hade blivit den halva som syns bäst.
 *
 * Ytorna reduceras till sin mittpunkt. Det är grovt, och det är rätt grovt: `sightScore`
 * frågar "hur långt är det härifrån till något värt att se", och för ett reservat är
 * svaret ändå ungefärligt. En exakt avståndsberäkning mot en polygon hade kostat PostGIS
 * per ankarsegment och gett samma rutt.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import type { LngLat, Sight } from '@mindful/core';

import { bboxOf, tileBoundary } from '../roadindex/tiles.js';
import { frånRoten } from '../rot.js';
import type { Bbox } from '../roadindex/tiles.js';
import { namnAv, sortAv } from './taggar.js';

/**
 * Var sevärdheterna kommer ifrån. Ett interface av samma skäl som `WaySource`: indexet
 * ska aldrig veta om det läser en fil på disk eller ett API över nätet.
 */
export interface SightSource {
  readonly name: string;
  sights(fetchTile: bigint): AsyncIterable<Sight>;
}

/**
 * Extrakten. Förfiltrera EN gång — hela Sverige är 784 MB, sevärdheterna är någon procent
 * av det, och `osmium extract` läser om filen för varje hämtningsruta:
 *
 *   osmium tags-filter sweden-latest.osm.pbf \
 *     nwr/historic nwr/tourism=viewpoint,attraction,museum,artwork \
 *     nwr/natural=waterfall nwr/leisure=nature_reserve nwr/man_made=lighthouse \
 *     nwr/amenity=place_of_worship \
 *     -o sevardheter.osm.pbf
 */
export const SIGHTS_PBF = process.env['SIGHTS_PBF']
  ?? frånRoten('valhalla/custom_files/sevardheter.osm.pbf');

interface Feature {
  readonly id?: string;                          // "n1234", "w567", "r89"
  readonly geometry?: {
    readonly type?: string;
    readonly coordinates?: unknown;
  };
  readonly properties?: Readonly<Record<string, string>>;
}

function run(bin: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} avslutade med ${code}: ${stderr.trim()}`));
    });
  });
}

/** Alla ringars alla hörn, oavsett om det är en Polygon eller en MultiPolygon. */
function* hörn(typ: string, koord: unknown): Generator<LngLat> {
  if (typ === 'Point') {
    const p = koord as [number, number];
    if (Array.isArray(p) && p.length >= 2) yield [p[0], p[1]];
    return;
  }

  // Polygon = ringar av punkter. MultiPolygon = polygoner av ringar. Ett djup till.
  const ringar = (typ === 'MultiPolygon'
    ? (koord as [number, number][][][]).flat()
    : koord as [number, number][][]) ?? [];

  for (const ring of ringar) {
    for (const p of ring) if (Array.isArray(p) && p.length >= 2) yield [p[0], p[1]];
  }
}

/**
 * Ytans mittpunkt: medelvärdet av hörnen.
 *
 * Inte arean-viktad centroid. För ett naturreservat med en lång utlöpare skulle de skilja
 * sig — men båda punkterna ligger då inne i reservatet, och `sightScore` bryr sig om
 * hundratals meter, inte tiotals. Det enkla talet är rätt tal.
 */
function mittpunkt(typ: string, koord: unknown): LngLat | null {
  let n = 0; let lon = 0; let lat = 0;
  for (const [x, y] of hörn(typ, koord)) { lon += x; lat += y; n++; }
  return n === 0 ? null : [lon / n, lat / n];
}

/** OSM-id:t, med typen inbakad så en nod och en way med samma nummer inte kolliderar. */
function idAv(raw: string): number | null {
  const n = Number.parseInt(raw.slice(1), 10);
  if (!Number.isFinite(n)) return null;
  const typ = raw[0];
  // n → 1xxx, w → 2xxx, r → 3xxx. Ryms i ett tal så länge OSM-id:n gör det.
  const prefix = typ === 'n' ? 1 : typ === 'w' ? 2 : 3;
  return prefix * 10_000_000_000 + n;
}

/** Alla sevärdheter som ligger i bboxen, strömmade. */
export async function* sightsInBbox(pbfPath: string, bbox: Bbox): AsyncGenerator<Sight> {
  const dir = await mkdtemp(join(tmpdir(), 'mindful-sights-'));
  const cut = join(dir, 'cut.osm.pbf');
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;

  try {
    await run('osmium', [
      'extract',
      `--bbox=${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
      '--strategy=complete_ways',
      '-f', 'pbf',
      '-o', cut,
      pbfPath,
    ]);

    const exporter = spawn('osmium', [
      'export', cut,
      '-f', 'geojsonseq',
      '--geometry-types=point,polygon',
      '--add-unique-id=type_id',
      '--format-option=print_record_separator=false',
      '-o', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = exporter;

    let stderr = '';
    exporter.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Måste lösas ut även vid kod 0 — se roadindex/osmium.ts för varför.
    const closed = new Promise<void>((resolve, reject) => {
      exporter.on('error', reject);
      exporter.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`osmium export: ${stderr.trim()}`));
      });
    });
    closed.catch(() => {});

    const lines = createInterface({ input: exporter.stdout, crlfDelay: Infinity });

    for await (const line of lines) {
      if (line.length === 0) continue;

      const f = JSON.parse(line) as Feature;
      const taggar = f.properties;
      const rawId = f.id;
      const typ = f.geometry?.type;
      if (!taggar || rawId === undefined || typ === undefined) continue;

      const kind = sortAv(taggar);
      if (kind === null) continue;

      const at = mittpunkt(typ, f.geometry?.coordinates);
      const id = idAv(rawId);
      if (at === null || id === null) continue;

      yield { id, kind, name: namnAv(taggar), at };
    }

    await closed;
  } finally {
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Sevärdheterna ur den lokala extrakten. */
export class PbfSightSource implements SightSource {
  readonly name = 'pbf';

  constructor(private readonly pbfPath: string = SIGHTS_PBF) {}

  sights(fetchTile: bigint): AsyncIterable<Sight> {
    return sightsInBbox(this.pbfPath, bboxOf(tileBoundary(fetchTile)));
  }
}
