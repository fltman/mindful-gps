/**
 * Kapabilitetssondering. CONTRACT §2.3.
 *
 * Vi VET vad vår egen Valhalla svarar. Vi frågar ändå — för det är hela poängen med
 * abstraktionen. En annan motor på en annan bas-URL svarar annorlunda, och planeraren
 * ska degradera på ett SVAR, aldrig på ett antagande:
 *
 *   const plan = engine.caps.softEdgePenalties
 *     ? planWithSoftPenalties(engine, memory)
 *     : planByThroughSegments(engine, memory);
 *
 * Varje flagga här kommer ur ett riktigt anrop mot en riktig motor. Ingen kommer ur
 * versionsnumret ensamt, och ingen kommer ur dokumentationen. Det gäller särskilt de två
 * icke-förhandlingsbara primitiverna (CLAUDE.md): utan `through` och utan
 * `search_filter.max_road_class` är produkten inte byggbar, och då ska uppstarten SÄGA
 * det, högt, i tabellen den skriver ut — inte upptäckas som konstiga rutter i juli.
 *
 * ── Varför gränserna sonderas med FÖR STORA anrop ────────────────────────────
 * Valhalla kollar `service_limits` i loki, INNAN någon graf rörs, och svarar
 * `"Exceeded max locations: 20"`. Talet vi vill ha står alltså i motorns eget felmeddelande,
 * och det kostar 30 ms att fråga (mätt: 512 punkter → fel på 0,03 s; 10 000 matrispunkter
 * → fel på 0,1 s). Att i stället hårdkoda 20 hade varit att gissa åt en motor vi inte
 * äger.
 *
 * ── Wiren bor här, och inte i ValhallaProvider ───────────────────────────────
 * Sonderingen är det FÖRSTA som talar med motorn, och providern byggs av dess svar.
 * Beroendepilen pekar alltså åt ett håll: caps → wire, provider → caps. Låg wiren i
 * providern skulle den och sonderingen importera varandra.
 */

import type { EngineCapabilities, LngLat, RoadPreference } from '@mindful/core';
import { MINDFUL, RouteEngineError, decode6 } from '@mindful/core';

// ─── Wiren ──────────────────────────────────────────────────────────────────

/** Ett svar från Valhalla — lyckat, eller motorns eget fel med kod och text. */
export type Wire<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly errorCode?: number;
      readonly error: string };

export class ValhallaHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  /** Bas-URL utan avslutande snedstreck, plus nyckeln om motorn är hostad. */
  #url(action: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    return this.apiKey !== undefined
      ? `${base}/${action}?api_key=${encodeURIComponent(this.apiKey)}`
      : `${base}/${action}`;
  }

  /** Svarar med felet i stället för att kasta. Sonderingen VILL ha felkroppen. */
  async try<T>(action: string, body: unknown, signal?: AbortSignal): Promise<Wire<T>> {
    let res: Response;
    try {
      res = await fetch(this.#url(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Motorn nås inte alls. Det är inget svar — det är frånvaro av motor.
      throw new RouteEngineError('upstream', `Valhalla nås inte: ${String(err)}`);
    }

    if (res.ok) return { ok: true, value: await res.json() as T };

    const detail = await res.json().catch(() => ({})) as {
      error?: string; error_code?: number;
    };
    return {
      ok: false,
      status: res.status,
      ...(detail.error_code !== undefined ? { errorCode: detail.error_code } : {}),
      error: detail.error ?? `Valhalla svarade ${res.status} på /${action}`,
    };
  }

  /** Fel kastas som `RouteEngineError` med vår kod — aldrig som ett rått HTTP-fel (§0.6). */
  async post<T>(action: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const wire = await this.try<T>(action, body, signal);
    if (wire.ok) return wire.value;
    throw new RouteEngineError(codeOf(wire.status, wire.errorCode), wire.error);
  }

  async status(signal?: AbortSignal): Promise<{ version: string; actions: Set<string> }> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = this.apiKey !== undefined
      ? `${base}/status?api_key=${encodeURIComponent(this.apiKey)}`
      : `${base}/status`;

    let res: Response;
    try {
      res = await fetch(url, { ...(signal ? { signal } : {}) });
    } catch (err) {
      throw new RouteEngineError('upstream', `Valhalla nås inte: ${String(err)}`);
    }
    if (!res.ok) {
      throw new RouteEngineError('upstream', `Valhalla svarade ${res.status} på /status`);
    }

    const body = await res.json() as { version?: string; available_actions?: string[] };
    return {
      version: body.version ?? '0.0.0',
      actions: new Set(body.available_actions ?? []),
    };
  }
}

