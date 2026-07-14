/**
 * Valhalla-adaptern. CONTRACT §2.
 *
 * Här — och BARA här — talas Valhallas språk. Utanför den här filen finns ingen
 * `use_highways`, ingen `max_road_class`, inga heltalskoder för manövrar och ingen
 * (lat, lon)-ordning. Planeraren ser `RoadPreference`, `Waypoint` och `Route`, och frågar
 * `caps` när den vill veta vad motorn klarar (CLAUDE.md: appkoden grenar ALDRIG på
 * motorns namn).
 *
 * SAMMA klass mot självhostad och hostad Valhalla. Skillnaden är `baseUrl` och en
 * valfri `apiKey`. Det är hela poängen med abstraktionen — allt annat är teater.
 *
 * ── Fyra saker adaptern gör som inte syns i interfacet, och varför ───────────
 *
 * 1. `radius` är INTE en spärr i Valhalla. Verifierat: en punkt utan väg i närheten
 *    snappade till en serviceväg 2 663 m bort, TROTS `radius: 300`. Valhalla letar
 *    vidare tills den hittar något. `SnapFilter.radiusM` ska betyda "längre bort än så
 *    här är det inte samma väg", så avvisningen görs HÄR, mot `edges[].distance`. Utan
 *    den hade ett ankarsegment som hamnade i en sjö tyst blivit en via-punkt på en väg
 *    någon helt annanstans.
 *
 * 2. `/route` returnerar INGEN vägklass. `Route.roadClassSpans` bär både `beauty()`
 *    (§5.2) och `-0.40 · motorvägsandel` i `score()` (§5.4) — utan dem är "vackrare väg"
 *    tomt prat. Vi hämtar dem med `trace_attributes` + `shape_match: "edge_walk"` över
 *    ruttens EGEN geometri. Formen kom ju ur motorn, så gången är exakt och billig
 *    (mätt: 671 kanter över 137 km). Därför gör `route()` det alltid.
 *
 * 3. Valhalla tar ett begränsat antal konturer per isokronanrop (sonderat, vår motor: 4).
 *    Upptäcktsläget vill ha fem. Adaptern delar upp anropet och sätter ihop svaret i den
 *    ordning anroparen frågade.
 *
 * 4. Cachen. `locate` på samma ankarpunkt frågas om och om igen av planeraren, och
 *    baseline-rutten en gång per svep. Se cache.ts för livslängderna.
 */

import { decode6, encode6, haversine, length } from '@mindful/core';
import type {
  EngineCapabilities, LngLat, Maneuver, ManeuverModifier, ManeuverType, RoadClass,
  RoadPreference, Route, RouteProvider, RouteRequest, SnapFilter, SnappedPoint, Span,
  Surface,
} from '@mindful/core';
import { RouteEngineError } from '@mindful/core';

import { ValhallaHttp, costingOf, detectCapabilities } from './caps.js';
import type { DetectOptions, IsochroneCaps } from './caps.js';
import { NO_CACHE, cacheKey, coordKey, coordsKey, prefsHash } from './cache.js';
import type { EngineCache } from './cache.js';
import type { MatchedSpan } from './RouteProvider.js';

/**
 * `trace.max_distance` (200 km) och `trace.max_shape` (16 000 punkter). En rutt på 18 mil
 * är inte konstig i det här landet, och en tyst 400:a hade tagit bort vägklasserna —
 * alltså skönheten och motorvägsstraffet — utan att någon märkte det.
 */
const TRACE_MAX_M = 180_000;
const TRACE_MAX_POINTS = 12_000;

// ─── Vårt språk → Valhallas ─────────────────────────────────────────────────

interface ValhallaLocation {
  lat: number;
  lon: number;
  type?: 'break' | 'through';
  radius?: number;
  minimum_reachability?: number;
  heading?: number;
  heading_tolerance?: number;
  search_filter?: {
    min_road_class?: string;
    max_road_class?: string;
  };
}

/**
 * `RoadPreference` → `costing_options.auto`. Bor i caps.ts, för sonderingen måste tala
 * exakt samma dialekt som skarpa anrop — annars mäter den en annan motor än den vi kör.
 *
 * `use_highways` är EN ratt för både motorväg och trunk; Valhalla skiljer dem inte åt i
 * kostnadsmodellen. Vi tar `min(motorway, trunk)`, alltså den mest undvikande av de två.
 * Det är rätt: `score()` straffar `motorway + trunk` som en enda andel (§5.4) och
 * kontraktets måltal är "motorväg + trunk < 5 %" (§7). Att medelvärdesbilda hade gjort
 * motorvägen billigare än vad produkten säger att den är.
 *
 * ⛔ `shortest: true` sätts ALDRIG. Den slår ut alla andra kostnader, inklusive våra
 *    preferenser (CONTRACT §2.1).
 */

