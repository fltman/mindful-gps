/**
 * Vägdata ur den lokala OSM-extrakten. En `WaySource` för SEEDNING.
 *
 * ── När den här källan, och inte Overpass ────────────────────────────────────
 *
 * ADGW-ellipsen för Växjö→Kalmar vid ε = 0,35 är ~33 000 km² — den är fet just för att
 * D0 (110 km väg) är större än fågelvägen. Det blir över hundra res-5-rutor. Overpass
 * drivs av volontärer; hundra frågor för EN ruttberäkning är att missbruka den, inte att
 * använda den.
 *
 * Vi har redan hela Sverige på disk — samma `sweden-latest.osm.pbf` som Valhalla byggde
 * sina tiles ur. Att seeda en region därifrån tar sekunder, kan inte rate-limita oss, och
 * ger BIT FÖR BIT samma segment som Overpass hade gett: `segmentWay` är en ren funktion
 * av wayens geometri, och båda källorna levererar hela geometrin.
 *
 * Overpass finns kvar för det den är bra på — den enstaka rutan som saknas när någon kör
 * bortom det vi hunnit seeda. Samma `RoadIndex`, samma segment, olika källa.
 *
 * ── Förfiltret ───────────────────────────────────────────────────────────────
 *
 * `smavagar.osm.pbf` är Sverige nedskuret till de sju klasser vi indexerar
 * (INDEXED_CLASSES) — 784 MB → 132 MB, en gång:
 *
 *   osmium tags-filter sweden-latest.osm.pbf \
 *     w/highway=primary,secondary,tertiary,unclassified,residential,living_street,track \
 *     -o smavagar.osm.pbf
 *
 * Motorväg och trunk finns medvetet INTE med. De kan aldrig bli ankarsegment — en rutt
 * som TVINGAS genom E4:an är motsatsen till produkten — och att bära dem hade gjort varje
 * extrakt tre gånger tyngre.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import { frånRoten } from '../rot.js';
import type { WaySource } from './RoadIndex.js';
import type { OsmWay } from './segmenter.js';
import { bboxOf, tileBoundary } from './tiles.js';
import type { Bbox } from './tiles.js';

/** Den förfiltrerade extrakten. */
export const PBF_PATH = process.env['ROADS_PBF']
  ?? frånRoten('valhalla/custom_files/smavagar.osm.pbf');

/** En GeoJSON-rad ur `osmium export`. */
interface Feature {
  readonly id?: string;                                  // "w257256208"
  readonly geometry?: { readonly coordinates?: [number, number][] };
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

/**
 * Alla vägar som skär bboxen, strömmade.
 *
 * Två steg, för `osmium export` måste läsa sin indata TVÅ gånger (först nodernas
 * positioner, sedan vägarna) och kan därför inte läsa från en pipe. Extrakten går till en
 * temporärfil som städas i `finally` — även när anroparen bryter iterationen.
 *
 * `--strategy=complete_ways` och inte `simple`: en way som skär rutan tas med i sin
 * HELHET, precis som Overpass `out geom` gör. `simple` hade KLIPPT geometrin vid
 * rutkanten, och då hade den sista 400-metersbiten före kanten blivit en annan bit än den
 * grannrutan senare klipper ut ur samma way. Segmenten måste vara oberoende av vem som
 * hämtade dem, annars är fördelningen inte en partition.
 */
export async function* waysInBbox(pbfPath: string, bbox: Bbox): AsyncGenerator<OsmWay> {
  const dir = await mkdtemp(join(tmpdir(), 'mindful-roads-'));
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
      '--geometry-types=linestring',
      '--add-unique-id=type_id',
      '--format-option=print_record_separator=false',
      '-o', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = exporter;

    let stderr = '';
    exporter.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // MÅSTE lösas ut även vid kod 0. En promise som bara avvisar vid fel settlar aldrig i
    // det normala fallet, och `await`:en nedan hade då hängt sig för evigt — tyst, eftersom
    // barnprocessen redan är klar och det inte finns ett enda handtag kvar som väcker
    // event-loopen igen.
    const closed = new Promise<void>((resolve, reject) => {
      exporter.on('error', reject);
      exporter.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`osmium export: ${stderr.trim()}`));
      });
    });
    // Avvisandet konsumeras nedan; utan den här hade en krasch i barnprocessen blivit en
    // obehandlad promise-avvisning i stället för ett fel.
    closed.catch(() => {});

    const lines = createInterface({ input: exporter.stdout, crlfDelay: Infinity });

    for await (const line of lines) {
      if (line.length === 0) continue;

      const f = JSON.parse(line) as Feature;
      const coords = f.geometry?.coordinates;
      const id = f.id;
      if (!coords || coords.length < 2 || id === undefined) continue;

      yield {
        id: Number.parseInt(id.slice(1), 10),          // "w257256208" → 257256208
        tags: f.properties ?? {},
        // osmium ger [lon, lat]; segmenter.ts vill ha OSM-formen (lat, lon).
        geometry: coords.map(([lon, lat]) => ({ lon, lat })),
      };
    }

    await closed;
  } finally {
    // Bryter anroparen iterationen i förtid lever osmium-processen kvar och håller sin
    // stdout öppen mot en läsare som aldrig kommer tillbaka. Den ska dö med oss.
    child?.kill();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Vägarna ur den lokala extrakten.
 *
 * Bboxen runt hexagonen tar med ~27 % överskott utanför rutan. Det spelar ingen roll:
 * segmenten fördelas ändå på bokföringsrutor efter sin mittpunkt, och de som hamnar
 * utanför den här hämtningsrutans sju barn kastas av indexet.
 */
export class PbfSource implements WaySource {
  readonly name = 'pbf';

  constructor(private readonly pbfPath: string = PBF_PATH) {}

  ways(fetchTile: bigint): AsyncIterable<OsmWay> {
    return waysInBbox(this.pbfPath, bboxOf(tileBoundary(fetchTile)));
  }
}