/**
 * Valhallas felkoder → våra.
 *
 * 171/172 = inga kanter nära punkten, 442–445 = ingen väg fanns. Båda betyder att FRÅGAN
 * var rimlig men svaret inte finns — planeraren släpper kandidaten och går vidare i
 * stället för att avbryta hela svepet.
 */
export function codeOf(httpStatus: number, errorCode?: number): RouteEngineError['code'] {
  if (httpStatus === 429) return 'rate_limit';
  if (httpStatus === 401 || httpStatus === 403) return 'quota';
  if (httpStatus >= 500) return 'upstream';

  const noRoute = new Set([171, 172, 442, 443, 444, 445]);
  if (errorCode !== undefined && noRoute.has(errorCode)) return 'no_route';

  return 'bad_request';
}

// ─── Sonderingen ────────────────────────────────────────────────────────────

/**
 * Två punkter i det område motorn faktiskt har tiles för, tillräckligt långt isär att en
 * motorväg är det naturliga valet mellan dem. Utan det avståndet går `softRoadPreference`
 * inte att sondera: på tre kilometer i en småstad finns ingen motorväg att välja bort, och
 * en motor som ignorerar `use_highways` hade sett likadan ut som en som lyder.
 */
export interface ProbePair {
  readonly from: LngLat;
  readonly to: LngLat;
}

/** Växjö → Kalmar. 110 km, och motorvägen mellan dem är precis den vi bygger appen för. */
export const DEFAULT_PROBE: ProbePair = {
  from: [14.8059, 56.8777],
  to: [16.3616, 56.6634],
};