function locationOf(w: {
  at: LngLat; kind: 'break' | 'through'; snap?: SnapFilter;
  headingDeg?: number; headingToleranceDeg?: number;
}): ValhallaLocation {
  const loc: ValhallaLocation = { lon: w.at[0], lat: w.at[1], type: w.kind };

  const snap = w.snap;
  if (snap) {
    if (snap.radiusM !== undefined) loc.radius = snap.radiusM;
    if (snap.minReachability !== undefined) loc.minimum_reachability = snap.minReachability;

    // `minimum_reachability` är en LOKATIONS-parameter, inte en search_filter-nyckel.
    // Valhalla ignorerar tyst okända nycklar i search_filter — lägger man den på fel
    // ställe får man alltså inget fel, bara ett filter som aldrig gjorde något.
    const filter: { min_road_class?: string; max_road_class?: string } = {};
    if (snap.minRoadClass !== undefined) filter.min_road_class = valhallaClass(snap.minRoadClass);
    if (snap.maxRoadClass !== undefined) filter.max_road_class = valhallaClass(snap.maxRoadClass);
    if (Object.keys(filter).length > 0) loc.search_filter = filter;
  }

  if (w.headingDeg !== undefined) loc.heading = w.headingDeg;
  if (w.headingToleranceDeg !== undefined) loc.heading_tolerance = w.headingToleranceDeg;

  return loc;
}

/**
 * Vår `RoadClass` → Valhallas `road_class`.
 *
 * `living_street` och `track` finns inte i Valhallas klasshierarki — de bor i `use`. En
 * `search_filter` på dem hade filtrerat på en klass som inte finns, och Valhalla hade tyst
 * släppt igenom allt. Vi översätter dem till närmaste klass i hierarkin i stället, så att
 * filtret betyder något: "inget större än en villagata".
 */
function valhallaClass(c: RoadClass): string {
  if (c === 'living_street') return 'residential';
  if (c === 'track') return 'service_other';
  return c;
}

// ─── Valhallas språk → vårt ─────────────────────────────────────────────────

/**
 * Manöverkoderna. Varje rad utom de fyra markerade är VERIFIERAD mot riktiga svar från
 * motorn — koden lästes tillsammans med den svenska instruktionen den kom med:
 *
 *    1 "Kör mot sydöst."                     8  "Fortsätt."
 *    2 "Kör mot nordväst på Gustav Adolfs…"  9  "Sväng höger mot Kungsholmen."
 *    3 "Kör mot nordöst på Götevägen."      10  "Sväng höger in på Malmtorgsgatan."
 *    4 "Du har anlänt till din destination." 13 "Gör en vänster U-sväng…"
 *    5 "Din destination är till höger."      14 "Gör en skarp sväng till vänster."
 *    6 "Din destination är till vänster."    15 "Sväng vänster in på Jakobsgatan."
 *   16 "Sväng vänster in på Ängsvägen."      17 "Håll rakt fram för att ta E 18-påfarten."
 *   18 "Sväng höger för att ta påfarten…"    19 "Ta E 6-påfarten till vänster."
 *   20 "Ta avfart 186 mot Uppsala S C."      21 "Ta avfarten till vänster mot Stockholm."
 *   22 "Håll rakt fram för att stanna kvar…" 23 "Håll höger för att stanna kvar…"
 *   24 "Håll vänster för att ta E 4…"        26 "Kör in i rondellen och ta den 2:a avfarten."
 *   27 "Kör ut ur rondellen."                28 "Ta Gräsöleden/C 1184 Färja."
 *   29 "Kör mot nordöst på Gräsövägen."
 *
 * ⚠️ 0, 7, 11, 12, 25, 37 och 38 dök inte upp i något av sonderingssvepen (svenska OSM-data
 *    har nästan inga `merge`-manövrar, och `becomes` är sällsynt). De är speglingar av
 *    koder vi SÅG — 11 av 14, 12 av 13 — eller ofarliga i sitt fall: en okänd kod faller
 *    tillbaka på `continue`, och rösten säger då ingenting extra. Vi hittar aldrig på en
 *    manöver vi inte sett.
 */
