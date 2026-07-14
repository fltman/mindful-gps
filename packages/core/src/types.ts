/**
 * Typerna ur CONTRACT.md §1, §2, §3.2, §3.5 och §4.
 *
 * ⛔ FRUSET. Ändra ingenting här utan att först ändra CONTRACT.md — och det görs inte
 *    utan diskussion. `packages/core` läses av BÅDE klient och server: nyhetstalet
 *    planeraren optimerar mot måste vara bit-identiskt med talet användaren ser.
 *
 * Noll logik i den här filen. Bara typer.
 */

import type * as GeoJSON from 'geojson';

// ─── §1 Grundtyper ──────────────────────────────────────────────────────────

/** [longitud, latitud]. ALLTID i den ordningen. */
export type LngLat = readonly [lon: number, lat: number];

/** Google/Valhalla polyline, precision 6. */
export type Polyline6 = string;

/** Vår vägklass-enum. Motorernas rå-värden mappas hit i adaptern, aldrig utanför. */
export type RoadClass =
  | 'motorway' | 'trunk' | 'primary' | 'secondary'
  | 'tertiary' | 'unclassified' | 'residential'
  | 'living_street' | 'service_other' | 'track';

export type Surface = 'paved' | 'gravel' | 'dirt' | 'unknown';

/**
 * Halvöppet index-intervall i en Route.shape.
 *
 * `Route` bär geometrin som `Polyline6`; "shape" är `geo.decode6(route.geometry)`.
 * Halvöppenheten gäller KANTERNA: spannet täcker kanterna fromIdx..toIdx-1, alltså
 * vägen från nod `fromIdx` till nod `toIdx`. Det är den enda tolkningen där
 * intilliggande spann ([0,5) och [5,10)) täcker rutten utan glapp eller dubbelräkning.
 */
export interface Span<T> {
  readonly fromIdx: number;
  readonly toIdx: number;
  readonly value: T;
}

// ─── §2.1 Vad vi vill uttrycka ──────────────────────────────────────────────

/**
 * Vägkaraktär. Detta är PRODUKTENS språk, inte Valhallas.
 * Adaptern översätter. Appkoden ser aldrig `use_highways`.
 */
export interface RoadPreference {
  /** 0..1. 0 = "helst aldrig". ALDRIG "förbjudet" — mjukt straff, aldrig hård spärr. */
  readonly motorway: number;
  readonly trunk: number;
  readonly track: number;         // grusväg: högre = mer villig
  readonly livingStreet: number;
  readonly ferry: number;         // OBS: färja är VACKERT. Straffa den inte.
  readonly tolls: number;
  /** Styr bort från stora vägar utan att förbjuda dem. */
  readonly maxSpeedKph?: number;
  /** Naturlighet direkt i motorns sökning, inte bara i vårt efterfilter. */
  readonly maneuverPenaltyS?: number;
}

export type WaypointKind = 'break' | 'through';

export interface SnapFilter {
  /**
   * Snappa till en LITEN väg, aldrig till motorvägen. Den enskilt mest
   * underskattade parametern i hela researchen.
   */
  readonly maxRoadClass?: RoadClass;
  /** Undvik att snappa till en enskild infart. */
  readonly minRoadClass?: RoadClass;
  readonly radiusM?: number;
  /** Undvik isolerade öar i grafen. Valhalla default 50. */
  readonly minReachability?: number;
}

export interface Waypoint {
  readonly at: LngLat;
  /** 'through' = ingen u-sväng, inget eget ben. Bilen MÅSTE köra igenom. */
  readonly kind: WaypointKind;
  readonly snap?: SnapFilter;
  /** 0–359, tvingar avfärdsriktning. Används i läge (c). */
  readonly headingDeg?: number;
  readonly headingToleranceDeg?: number;
}

/** Valhalla ≥3.7 linear_cost_factors. factor > 1 = undvik. Man kan BARA straffa. */
export interface EdgePenalty {
  readonly shape: Polyline6;
  readonly factor: number;
}

export interface RouteRequest {
  /** ≥2. [0] och [n-1] är ALLTID 'break'. */
  readonly waypoints: readonly Waypoint[];
  readonly prefs: RoadPreference;
  readonly locale: 'sv-SE';
  readonly alternates?: number;
  /** ENDAST om caps.softEdgePenalties. Adaptern MÅSTE tyst degradera annars. */
  readonly softPenalties?: readonly EdgePenalty[];
  readonly signal?: AbortSignal;
}

// ─── §2.2 Vad vi får tillbaka ───────────────────────────────────────────────

export type ManeuverType =
  | 'depart' | 'continue' | 'turn' | 'fork' | 'merge'
  | 'roundabout_enter' | 'roundabout_exit' | 'uturn'
  | 'ferry' | 'exit' | 'arrive';

export type ManeuverModifier =
  | 'sharp_left' | 'left' | 'slight_left' | 'straight'
  | 'slight_right' | 'right' | 'sharp_right';

export interface Maneuver {
  readonly type: ManeuverType;
  readonly modifier?: ManeuverModifier;
  readonly roundaboutExit?: number;
  /** KAN VARA TOM. Svenska riksvägar saknar `name` och har bara `ref`. */
  readonly streetName?: string;
  /** "27", "E22". ANVÄND DENNA. Vi komponerar "väg 27" / "E22" i phrases.sv.ts. */
  readonly streetRef?: string;
  readonly distanceM: number;
  readonly timeS: number;
  readonly shapeIndex: readonly [start: number, end: number];
  /** Motorns egen svenska. ENDAST för debug. Aldrig primär röst. */
  readonly engineText?: string;
}