export interface DetectOptions {
  readonly probe?: ProbePair;
  readonly apiKey?: string;
  /** Kan inte sonderas — en kvot syns först när den redan är slut. Kommer ur konfig. */
  readonly requestsPerSecond?: number | null;
  readonly log?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface Detected {
  readonly version: string;
  readonly caps: EngineCapabilities;
  /**
   * Isokronernas gränser. De ryms inte i `EngineCapabilities` (fruset — `isochrone` är
   * ett `boolean` där), men adaptern måste veta dem för att kunna dela upp ett anrop på
   * fem konturer i två. Planeraren ber om de tider den vill ha och behöver aldrig veta det.
   */
  readonly isochrone: IsochroneCaps;
}

/** Cache per bas-URL. Sonderingen är dyr en gång och gratis resten av processens liv. */
const detected = new Map<string, Promise<Detected>>();

export function detectCapabilities(baseUrl: string, opts: DetectOptions = {}): Promise<Detected> {
  const hit = detected.get(baseUrl);
  if (hit) return hit;

  const run = probeAll(baseUrl, opts).catch((err: unknown) => {
    detected.delete(baseUrl);      // ett misslyckat svep får inte cachas som sanning
    throw err;
  });

  detected.set(baseUrl, run);
  return run;
}

/** Bara för tester: glöm det vi sonderat. */
export function forgetCapabilities(): void {
  detected.clear();
}

async function probeAll(baseUrl: string, opts: DetectOptions): Promise<Detected> {
  const http = new ValhallaHttp(baseUrl, opts.apiKey);
  const probe = opts.probe ?? DEFAULT_PROBE;
  const log = opts.log ?? ((line: string) => console.info(line));
  const signal = opts.signal;

  const { version, actions } = await http.status(signal);

  // Den fria rutten: bär `maxAlternates`, `nativeSwedish`, referensen för
  // `softRoadPreference` och geometrin som `mapMatchWayIds` går på. Ett anrop, fyra svar.
  const free = await routeProbe(http, probe, {}, 5, signal);

  const [
    soft, through, snapFilter, wayIds, waypointLimit, matrixLimit, isochrone,
  ] = await Promise.all([
    probeSoftRoadPreference(http, probe, free, signal),
    probeThroughWaypoints(http, probe, free, signal),
    probeSnapRoadClassFilter(http, probe, signal),
    probeMapMatchWayIds(http, free.shape, signal),
    probeMaxWaypoints(http, probe, signal),
    probeMatrixLimit(http, probe, signal),
    probeIsochrone(http, probe, signal),
  ]);

  const softEdges = await probeSoftEdgePenalties(http, probe, free, version, signal);

  const caps: EngineCapabilities = {
    softRoadPreference: soft,
    softEdgePenalties: softEdges,
    throughWaypoints: through,
    snapRoadClassFilter: snapFilter,
    maxAlternates: free.alternates,
    maxWaypoints: waypointLimit,
    matrix: matrixLimit !== null ? { maxLocations: matrixLimit } : null,
    isochrone: isochrone.ok,
    mapMatchWayIds: wayIds,
    nativeSwedish: free.language === 'sv-SE',
    requestsPerSecond: opts.requestsPerSecond ?? null,
  };

  logTable(log, baseUrl, version, actions, caps, isochrone);

  const result: Detected = { version, caps, isochrone };

  if (!caps.throughWaypoints || !caps.snapRoadClassFilter) {
    // Produkten står och faller med dessa två (CLAUDE.md). En motor utan dem kan ge
    // rutter — men inte VÅRA rutter, och tystnad här hade blivit "appen känns konstig".
    throw new RouteEngineError(
      'upstream',
      `motorn på ${baseUrl} saknar through-waypoints eller road-class-filtrerad snappning`,
    );
  }

  return result;
}

// ─── De enskilda sonderingarna ──────────────────────────────────────────────

interface RouteProbe {
  readonly distanceM: number;
  readonly timeS: number;
  readonly shape: string;
  readonly legs: number;
  readonly alternates: number;
  readonly language: string;
  readonly uturns: number;
}

const UTURN_TYPES = new Set([12, 13]);

async function routeProbe(
  http: ValhallaHttp,
  probe: ProbePair,
  costing: Record<string, number>,
  alternates: number,
  signal?: AbortSignal,
  middle?: { readonly at: LngLat; readonly kind: 'through' | 'break' },
): Promise<RouteProbe> {
  const locations = [
    { lon: probe.from[0], lat: probe.from[1] },
    ...(middle ? [{ lon: middle.at[0], lat: middle.at[1], type: middle.kind }] : []),
    { lon: probe.to[0], lat: probe.to[1] },
  ];

  const raw = await http.post<{
    trip?: {
      legs: { shape: string; maneuvers: { type: number }[] }[];
      summary: { length: number; time: number };
      language?: string;
    };
    alternates?: unknown[];
  }>('route', {
    locations,
    costing: 'auto',
    costing_options: { auto: costing },
    directions_options: { language: 'sv-SE', units: 'kilometers' },
    shape_format: 'polyline6',
    alternates,
  }, signal);

  const trip = raw.trip;
  if (!trip) {
    throw new RouteEngineError('upstream', 'sonderingsrutten gav ingen rutt — fel probe-par?');
  }

  return {
    distanceM: trip.summary.length * 1000,
    timeS: trip.summary.time,
    shape: trip.legs[0]?.shape ?? '',
    legs: trip.legs.length,
    alternates: (raw.alternates ?? []).length,
    language: trip.language ?? '',
    uturns: trip.legs.reduce(
      (n, leg) => n + leg.maneuvers.filter((m) => UTURN_TYPES.has(m.type)).length, 0),
  };
}

/**
 * Lyder motorn en MJUK vägklasspreferens?
 *
 * Kör sonderingsparet en gång till med `use_highways` från MINDFUL och jämför med den
 * fria rutten. Lyder motorn måste rutten bli en ANNAN — längre, långsammare, eller båda.
 * Blir den bit för bit densamma är preferensen dekoration, och då är `softRoadPreference`
 * falskt oavsett vad leverantörens dokumentation lovar.
 *
 * Tröskeln är 2 % på distansen: mindre än så är avrundning i en delad kant, inte ett val.
 */
async function probeSoftRoadPreference(
  http: ValhallaHttp, probe: ProbePair, free: RouteProbe, signal?: AbortSignal,
): Promise<boolean> {
  const avoiding = await routeProbe(http, probe, costingOf(MINDFUL), 0, signal);
  const changed = Math.abs(avoiding.distanceM - free.distanceM) / Math.max(1, free.distanceM);
  return changed > 0.02 || avoiding.shape !== free.shape;
}

/**
 * `location.type: "through"` — den ena av de två primitiverna produkten står på.
 *
 * Beviset: en mellanpunkt som `through` ger ETT ben. Hade motorn tolkat den som en
 * `break` (eller tyst ignorerat nyckeln) hade svaret haft TVÅ ben. Och en motor som
 * "löser" through med en u-sväng har inte förstått frågan — den räknar inte heller.
 *
 * ⚠️ Punkten tas ur den FRIA ruttens egen geometri, inte ur den geometriska mittpunkten
 *    mellan A och B. Mätt: mittpunkten Växjö–Kalmar snappar till en väg där rutten måste
 *    vända, och motorn svarade helt korrekt med ett ben OCH en u-sväng — sonderingen hade
 *    då underkänt en motor som gör precis rätt. En punkt rutten redan passerar kan bara
 *    ge u-sväng om motorn inte förstått `through`.
 */
async function probeThroughWaypoints(
  http: ValhallaHttp, probe: ProbePair, free: RouteProbe, signal?: AbortSignal,
): Promise<boolean> {
  const shape = decode6(free.shape);
  const mid = shape[Math.floor(shape.length / 2)];
  if (!mid) return false;

  const r = await routeProbe(http, probe, {}, 0, signal, { at: mid, kind: 'through' });
  return r.legs === 1 && r.uturns === 0;
}

/**
 * `search_filter.max_road_class` — den andra primitiven, och den enskilt mest
 * underskattade parametern i hela researchen (CLAUDE.md).
 *
 * Sonderingen är regionsoberoende: snappa punkten fritt, läs vilken klass den landade
 * på, och fråga sedan igen med ett filter som utesluter PRECIS den klassen. Lyder motorn
 * måste den landa någon annanstans. Ignorerar den filtret får vi exakt samma kant
 * tillbaka.
 *
 * Verifierat mot vår motor: en punkt som står PÅ E4 snappar till E4 på 0,0 m utan filter,
 * och till en traktorväg 48,7 m bort med `max_road_class: "tertiary"`.
 */
async function probeSnapRoadClassFilter(
  http: ValhallaHttp, probe: ProbePair, signal?: AbortSignal,
): Promise<boolean> {
  const free = await locateProbe(http, probe.from, undefined, signal);
  if (!free) {
    throw new RouteEngineError(
      'bad_request',
      'sonderingspunkten snappar inte till någon väg — välj ett probe-par vid vägnätet',
    );
  }

  // Uteslut den klass den fria snappningen valde. Motorväg utesluts uppåt, allt annat nedåt.
  const filter: Record<string, string> = free.roadClass === 'motorway'
    ? { max_road_class: 'residential' }
    : { min_road_class: 'motorway' };

  const filtered = await locateProbe(http, probe.from, filter, signal);
  if (!filtered) return true;      // filtret uteslöt allt i närheten — det bet, alltså

  return filtered.roadClass !== free.roadClass
    || Math.abs(filtered.at[0] - free.at[0]) > 1e-6
    || Math.abs(filtered.at[1] - free.at[1]) > 1e-6;
}

interface LocateProbe {
  readonly at: LngLat;
  readonly roadClass: string;
}

async function locateProbe(
  http: ValhallaHttp,
  at: LngLat,
  searchFilter: Record<string, string> | undefined,
  signal?: AbortSignal,
): Promise<LocateProbe | undefined> {
  const raw = await http.post<{
    edges?: {
      correlated_lat: number; correlated_lon: number;
      edge?: { classification?: { classification?: string } };
    }[];
  }[]>('locate', {
    locations: [{
      lon: at[0], lat: at[1],
      ...(searchFilter ? { search_filter: searchFilter } : {}),
    }],
    costing: 'auto',
    verbose: true,
  }, signal);

  const best = raw[0]?.edges?.[0];
  if (!best) return undefined;

  return {
    at: [best.correlated_lon, best.correlated_lat],
    roadClass: best.edge?.classification?.classification ?? 'okänd',
  };
}

/** `trace_attributes` → `edge.way_id`. Bär v2:s way-baserade minne. */
async function probeMapMatchWayIds(
  http: ValhallaHttp, shape: string, signal?: AbortSignal,
): Promise<boolean> {
  if (shape === '') return false;

  const wire = await http.try<{ edges?: { way_id?: number }[] }>('trace_attributes', {
    encoded_polyline: shape,
    shape_format: 'polyline6',
    shape_match: 'edge_walk',
    costing: 'auto',
    filters: { attributes: ['edge.way_id'], action: 'include' },
  }, signal);

  return wire.ok && (wire.value.edges ?? []).some((e) => e.way_id !== undefined);
}

/**
 * `linear_cost_factors` (Valhalla ≥ 3.7). Endgame-planeraren straffar kända kanter direkt
 * i motorn i stället för att tvinga rutten genom okända med `through`.
 *
 * Två grindar, i den ordningen:
 *   1. Versionen. Under 3.7 finns fältet inte, och en okänd nyckel ignoreras TYST av
 *      Valhalla — då hade ett beteendetest gett falskt negativt av rätt skäl men ett
 *      onödigt 110 km-anrop.
 *   2. Beteendet. Straffa hela den fria ruttens egen geometri med faktor 10 och se om
 *      rutten flyttar sig. Gör den inte det finns förmågan inte, hur versionen än ser ut.
 *
 * Vår motor är 3.5.1 → falskt, och planeraren kör through-segmentvägen. Det var alltid
 * plan A.
 */
async function probeSoftEdgePenalties(
  http: ValhallaHttp, probe: ProbePair, free: RouteProbe, version: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!atLeast(version, [3, 7, 0])) return false;
  if (free.shape === '') return false;