const MANEUVER: Readonly<Record<number, { type: ManeuverType; modifier?: ManeuverModifier }>> = {
  0: { type: 'continue' },
  1: { type: 'depart' },
  2: { type: 'depart', modifier: 'right' },
  3: { type: 'depart', modifier: 'left' },
  4: { type: 'arrive' },
  5: { type: 'arrive', modifier: 'right' },
  6: { type: 'arrive', modifier: 'left' },
  7: { type: 'continue' },                        // becomes
  8: { type: 'continue' },
  9: { type: 'turn', modifier: 'slight_right' },
  10: { type: 'turn', modifier: 'right' },
  11: { type: 'turn', modifier: 'sharp_right' },
  12: { type: 'uturn', modifier: 'right' },
  13: { type: 'uturn', modifier: 'left' },
  14: { type: 'turn', modifier: 'sharp_left' },
  15: { type: 'turn', modifier: 'left' },
  16: { type: 'turn', modifier: 'slight_left' },
  17: { type: 'fork', modifier: 'straight' },     // ramp
  18: { type: 'fork', modifier: 'right' },
  19: { type: 'fork', modifier: 'left' },
  20: { type: 'exit', modifier: 'right' },
  21: { type: 'exit', modifier: 'left' },
  22: { type: 'fork', modifier: 'straight' },     // stay
  23: { type: 'fork', modifier: 'right' },
  24: { type: 'fork', modifier: 'left' },
  25: { type: 'merge' },
  26: { type: 'roundabout_enter' },
  27: { type: 'roundabout_exit' },
  28: { type: 'ferry' },
  29: { type: 'ferry' },
  37: { type: 'merge', modifier: 'right' },
  38: { type: 'merge', modifier: 'left' },
};

/** Sonderat: `road_class` antar exakt dessa värden i svaren. */
const ROAD_CLASS: Readonly<Record<string, RoadClass>> = {
  motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary',
  tertiary: 'tertiary', unclassified: 'unclassified', residential: 'residential',
  service_other: 'service_other',
};

/** Sonderat: `surface` antar `paved_smooth` / `paved` / `compacted` / `gravel` / `dirt` / … */
const SURFACE: Readonly<Record<string, Surface>> = {
  paved_smooth: 'paved', paved: 'paved', paved_rough: 'paved',
  compacted: 'gravel', gravel: 'gravel',
  dirt: 'dirt', path: 'dirt',
  impassable: 'unknown',
};

/**
 * Vägklassen. `use` slår `road_class`: en `living_street` och en `track` är hos Valhalla
 * bara en `residential` respektive en `service_other` med ett särskilt `use` (verifierat i
 * /locate: `classification: "service_other", use: "track"`) — men i vårt kontrakt är de
 * egna klasser med egen skönhet (0,70 och 0,75 mot 0,60 och 0,35, §5.2). Läser vi bara
 * `road_class` blir grusvägen genom skogen lika ful som en parkeringsficka.
 */
function roadClassOf(roadClass?: string, use?: string): RoadClass {
  if (use === 'living_street') return 'living_street';
  if (use === 'track') return 'track';
  return (roadClass !== undefined ? ROAD_CLASS[roadClass] : undefined) ?? 'service_other';
}

const surfaceOf = (s?: string): Surface =>
  (s !== undefined ? SURFACE[s] : undefined) ?? 'unknown';

/**
 * Svenska riksvägar saknar ofta `name` och har bara `ref` — men Valhalla lägger båda i
 * samma `street_names`-lista. Sonderat: `["E 4", "E 04"]`, `["Gräsövägen", "C 1184"]`,
 * `["75"]`, `["E 4.25"]`. Vi delar på dem här så att `Maneuver.streetRef` blir det
 * kontraktet lovar (§2.2), och rösten kan komponera "väg 27" i stället för att läsa upp
 * det nakna talet.
 *
 * En vägnummerbeteckning är ett tal, eventuellt med länsbokstav eller E framför, och
 * ibland med en avfartsdecimal ("E 4.25"). Ett gatunamn är ord. De går inte att förväxla.
 */
const REF_PATTERN = /^(?:E\s?\d{1,3}(?:\.\d{1,2})?|[A-ZÅÄÖ]{1,2}\s?\d{1,4}|\d{1,4})$/;

function namesOf(streetNames?: readonly string[]): { name?: string; ref?: string } {
  const out: { name?: string; ref?: string } = {};
  for (const n of streetNames ?? []) {
    const trimmed = n.trim();
    if (trimmed === '') continue;
    if (REF_PATTERN.test(trimmed)) out.ref ??= trimmed;
    else out.name ??= trimmed;
  }
  return out;
}