export interface Route {
  readonly id: string;
  readonly geometry: Polyline6;
  readonly distanceM: number;
  readonly timeS: number;
  readonly maneuvers: readonly Maneuver[];
  /** → "2,1 km E4 gick tyvärr inte att undvika" */
  readonly roadClassSpans?: readonly Span<RoadClass>[];
  /** → "grus sista biten" */
  readonly surfaceSpans?: readonly Span<Surface>[];
  /** "valhalla@3.5.1" */
  readonly engine: string;
}

export interface SnappedPoint {
  readonly at: LngLat;
  readonly roadClass: RoadClass;
  readonly name?: string;
  readonly ref?: string;
  /** Snappningen misslyckades (sjö, hygge, isolerad ö) → kasta punkten. */
  readonly ok: boolean;
}

// ─── §2.3 Kapabiliteter ─────────────────────────────────────────────────────

export interface EngineCapabilities {
  /** Mjuk vägklass-preferens. Valhalla: ja. ORS hosted: NEJ (bara hård avoid). */
  readonly softRoadPreference: boolean;
  /** linear_cost_factors (Valhalla ≥3.7). Detekteras vid uppstart, gissas aldrig. */
  readonly softEdgePenalties: boolean;
  /** location.type: "through". Valhalla: ja. Mapbox/ORS/GH: nej. KRITISK. */
  readonly throughWaypoints: boolean;
  /** location.search_filter.max_road_class. Valhalla: unikt. KRITISK. */
  readonly snapRoadClassFilter: boolean;
  readonly maxAlternates: number;       // Valhalla default 2, 0 på multipoint!
  readonly maxWaypoints: number;
  readonly matrix: { readonly maxLocations: number } | null;
  readonly isochrone: boolean;
  readonly mapMatchWayIds: boolean;     // trace_attributes → edge.way_id
  readonly nativeSwedish: boolean;
  /** null = obegränsat (självhostat). */
  readonly requestsPerSecond: number | null;
}

// ─── §2.4 Interfacet ────────────────────────────────────────────────────────

export interface RouteProvider {
  readonly name: string;
  readonly caps: EngineCapabilities;

  route(req: RouteRequest): Promise<Route[]>;            // [0] = motorns bästa
  locate(points: readonly LngLat[], f?: SnapFilter): Promise<SnappedPoint[]>;
  matrix(sources: readonly LngLat[], targets: readonly LngLat[],
         p: RoadPreference): Promise<{ timeS: number[][]; distanceM: number[][] }>;
  isochrone(from: LngLat, seconds: readonly number[],
            p: RoadPreference): Promise<GeoJSON.Polygon[]>;

  /** Bara om caps.mapMatchWayIds. v2. */
  mapMatch?(shape: readonly LngLat[]): Promise<Array<{ wayId?: number; shape: LngLat[] }>>;
}

export class RouteEngineError extends Error {
  constructor(
    readonly code: 'no_route' | 'quota' | 'rate_limit' | 'bad_request' | 'upstream',
    message: string,
  ) { super(message); }
}

// ─── §3.2 Cellen ────────────────────────────────────────────────────────────

/** 12 byte per cell. Lagras som struct-of-arrays. ALDRIG som Set<string>. */
export interface VisitedCell {
  readonly h3: bigint;          // u64
  readonly visits: number;      // u8, mättar vid 255
  readonly lastSeenDay: number; // u16, dagar sedan EPOCH_DAY0
  readonly axisMask: number;    // u8
}

// ─── §3.5 Lagring ───────────────────────────────────────────────────────────

/** store 'traces', key: id */
export interface RawTrace {
  readonly id: string;              // uuid
  readonly startedAt: number;       // ms
  readonly endedAt: number;
  readonly mode: 'free' | 'nav_ab' | 'nav_loop' | 'explore';
  readonly polyline6: Polyline6;    // RÅ. Raderas aldrig. ~1,5 MB / 5 000 km.
  readonly distanceM: number;
  readonly gaps: readonly Gap[];    // ärlighet: här tappade vi signalen
  readonly synced: boolean;
}

export interface Gap {
  readonly fromIdx: number;
  readonly toIdx: number;
  readonly distanceM: number;
  readonly ms: number;
}

/**
 * store 'visited', key: h3 res-6 parent (~36 km). Ladda BARA bbox-relevanta shards.
 *
 * ⚠️ ALDRIG Set<string>: 178k celler à 15-teckens hex ≈ 14 MB RAM.
 *    BigUint64Array: 1,4 MB. Res 12 hade blivit 38 MB.
 */
export interface VisitedShard {
  readonly parent: string;
  readonly h3: BigUint64Array;      // SORTERAD → binärsökning
  readonly visits: Uint8Array;
  readonly lastSeenDay: Uint16Array;
  readonly axisMask: Uint8Array;
}

// ─── §4 Vägindexet ──────────────────────────────────────────────────────────

export interface RoadSegment {
  readonly id: number;
  readonly wayId: number;
  readonly cls: RoadClass;
  readonly surface: Surface;
  readonly name?: string;
  readonly ref?: string;
  readonly lengthM: number;        // ~400 (SEGMENT_LENGTH_M)
  readonly shape: LngLat[];
  readonly h3: bigint[];           // ~10 celler vid res 11
  readonly curvatureDpk: number;   // grader per km, förberäknad
}

export interface RoadIndex {
  segmentsInEllipse(a: LngLat, b: LngLat, epsilon: number,
                    classes: readonly RoadClass[]): Promise<RoadSegment[]>;
  segmentsInRing(center: LngLat, ring: GeoJSON.Polygon,
                 classes: readonly RoadClass[]): Promise<RoadSegment[]>;
}