  const wire = await http.try<{ trip?: { legs: { shape: string }[] } }>('route', {
    locations: [
      { lon: probe.from[0], lat: probe.from[1] },
      { lon: probe.to[0], lat: probe.to[1] },
    ],
    costing: 'auto',
    costing_options: {
      auto: { linear_cost_factors: [{ shape: free.shape, factor: 10 }] },
    },
    directions_options: { language: 'sv-SE', units: 'kilometers' },
    shape_format: 'polyline6',
  }, signal);

  if (!wire.ok) return false;
  return wire.value.trip?.legs[0]?.shape !== free.shape;
}

/** Talet står i motorns eget felmeddelande: "Exceeded max locations: 20". */
async function probeMaxWaypoints(
  http: ValhallaHttp, probe: ProbePair, signal?: AbortSignal,
): Promise<number> {
  const OVER = 512;
  const wire = await http.try('route', {
    locations: new Array<{ lon: number; lat: number }>(OVER).fill(
      { lon: probe.from[0], lat: probe.from[1] }),
    costing: 'auto',
  }, signal);

  if (wire.ok) return OVER;                  // motorn tog emot 512 — vi når inte väggen
  return limitIn(wire.error) ?? 2;           // 2 är golvet: en rutt är alltid A→B
}

/** Samma trick. Vår motor: 2 500 (fel på 0,1 s — gränsen prövas före all beräkning). */
async function probeMatrixLimit(
  http: ValhallaHttp, probe: ProbePair, signal?: AbortSignal,
): Promise<number | null> {
  const OVER = 10_000;
  const wire = await http.try('sources_to_targets', {
    sources: new Array<{ lon: number; lat: number }>(OVER).fill(
      { lon: probe.from[0], lat: probe.from[1] }),
    targets: [{ lon: probe.to[0], lat: probe.to[1] }],
    costing: 'auto',
  }, signal);

  if (wire.ok) return OVER;
  if (wire.status === 404) return null;      // motorn har ingen matris
  return limitIn(wire.error) ?? null;
}