// ─── Rådata från Valhalla ───────────────────────────────────────────────────

interface RawManeuver {
  type: number;
  instruction?: string;
  street_names?: string[];
  time: number;
  length: number;                 // kilometer (units: kilometers)
  begin_shape_index: number;
  end_shape_index: number;
  roundabout_exit_count?: number;
}

interface RawLeg {
  shape: string;
  maneuvers: RawManeuver[];
  summary: { time: number; length: number };
}

interface RawTrip {
  legs: RawLeg[];
  summary: { time: number; length: number };
}

interface RawEdge {
  road_class?: string;
  use?: string;
  surface?: string;
  way_id?: number;
  begin_shape_index: number;
  end_shape_index: number;
}

interface RawLocateEdge {
  correlated_lat: number;
  correlated_lon: number;
  distance: number;               // meter från frågepunkten till snappningen
  edge?: { classification?: { classification?: string; use?: string; surface?: string } };
  edge_info?: { names?: string[] };
}

// ─── Fabriken ───────────────────────────────────────────────────────────────

export interface ValhallaOptions extends DetectOptions {
  readonly baseUrl: string;
  /** Hostad Valhalla. Självhostad har ingen — det är hela skillnaden. */
  readonly apiKey?: string;
  readonly cache?: EngineCache;
}

/**
 * Sondera motorn och bygg adaptern av svaret. Enda vägen in: en `ValhallaProvider` utan
 * sonderade `caps` är en motor vi TROR något om (CONTRACT §2.3).
 */
export async function createValhalla(opts: ValhallaOptions): Promise<ValhallaProvider> {
  const detected = await detectCapabilities(opts.baseUrl, opts);
  return new ValhallaProvider(opts, detected.version, detected.caps, detected.isochrone);
}

// ─── Adaptern ───────────────────────────────────────────────────────────────

export class ValhallaProvider implements RouteProvider {
  readonly name: string;

  readonly #http: ValhallaHttp;
  readonly #cache: EngineCache;

  constructor(
    opts: ValhallaOptions,
    version: string,
    readonly caps: EngineCapabilities,
    private readonly isochroneLimits: IsochroneCaps,
  ) {
    this.name = `valhalla@${version}`;
    this.#http = new ValhallaHttp(opts.baseUrl, opts.apiKey);
    this.#cache = opts.cache ?? NO_CACHE;
  }

  // ── route ───────────────────────────────────────────────────────────────

  /**
   * `[0]` är motorns bästa. Alternativen kommer gratis i samma anrop — men bara på en ren
   * A→B: Valhalla ger 0 alternates så fort det finns en mellanliggande punkt (verifierat).
   * Det är hela skälet till att diversiteten i planeraren måste komma från VÅRA
   * ankarsegment och inte från motorn (design-v1 §3, läge (b)).
   */
  async route(req: RouteRequest): Promise<Route[]> {
    if (req.waypoints.length < 2) {
      throw new RouteEngineError('bad_request', 'en rutt behöver minst två punkter');
    }
    if (req.waypoints.length > this.caps.maxWaypoints) {
      throw new RouteEngineError(
        'bad_request', `motorn tar högst ${this.caps.maxWaypoints} punkter`,
      );
    }

    const key = this.#routeKey(req);
    if (key !== undefined) {
      const hit = await this.#cache.get<Route[]>('baseline', key);
      if (hit) return hit;
    }

    const alternates = this.#alternatesFor(req);

    const raw = await this.#http.post<{ trip?: RawTrip; alternates?: { trip: RawTrip }[] }>(
      'route', {
        locations: req.waypoints.map(locationOf),
        costing: 'auto',
        costing_options: { auto: costingOf(req.prefs) },
        directions_options: { language: req.locale, units: 'kilometers' },
        shape_format: 'polyline6',
        alternates,
      }, req.signal,
    );

    if (!raw.trip) throw new RouteEngineError('no_route', 'motorn gav ingen rutt');

    const trips = [raw.trip, ...(raw.alternates ?? []).map((a) => a.trip)];

    // Vägklasserna kommer inte ur /route. Utan dem är `beauty()` blind och
    // motorvägsstraffet noll — se filhuvudet.
    const routes = await Promise.all(
      trips.map((t, i) => this.#enrich(this.#routeOf(t, i), req.prefs, req.signal)),
    );

    if (key !== undefined) await this.#cache.set('baseline', key, routes);
    return routes;
  }