export interface IsochroneCaps {
  readonly ok: boolean;
  readonly maxContours: number;
  readonly maxTimeMin: number;
}

/**
 * Isokronernas två gränser, båda ur motorns egna fel (152 respektive 151).
 *
 * Att felet kommer betyder att endpointen finns och läste vår kropp — den sonderingen
 * är alltså två svar i ett. Ett 404 betyder att motorn inte har isokroner alls.
 */
async function probeIsochrone(
  http: ValhallaHttp, probe: ProbePair, signal?: AbortSignal,
): Promise<IsochroneCaps> {
  const at = { lon: probe.from[0], lat: probe.from[1] };

  // Konturerna är avsiktligt små (0,1–1,6 min): sonderingen vill veta HUR MÅNGA motorn
  // tar, inte hur stora. Skulle en generösare motor räkna ut alla sexton ska det kosta
  // millisekunder, inte en halv minut i uppstarten.
  const contours = await http.try('isochrone', {
    locations: [at],
    costing: 'auto',
    contours: Array.from({ length: 16 }, (_, i) => ({ time: (i + 1) / 10 })),
    polygons: true,
  }, signal);

  if (!contours.ok && contours.status === 404) {
    return { ok: false, maxContours: 0, maxTimeMin: 0 };
  }

  const time = await http.try('isochrone', {
    locations: [at],
    costing: 'auto',
    contours: [{ time: 10_000 }],
    polygons: true,
  }, signal);

  return {
    ok: true,
    maxContours: contours.ok ? 16 : (limitIn(contours.error) ?? 1),
    maxTimeMin: time.ok ? 10_000 : (limitIn(time.error) ?? 60),
  };
}