  /**
   * Bara baseline cachas: två `break`-punkter, inga mjuka kantstraff.
   *
   * En kandidatrutt går genom ett ankarsegment som valdes just för att den här
   * användaren inte kört där — den frågas aldrig igen, och att lagra den vore att fylla
   * cachen med engångssvar. `undefined` = fråga motorn, spara ingenting.
   */
  #routeKey(req: RouteRequest): string | undefined {
    if (req.waypoints.length !== 2) return undefined;
    if (req.softPenalties !== undefined && req.softPenalties.length > 0) return undefined;
    if (req.waypoints.some((w) => w.kind !== 'break' || w.snap !== undefined
      || w.headingDeg !== undefined)) return undefined;

    return cacheKey(
      this.name,
      coordsKey(req.waypoints.map((w) => w.at)),
      prefsHash(req.prefs),
      req.locale,
      `alt${this.#alternatesFor(req)}`,
    );
  }

  /** Valhalla ger 0 alternates så fort rutten har en mellanliggande punkt. Be inte om dem. */
  #alternatesFor(req: RouteRequest): number {
    if (req.waypoints.length > 2) return 0;
    return Math.min(req.alternates ?? 0, this.caps.maxAlternates);
  }

  /**
   * Ett `trip` → en `Route`.
   *
   * Benen sätts ihop till EN geometri. Med bara `through`-punkter emellan ger Valhalla ett
   * enda ben, men adaptern får inte tyst tappa geometri om någon skickar in en `break` på
   * mitten — då hade rutten på kartan slutat halvvägs.
   */
  #routeOf(trip: RawTrip, index: number): Route {
    const shape: LngLat[] = [];
    const maneuvers: Maneuver[] = [];

    for (const leg of trip.legs) {
      const pts = decode6(leg.shape);
      // Skarven: benets första punkt är föregående bens sista.
      const offset = shape.length === 0 ? 0 : shape.length - 1;
      shape.push(...(shape.length === 0 ? pts : pts.slice(1)));

      for (const m of leg.maneuvers) {
        const mapped = MANEUVER[m.type] ?? { type: 'continue' as ManeuverType };
        const { name, ref } = namesOf(m.street_names);

        maneuvers.push({
          type: mapped.type,
          ...(mapped.modifier !== undefined ? { modifier: mapped.modifier } : {}),
          ...(m.roundabout_exit_count !== undefined
            ? { roundaboutExit: m.roundabout_exit_count } : {}),
          ...(name !== undefined ? { streetName: name } : {}),
          ...(ref !== undefined ? { streetRef: ref } : {}),
          distanceM: m.length * 1000,
          timeS: m.time,
          shapeIndex: [m.begin_shape_index + offset, m.end_shape_index + offset] as const,
          ...(m.instruction !== undefined ? { engineText: m.instruction } : {}),
        });
      }
    }

    return {
      id: `${this.name}#${index}`,
      geometry: encode6(shape),
      distanceM: trip.summary.length * 1000,
      timeS: trip.summary.time,
      maneuvers,
      engine: this.name,
    };
  }

  // ── Vägklasserna: trace_attributes + edge_walk ──────────────────────────

  /**
   * Fyll `roadClassSpans` och `surfaceSpans` genom att gå ruttens egen geometri.
   *
   * `edge_walk` förutsätter att formen ligger exakt på kanterna — och det gör den, den kom
   * ju ur Valhalla (sonderat: motorn ger tillbaka vår polyline oförändrad). Skulle den ändå
   * inte matcha faller vi tillbaka på `map_snap`, som söker sig fram.
   *
   * Misslyckas båda lämnas spannen tomma. Det är avsiktligt: `weightedByLength` svarar då
   * NEUTRAL_BEAUTY och `fractionOf` svarar 0 (core/scoring.ts). Vi hittar ALDRIG på en
   * vägklass vi inte observerat — hellre en kandidat utan skönhetsbetyg än en påhittad.
   */
  async #enrich(route: Route, prefs: RoadPreference, signal?: AbortSignal): Promise<Route> {
    const shape = decode6(route.geometry);
    if (shape.length < 2) return route;

    const classSpans: Span<RoadClass>[] = [];
    const surfaceSpans: Span<Surface>[] = [];

    for (const chunk of chunkShape(shape)) {
      const edges = await this.#traceEdges(
        shape.slice(chunk.from, chunk.to + 1), prefs, signal,
      );
      for (const e of edges) {
        const from = e.begin_shape_index + chunk.from;
        const to = e.end_shape_index + chunk.from;
        if (to <= from) continue;
        pushSpan(classSpans, from, to, roadClassOf(e.road_class, e.use));
        pushSpan(surfaceSpans, from, to, surfaceOf(e.surface));
      }
    }

    if (classSpans.length === 0) return route;
    return { ...route, roadClassSpans: classSpans, surfaceSpans };
  }

  async #traceEdges(
    shape: LngLat[], prefs: RoadPreference, signal?: AbortSignal,
  ): Promise<RawEdge[]> {
    if (shape.length < 2) return [];

    const body = {
      encoded_polyline: encode6(shape),
      shape_format: 'polyline6',
      costing: 'auto',
      costing_options: { auto: costingOf(prefs) },
      filters: {
        attributes: [
          'edge.road_class', 'edge.use', 'edge.surface',
          'edge.begin_shape_index', 'edge.end_shape_index',
        ],
        action: 'include',
      },
    };

    for (const shapeMatch of ['edge_walk', 'map_snap'] as const) {
      const wire = await this.#http.try<{ edges?: RawEdge[] }>(
        'trace_attributes', { ...body, shape_match: shapeMatch }, signal,
      );
      if (wire.ok && wire.value.edges && wire.value.edges.length > 0) return wire.value.edges;
      // Ett 5xx är motorn, inte formen. Att då försöka igen med map_snap vore att dölja
      // ett driftfel som en matchningsmiss.
      if (!wire.ok && wire.status >= 500) {
        throw new RouteEngineError('upstream', wire.error);
      }
    }

    return [];
  }

  // ── locate ──────────────────────────────────────────────────────────────

  /**
   * Snappa punkter till vägnätet.
   *
   * `search_filter.max_road_class` är den enskilt viktigaste parametern i hela produkten
   * (CLAUDE.md). Verifierat: en punkt som står PÅ E4 snappar till E4 på 0,0 m utan filter —
   * med `max_road_class: 'tertiary'` snappar samma punkt till en traktorväg 48,7 m bort.
   * Det är skillnaden mellan appen och en vanlig GPS.
   *
   * ⚠️ `radius` är ingen spärr. Verifierat: med `radius: 300` snappade Valhalla ändå 2 663 m
   *    bort. Därför avvisar VI allt som ligger längre bort än `radiusM` — annars blir ett
   *    ankarsegment mitt i en sjö tyst till en via-punkt på en väg någon annanstans.
   */
  async locate(points: readonly LngLat[], f?: SnapFilter): Promise<SnappedPoint[]> {
    if (points.length === 0) return [];

    const filterKey = f ? cacheKey(
      f.minRoadClass, f.maxRoadClass, f.radiusM, f.minReachability,
    ) : '';

    const keys = points.map((p) => cacheKey(this.name, coordKey(p), filterKey));
    const cached = await Promise.all(
      keys.map((k) => this.#cache.get<SnappedPoint>('locate', k)),
    );

    const missing = points
      .map((at, i) => ({ at, i }))
      .filter(({ i }) => cached[i] === undefined);

    if (missing.length === 0) return cached as SnappedPoint[];

    const raw = await this.#http.post<{ edges?: RawLocateEdge[] }[]>('locate', {
      locations: missing.map(({ at }) =>
        locationOf({ at, kind: 'break', ...(f ? { snap: f } : {}) })),
      costing: 'auto',
      verbose: true,
    });

    const maxM = f?.radiusM;
    const out = [...cached] as (SnappedPoint | undefined)[];

    for (let n = 0; n < missing.length; n++) {
      const entry = missing[n];
      if (!entry) continue;
      const { at, i } = entry;

      // Valhalla sorterar kanterna med den närmaste först (sonderat), men vi litar inte
      // på ordningen: en punkt vid en korsning ger flera kanter på samma avstånd.
      const best = closest(raw[n]?.edges);

      const snapped: SnappedPoint = (!best || (maxM !== undefined && best.distance > maxM))
        ? { at, roadClass: 'service_other', ok: false }
        : this.#snappedOf(best);

      out[i] = snapped;

      const key = keys[i];
      if (key !== undefined) await this.#cache.set('locate', key, snapped);
    }

    return out as SnappedPoint[];
  }

  #snappedOf(best: RawLocateEdge): SnappedPoint {
    const cls = best.edge?.classification;
    const { name, ref } = namesOf(best.edge_info?.names);

    return {
      at: [best.correlated_lon, best.correlated_lat] as LngLat,
      roadClass: roadClassOf(cls?.classification, cls?.use),
      ...(name !== undefined ? { name } : {}),
      ...(ref !== undefined ? { ref } : {}),
      ok: true,
    };
  }

  // ── matrix ──────────────────────────────────────────────────────────────

  /**
   * Restidsmatris. Onåbara par blir `Infinity` — inte 0, och inte ett kastat fel.
   *
   * Matrisen används som FÖRFILTER (design-v1 §3): "kan den här via-punkten över huvud
   * taget rymmas i budgeten?". Ett onåbart ankare ska falla bort på samma jämförelse som
   * ett för långsamt, inte spränga hela planeringen.
   */
  async matrix(
    sources: readonly LngLat[], targets: readonly LngLat[], p: RoadPreference,
  ): Promise<{ timeS: number[][]; distanceM: number[][] }> {
    const limit = this.caps.matrix?.maxLocations;
    if (limit === undefined) {
      throw new RouteEngineError('bad_request', 'motorn har ingen matris');
    }
    if (sources.length + targets.length > limit) {
      throw new RouteEngineError('bad_request', `matrisen tar högst ${limit} punkter`);
    }

    const raw = await this.#http.post<{
      sources_to_targets?: {
        time: number | null; distance: number | null;
        from_index: number; to_index: number;
      }[][];
    }>('sources_to_targets', {
      sources: sources.map((s) => ({ lon: s[0], lat: s[1] })),
      targets: targets.map((t) => ({ lon: t[0], lat: t[1] })),
      costing: 'auto',
      costing_options: { auto: costingOf(p) },
      units: 'kilometers',
    });

    const timeS = sources.map(() => targets.map(() => Infinity));
    const distanceM = sources.map(() => targets.map(() => Infinity));

    for (const row of raw.sources_to_targets ?? []) {
      for (const c of row) {
        const t = timeS[c.from_index];
        const d = distanceM[c.from_index];
        if (!t || !d) continue;
        t[c.to_index] = c.time ?? Infinity;
        d[c.to_index] = c.distance !== null ? c.distance * 1000 : Infinity;
      }
    }

    return { timeS, distanceM };
  }

  // ── isochrone ───────────────────────────────────────────────────────────

  /**
   * Isokroner, i SAMMA ordning som `seconds`.
   *
   * Motorn tar ett begränsat antal konturer per anrop (sonderat: 4 hos oss) och svarar med
   * den största först. Upptäcktsläget vill ha fem (15/30/45/60/90 min). Adaptern delar upp
   * anropet och sorterar tillbaka svaret — planeraren ska aldrig behöva veta det.
   */
  async isochrone(
    from: LngLat, seconds: readonly number[], p: RoadPreference,
  ): Promise<GeoJSON.Polygon[]> {
    if (!this.caps.isochrone) {
      throw new RouteEngineError('bad_request', 'motorn har inga isokroner');
    }
    if (seconds.length === 0) return [];

    const minutes = seconds.map((s) => s / 60);
    const over = minutes.find((m) => m > this.isochroneLimits.maxTimeMin);
    if (over !== undefined) {
      throw new RouteEngineError(
        'bad_request',
        `isokroner går till ${this.isochroneLimits.maxTimeMin} minuter, inte ${over}`,
      );
    }

    const key = cacheKey(
      this.name, coordKey(from), prefsHash(p), minutes.map((m) => m.toFixed(2)).join(','),
    );
    const hit = await this.#cache.get<GeoJSON.Polygon[]>('isochrone', key);
    if (hit) return hit;

    const out: (GeoJSON.Polygon | undefined)[] = new Array(seconds.length).fill(undefined);
    const step = Math.max(1, this.isochroneLimits.maxContours);

    for (let start = 0; start < minutes.length; start += step) {
      const batch = minutes.slice(start, start + step);

      const raw = await this.#http.post<{
        features?: { geometry: GeoJSON.Polygon; properties: { contour?: number } }[];
      }>('isochrone', {
        locations: [{ lon: from[0], lat: from[1] }],
        costing: 'auto',
        costing_options: { auto: costingOf(p) },
        contours: batch.map((time) => ({ time })),
        polygons: true,
        denoise: 0.5,
        generalize: 100,
      });

      for (const f of raw.features ?? []) {
        const contour = f.properties.contour;
        if (contour === undefined) continue;
        // Matcha tillbaka på konturvärdet: motorn svarar i fallande ordning, och
        // konturerna kan vara bråkdelar av minuter.
        const at = batch.findIndex((m) => Math.abs(m - contour) < 1e-6);
        if (at >= 0) out[start + at] = f.geometry;
      }
    }

    const done: GeoJSON.Polygon[] = [];
    for (let i = 0; i < out.length; i++) {
      const poly = out[i];
      if (!poly) {
        throw new RouteEngineError('no_route', `ingen isokron för ${seconds[i]} sekunder`);
      }
      done.push(poly);
    }

    await this.#cache.set('isochrone', key, done);
    return done;
  }

  // ── mapMatch ────────────────────────────────────────────────────────────

  /**
   * Ett råspår → vägnätets kanter, med `way_id`. Bär v2:s way-baserade minne (§2.4).
   *
   * `map_snap` och inte `edge_walk`: ett GPS-spår ligger INTE på kanterna. Det driver
   * några meter, tappar signalen under en viadukt och hoppar. Att kräva exakt gång på ett
   * observerat spår vore att kräva att verkligheten var felfri.
   *
   * Kanter utan `way_id` (motorns egna transitioner) får `wayId: undefined` i stället för
   * ett påhittat id. Vi hittar aldrig på en väg vi inte observerat (§3.4).
   */
  async mapMatch(shape: readonly LngLat[]): Promise<MatchedSpan[]> {
    if (!this.caps.mapMatchWayIds) {
      throw new RouteEngineError('bad_request', 'motorn kan inte map-matcha');
    }
    if (shape.length < 2) return [];

    const out: MatchedSpan[] = [];

    for (const chunk of chunkShape(shape)) {
      const part = shape.slice(chunk.from, chunk.to + 1);

      const raw = await this.#http.post<{ shape?: string; edges?: RawEdge[] }>(
        'trace_attributes', {
          encoded_polyline: encode6(part),
          shape_format: 'polyline6',
          shape_match: 'map_snap',
          costing: 'auto',
          filters: {
            attributes: [
              'shape', 'edge.way_id', 'edge.begin_shape_index', 'edge.end_shape_index',
            ],
            action: 'include',
          },
        },
      );

      // Indexen pekar in i den MATCHADE formen, inte i vår. Vid map_snap är de två inte
      // samma kurva — vi läser alltid motorns egen shape tillbaka.
      const matched = raw.shape !== undefined ? decode6(raw.shape) : part;

      for (const e of raw.edges ?? []) {
        const seg = matched.slice(e.begin_shape_index, e.end_shape_index + 1);
        if (seg.length < 2) continue;
        out.push({
          ...(e.way_id !== undefined ? { wayId: e.way_id } : {}),
          shape: seg,
        });
      }
    }

    return out;
  }
}

// ─── Hjälpare ───────────────────────────────────────────────────────────────

function closest(edges?: readonly RawLocateEdge[]): RawLocateEdge | undefined {
  let best: RawLocateEdge | undefined;
  for (const e of edges ?? []) {
    if (!best || e.distance < best.distance) best = e;
  }
  return best;
}

/** Slå ihop med föregående spann om värdet är detsamma. Håller spannlistan kort. */
function pushSpan<T>(spans: Span<T>[], fromIdx: number, toIdx: number, value: T): void {
  const last = spans[spans.length - 1];
  if (last && last.value === value && last.toIdx === fromIdx) {
    spans[spans.length - 1] = { fromIdx: last.fromIdx, toIdx, value };
    return;
  }
  spans.push({ fromIdx, toIdx, value });
}

/** Dela formen i bitar som ryms i `trace_attributes` gränser (200 km / 16 000 punkter). */
function chunkShape(shape: readonly LngLat[]): { from: number; to: number }[] {
  if (length(shape) <= TRACE_MAX_M && shape.length <= TRACE_MAX_POINTS) {
    return [{ from: 0, to: shape.length - 1 }];
  }

  const chunks: { from: number; to: number }[] = [];
  let from = 0;
  let metres = 0;

  for (let i = 1; i < shape.length; i++) {
    const prev = shape[i - 1];
    const cur = shape[i];
    if (!prev || !cur) break;

    metres += haversine(prev, cur);

    if (metres >= TRACE_MAX_M || i - from >= TRACE_MAX_POINTS - 1) {
      chunks.push({ from, to: i });
      from = i;              // bitarna delar skarvpunkt — inget spann tappas
      metres = 0;
    }
  }

  if (from < shape.length - 1) chunks.push({ from, to: shape.length - 1 });
  return chunks;
}