// ─── Hjälpare ───────────────────────────────────────────────────────────────

/** "Exceeded max locations: 2500.000000" → 2500. Motorn säger själv var väggen står. */
function limitIn(message: string): number | undefined {
  const m = /:\s*(\d+(?:\.\d+)?)/.exec(message);
  if (!m?.[1]) return undefined;
  const n = Math.floor(Number.parseFloat(m[1]));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function atLeast(version: string, min: readonly [number, number, number]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const want = min[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
}

/**
 * `RoadPreference` → `costing_options.auto`. Speglar `ValhallaProvider` — sonderingen
 * måste tala EXAKT samma dialekt som skarpa anrop, annars mäter den fel motor.
 */
export function costingOf(p: RoadPreference): Record<string, number> {
  const opts: Record<string, number> = {
    use_highways: Math.min(p.motorway, p.trunk),
    use_tolls: p.tolls,
    use_ferry: p.ferry,
    use_living_streets: p.livingStreet,
    use_tracks: p.track,
  };
  if (p.maxSpeedKph !== undefined) opts['top_speed'] = p.maxSpeedKph;
  if (p.maneuverPenaltyS !== undefined) opts['maneuver_penalty'] = p.maneuverPenaltyS;
  return opts;
}

function logTable(
  log: (line: string) => void,
  baseUrl: string,
  version: string,
  actions: ReadonlySet<string>,
  caps: EngineCapabilities,
  iso: IsochroneCaps,
): void {
  const yes = (b: boolean): string => (b ? 'ja ' : 'NEJ');
  const rps = caps.requestsPerSecond === null ? 'obegränsat' : `${caps.requestsPerSecond}/s`;

  log(`ruttmotor: valhalla@${version} på ${baseUrl}`);
  log(`  ${yes(caps.softRoadPreference)}  mjuk vägklasspreferens   (use_highways m.fl.)`);
  log(`  ${yes(caps.softEdgePenalties)}  mjuka kantstraff         (linear_cost_factors, ≥3.7)`);
  log(`  ${yes(caps.throughWaypoints)}  through-waypoints        ⛔ KRITISK`);
  log(`  ${yes(caps.snapRoadClassFilter)}  road-class-snappning     ⛔ KRITISK`);
  log(`  ${yes(caps.mapMatchWayIds)}  way_id ur trace_attributes`);
  log(`  ${yes(caps.nativeSwedish)}  svenska från motorn`);
  log(`  ${yes(caps.isochrone)}  isokroner                (max ${iso.maxContours} konturer, ${iso.maxTimeMin} min)`);
  log(`       alternativ: ${caps.maxAlternates} · punkter/rutt: ${caps.maxWaypoints}`
    + ` · matris: ${caps.matrix ? caps.matrix.maxLocations : '—'} · takt: ${rps}`);
  log(`       endpoints: ${[...actions].sort().join(', ')}`);
}
