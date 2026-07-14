# CONTRACT.md — Mindful GPS

⛔ **FRUSET.** Allt annat i den här kodbasen får ändras fritt. Det här får inte ändras
utan uttrycklig diskussion. Känner du att du "bara måste" ändra en typ här — stanna,
och fråga i stället.

Anledningen är enkel: `packages/core` läses av **både** klienten och servern.
Nyhetstalet som planeraren optimerar mot måste vara bit-identiskt med `"62 av 80 km
är nya för dig"` som användaren ser. Två implementationer = två siffror =
buggrapporter för alltid.

---

## 0. Universella regler

1. **Koordinater är alltid `[lon, lat]`.** Aldrig `[lat, lon]`. Inga undantag.
   Externa API:er som vill ha `lat,lon` konverteras i sin adapter, inte i vår kod.
2. **Geometri är alltid `polyline6`** över nätverket och i lagring. Avkodas till
   `LngLat[]` först i minnet.
3. **Distanser i meter, tider i sekunder.** Aldrig miles, aldrig minuter i typerna.
4. **Nyhet presenteras aldrig som procent.** Alltid `"62 av 80 km är nya för dig"`.
5. **Ingen tid presenteras i sekunder i UI.** Bara `"1 h 17 min"` och `"400 m"`.
6. Fel från motorn kastas som `RouteEngineError` med `code` — aldrig som råa HTTP-fel.

---

## 1. Grundtyper

```ts
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

/** Halvöppet index-intervall i en Route.shape. */
export interface Span<T> {
  readonly fromIdx: number;
  readonly toIdx: number;
  readonly value: T;
}
```

---

## 2. Ruttmotor-abstraktionen

Interfacet uttrycker **vad vi behöver**, inte snittmängden av vad leverantörerna
råkar erbjuda. Två primitiver är icke-förhandlingsbara: `through`-waypoints och
road-class-filtrerad snappning. Utan dem är produkten inte byggbar.

### 2.1 Vad vi vill uttrycka

```ts
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

/** Den enda RoadPreference vi använder i v1. Frusen. */
export const MINDFUL: RoadPreference = {
  motorway: 0.05,        // MJUK. Valhalla returnerar alltid en rutt, men kan
  trunk: 0.20,           // smyga in 2 km E4 när den måste — och då SÄGER vi det.
  track: 0.35,
  livingStreet: 0.40,
  ferry: 0.70,
  tolls: 0.30,
  maxSpeedKph: 80,
  maneuverPenaltyS: 30,
};

/** ⛔ Rör ALDRIG Valhallas `shortest: true`. Den slår ut alla andra kostnader,
 *  inklusive våra preferenser. De tar ut varandra. */

export type WaypointKind = 'break' | 'through';

export interface SnapFilter {
  /** Snappa till en LITEN väg, aldrig till motorvägen. Den enskilt mest
   *  underskattade parametern i hela researchen. */
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
```

**Två saker som medvetet INTE finns i interfacet — och varför:**

- **`avoidPolygons` / `excludeLocations`.** Alla motorer implementerar dem som **hård**
  exkludering. Det är fel semantik för produkten: vi vill ha *preferens*, inte *förbud*.
  Att ens ha dem i interfacet skulle bjuda in någon att bygga "kört förut" på dem. Och
  det skalar inte, och det ger `NoRoute`. Nej.
- **Egen svensk textgenerering i motorn.** Vi genererar rösten själva (§6), eftersom
  motorns kadens är fel. `Maneuver.engineText` finns bara för debug.

### 2.2 Vad vi får tillbaka

```ts
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
```

### 2.3 Kapabiliteter — abstraktionens verkliga jobb

En abstraktion som bara byter bas-URL är teater. Den här låter **planeraren fråga
motorn vad den kan och degradera algoritmen därefter**.

```ts
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
```

Så här — och **bara** så här — används den. Appkoden får **aldrig** grena på motorns namn:

```ts
// ✅ RÄTT
const fanOut = engine.caps.requestsPerSecond === null
  ? 8
  : Math.max(3, Math.floor(engine.caps.requestsPerSecond * 3));

const plan = engine.caps.softEdgePenalties
  ? planWithSoftPenalties(engine, memory)   // endgame: straffa kända kanter i motorn
  : planByThroughSegments(engine, memory);  // v1: hitta okända segment, tvinga genom

// ❌ FEL — aldrig
if (engine.name === 'valhalla') { ... }
```

### 2.4 Interfacet

```ts
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
```

---

## 3. Nyhetsminnets datamodell

### 3.1 Konstanter — FRUSNA

```ts
export const H3_RES               = 11;      // cellbredd 49,6 m (flat-to-flat!)
export const H3_SHARD_RES         = 6;       // ~36 km. Ladda bara relevanta shards.
export const H3_SPREAD_RES        = 7;       // ~5 km. Max 1 ankarsegment per cell.
export const H3_DEDUP_RES         = 9;       // Jaccard-dedup av kandidatrutter.
export const H3_SAMPLE_PRIOR_RES  = 8;       // ~1,2 km. Samplingsprior.

export const DENSIFY_M            = 15;      // vid SKRIVNING (se §3.4)
export const SAMPLE_M             = 25;      // vid SCORING. ≈ halva medelkordan (39,3 m)
                                             //   → Nyquist. Ger ~2 sampel per cell.
export const MAX_GAP_M            = 200;     // densifiera ALDRIG över ett större hål
export const MIN_ACCURACY_M       = 30;      // sämre fixar → råspår, men INTE till cellerna
export const MIN_FIX_INTERVAL_MS  = 1000;
export const MIN_FIX_DISTANCE_M   = 10;
export const BEARING_MIN_SPEED_MS = 5;       // under 5 m/s är GPS-bäring rent brus

export const EPOCH_DAY0           = Date.UTC(2020, 0, 1);
export const TAU_DAYS             = 500;     // recency-decay. ⚠️ KALIBRERAS (§7)
export const VISIT_SATURATION     = 0.7;     // 1 - exp(-0.7·visits)
export const NEIGHBOR_SOFTNESS    = 0.35;    // ⚠️ KALIBRERAS (§7)
export const SEGMENT_LENGTH_M     = 400;     // vägsegmentering vid ingest
export const NOVELTY_ANCHOR_MIN   = 0.60;    // ⚠️ KALIBRERAS (§7)
```

### 3.2 Cellen

```ts
/** 12 byte per cell. Lagras som struct-of-arrays. ALDRIG som Set<string>. */
export interface VisitedCell {
  readonly h3: bigint;          // u64
  readonly visits: number;      // u8, mättar vid 255
  readonly lastSeenDay: number; // u16, dagar sedan EPOCH_DAY0
  readonly axisMask: number;    // u8
}
```

**`axisMask`: fyra AXEL-buckets à 45°, kvantiserade MODULO 180°.**
En väg har en **axel**, inte en riktning. Nord och syd räknas som **samma väg**.

> Om vi gjorde tvärtom skulle appen skicka dig tillbaka samma väg du precis kom, i
> backspegeln, och kalla det "ny väg". Det läser som en bugg. All prior art (Wandrer,
> VeloViewer, CityStrides) är riktningsagnostisk.

Men vi **lagrar** masken (1 byte). Det gör "räkna motsatt håll som nytt" till en
A/B-toggle i stället för ett arkitekturbeslut. Ignoreras helt under `BEARING_MIN_SPEED_MS`.

### 3.3 Familiaritet och nyhet — FRUSEN MATTE

```ts
/** 0..1. Hur välbekant är cellen? Recency-decay är det som gör produkten meningsfull
 *  ÅR 2 i stället för att stelna. En väg du körde en gång för tre år sedan ÄR i
 *  praktiken ny igen. */
export function familiarity(c: VisitedCell, today: number): number {
  const saturation = 1 - Math.exp(-VISIT_SATURATION * c.visits);
  const recency    = Math.exp(-(today - c.lastSeenDay) / TAU_DAYS);
  return saturation * recency;
}

/**
 * Mjuk medlemskap: en GRANNCELL till en starkt känd cell räknas som delvis känd.
 * Tar hand om GPS-brus (±5–10 m) utan att kollapsa parallella vägar 50 m isär.
 * Granne bidrar bara om den har visits ≥ 2 — svaga spår smittar inte.
 */
export function softFamiliarity(h3: bigint, mem: VisitedIndex, today: number): number {
  const self = mem.get(h3);
  const own  = self ? familiarity(self, today) : 0;
  let best = 0;
  for (const n of h3util.gridDisk(h3, 1)) {
    const c = mem.get(n);
    if (c && c.visits >= 2) best = Math.max(best, familiarity(c, today));
  }
  return Math.max(own, NEIGHBOR_SOFTNESS * best);
}

export function cellNovelty(h3: bigint, mem: VisitedIndex, today: number): number {
  return 1 - softFamiliarity(h3, mem, today);
}

/** Distansviktad nyhet för en hel rutt. 0..1. */
export function routeNovelty(shape: LngLat[], mem: VisitedIndex, today: number): number {
  const pts = geo.resample(shape, SAMPLE_M);
  let sum = 0;
  for (const p of pts) sum += cellNovelty(h3util.cell(p, H3_RES), mem, today);
  return pts.length ? sum / pts.length : 1;
}

/** DETTA är talet som visas: "62 av 80 km är nya för dig". */
export function novelKm(r: Route, mem: VisitedIndex, today: number): number {
  return routeNovelty(geo.decode6(r.geometry), mem, today) * (r.distanceM / 1000);
}
```

**Prestandakrav:** 30 km rutt = 1 200 sampel × 7 uppslag (cell + gridDisk).
Binärsökning i sorterad `BigUint64Array` ≈ 80 ns → **under 1 ms per kandidat**.
20 kandidater ≈ 20 ms. **Noll API-anrop. Fungerar offline.** Det är hela poängen med H3.

### 3.4 Skrivvägen — FRUSEN

```
watchPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 })
 │
 ├─1. Spara ALLTID råpunkten i trace-bufferten (lon, lat, t, accuracy, speed, heading).
 │     Råspåren är sanningen. Allt annat är en cache.
 │
 ├─2. Filter för H3-skrivning: accuracy ≤ MIN_ACCURACY_M (30 m)
 ├─3. Throttle: behåll fix om (Δt ≥ 1 s) OCH (Δd ≥ 10 m)
 │
 ├─4. DENSIFIERA till ≤ 15 m mellan punkter FÖRE latLngToCell.
 │     Vid 90 km/h + 1 Hz rör du dig 25 m per fix. Medelkordan i res 11 är 39,3 m.
 │     Utan interpolation HOPPAR DU ÖVER CELLER. Detta är inte en optimering.
 │
 ├─5. MEN: densifiera ALDRIG över ett hål > MAX_GAP_M (200 m).
 │     Stort hål = signalförlust eller skärmen släcktes.
 │     ⚠️ Vi hittar ALDRIG på en väg vi inte observerat. Hålet markeras som `Gap`.
 │
 ├─6. h3.gridPathCells() mellan konsekutiva celler → täpp diagonal-hål
 │
 ├─7. upsert: visits = min(255, visits+1); lastSeenDay = idag;
 │            axisMask |= axisBucket(bearing)  [endast om speed > 5 m/s]
 │
 └─8. Skriv till IndexedDB i 10-SEKUNDERSBATCHAR. ALDRIG per fix.
```

### 3.5 Lagring

```ts
// ── KLIENT: IndexedDB ─────────────────────────────────────────────────────
// store 'traces'   key: id
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
export interface Gap { readonly fromIdx: number; readonly toIdx: number;
                       readonly distanceM: number; readonly ms: number; }

// store 'visited'  key: h3 res-6 parent (~36 km). Ladda BARA bbox-relevanta shards.
export interface VisitedShard {
  readonly parent: string;
  readonly h3: BigUint64Array;      // SORTERAD → binärsökning
  readonly visits: Uint8Array;
  readonly lastSeenDay: Uint16Array;
  readonly axisMask: Uint8Array;
}
// ⚠️ ALDRIG Set<string>: 178k celler à 15-teckens hex ≈ 14 MB RAM.
//    BigUint64Array: 1,4 MB. Res 12 hade blivit 38 MB.

// store 'meta'     key: 'deviceId' | 'home' | 'settings' | 'lastSync'
// store 'outbox'   key: traceId — sync-kön. ÖVERLEVNADSKRAV, inte optimering.
```

**Storlek** (varför detta är ett icke-problem):

| Körsträcka | H3-celler (res 11) | Klient (binärt) | Råspår |
|---|---|---|---|
| 500 km | ~18 000 | 0,2 MB | 0,15 MB |
| 5 000 km | ~178 000 | 2,1 MB | 1,5 MB |
| 20 000 km | ~713 000 | 8,6 MB | 6 MB |

iOS-kvot ≈ 1 GB/origin. **Storleken är inte problemet — eviction är.**
Därför: `navigator.storage.persist()` + tvingande Add-to-Home-Screen + serversync.

### 3.6 Sync-kontraktet (fryser B↔E)

```ts
// POST /api/traces   body: RawTrace[]  (utan `synced`)
// → 200 { accepted: string[] }         // trace-id:n servern nu äger
//
// GET  /api/memory?bbox=minLon,minLat,maxLon,maxLat
// → 200 { cells: Array<[h3hex: string, visits: number, lastSeenDay: number, axisMask: number]> }
//   Återställning på ny enhet. Klienten bygger om sina shards ur detta.
```

---

## 4. Vägindexet (för den inverterade sökningen)

```ts
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
```

### ⛔ Segmentnyhet är KONTINUERLIG, aldrig binär

```ts
/**
 * ❌ FEL (kollapsar till noll kandidater i användarens hemtrakt — där appen används mest):
 *      SELECT * FROM road WHERE NOT EXISTS (visited_cell ∩ road.h3_11)
 *    En OSM-way är ofta kilometerlång. Efter ett halvår hemma är NÄSTAN VARJE way
 *    delvis körd. Den binära frågan ger noll träffar precis där produkten ska leverera,
 *    och överlever bara på semestern i Norrland.
 *
 * ✅ RÄTT: segmentera i 400 m-bitar VID INGEST, och räkna FRAKTIONELL täckning.
 */
export function segmentNovelty(s: RoadSegment, mem: VisitedIndex, today: number): number {
  if (!s.h3.length) return 0;
  let sum = 0;
  for (const c of s.h3) sum += cellNovelty(c, mem, today);
  return sum / s.h3.length;   // 0..1, kontinuerligt
}
```

Ankarkandidat om `segmentNovelty ≥ NOVELTY_ANCHOR_MIN` (0.60). ⚠️ Kalibreras.

---

## 5. Skönhet och naturlighet — FRUSEN MATTE

### 5.1 Slingrighet

Valhalla har ingen `curvature`-encoded-value. Vi räknar den själva.
**Utan denna är "vackrare väg" tomt prat.**

```ts
/**
 * Ackumulerad kursändring per kilometer. Enhet: grader/km.
 *
 * VARFÖR INTE `1 - beeline/pathLength` på 200 m-fönster:
 *   En mjuk landsvägskurva med radie 500 m ger över 200 m ett beeline/path på 0,993
 *   → c = 0,007. Måttet är helt dominerat av brus på den skalan, och blint för
 *   S-kurvor. Rätt IDÉ, fel skala.
 *
 * Ackumulerad kursändring fångar båda, och skalar linjärt:
 *   spikrak motorväg   ~5–20°/km
 *   vanlig landsväg    ~60–120°/km
 *   slingrig småväg    ~150–400°/km
 *   serpentiner        800+°/km
 */
export function curvatureDegPerKm(shape: LngLat[]): number {
  const pts = geo.resample(shape, 50);          // 50 m → filtrerar bort geometribrus
  if (pts.length < 3) return 0;
  let turned = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const b1 = geo.bearing(pts[i - 1], pts[i]);
    const b2 = geo.bearing(pts[i], pts[i + 1]);
    turned += Math.abs(geo.angleDiff(b1, b2));  // 0..180
  }
  const km = geo.length(pts) / 1000;
  return km > 0 ? turned / km : 0;
}

/** 0..1. 40°/km = rakt och tråkigt. 300°/km = härligt slingrigt. ⚠️ KALIBRERAS. */
export const curvatureScore = (dpk: number) => clamp01((dpk - 40) / 260);
```

### 5.2 Skönhet

```ts
const CLASS_BEAUTY: Record<RoadClass, number> = {
  motorway: 0.00, trunk: 0.10, primary: 0.30, secondary: 0.55,
  residential: 0.60, living_street: 0.70, track: 0.75,
  service_other: 0.35, tertiary: 0.80, unclassified: 0.90,
};
const SURFACE_BEAUTY: Record<Surface, number> = {
  paved: 0.50, gravel: 0.90, dirt: 0.75, unknown: 0.50,
};
// grus är vackert. lera är det inte.

export function beauty(r: Route): number {
  const cls  = weightedByLength(r.roadClassSpans, CLASS_BEAUTY, r.distanceM);
  const surf = weightedByLength(r.surfaceSpans,  SURFACE_BEAUTY, r.distanceM);
  const curv = curvatureScore(curvatureDegPerKm(geo.decode6(r.geometry)));
  const rural = 1 - fractionOf(r.roadClassSpans, ['residential', 'living_street']);
  return 0.45 * cls + 0.30 * curv + 0.15 * surf + 0.10 * rural;
}
```

### 5.3 `isNatural(P)` — ett HÅRT FILTER, inte en straffterm

Abraham/Delling/Goldberg/Werneck mätte den naiva straffmetoden: rutterna fick i snitt
**>5 omvägar, upp till 15**, och beskrivs som *"unnatural to most users"*. Att bara
maximera nyhet ger zigzag. **En rutt som ser ut som en tarm läser som en bugg — och
gör dig stressad även om den är 100 % ny väg.**

```ts
export interface NaturalContext {
  readonly baselineTurnsPerKm: number;
  readonly baselineShape: LngLat[];
  readonly Tmax: number;             // T0 × (1 + ε)
}

export function isNatural(r: Route, ctx: NaturalContext): boolean {
  const km    = r.distanceM / 1000;
  const turns = r.maneuvers.filter(m =>
      m.type === 'turn' || m.type === 'fork' || m.type === 'roundabout_enter'
    ).length;
  const tpk = turns / km;

  // Svängtäthet, RELATIVT baseline. Bohuslän och Skåne har helt olika svängtäthet
  // i grunden — ett absolut tak vore fel normering.
  if (tpk > 1.6 * ctx.baselineTurnsPerKm) return false;
  if (tpk > 4.0) return false;                             // absolut tak (stadsgytter)

  if (reversals(r) > 0) return false;                      // 1 km-fönster, bäringsdot < -0.5
  if (r.maneuvers.some(m => m.type === 'uturn')) return false;
  if (selfOverlap(r) > 0.05) return false;                 // ingen H3-cell 2× i samma rutt
  if (sharing(r, ctx.baselineShape) > 0.80) return false;  // ADGW γ = 80 %
  if (r.timeS > ctx.Tmax) return false;                    // användarens budget, HÅRT
  return true;
}
```

### 5.4 Scoringfunktionen — `U(P)`

```ts
export interface ScoreInput {
  readonly route: Route;
  readonly baseline: Route;
  readonly T0: number;
  readonly Tmax: number;
  readonly mem: VisitedIndex;
  readonly today: number;
}

/** Alla delvärden 0..1. */
export function score(i: ScoreInput): number {
  const nov      = routeNovelty(geo.decode6(i.route.geometry), i.mem, i.today);
  const bty      = beauty(i.route);
  const timeCost = clamp01((i.route.timeS - i.T0) / Math.max(1, i.Tmax - i.T0));
  const turnCost = clamp01(turnsPerKm(i.route) / (1.6 * turnsPerKm(i.baseline)));
  const mway     = fractionOf(i.route.roadClassSpans, ['motorway', 'trunk']);
  const share    = sharing(i.route, geo.decode6(i.baseline.geometry));

  return  1.00 * nov        // nyhet ÄR produkten
       +  0.35 * bty        // vackrare väg
       -  0.30 * timeCost   // vi RESPEKTERAR budgeten, vi jagar den inte
       -  0.25 * turnCost   // naturlighet (utöver det hårda filtret)
       -  0.40 * mway       // motorväg är motsatsen till produkten
       -  0.15 * share;     // vi vill ha genuint OLIKA kandidater
}
```

> ⚠️ **Alla sex koefficienter är HYPOTESER.** De kalibreras mot `bench/` (§7).
> Ändrar du en av dem utan att köra benchmarken vet du inte om rutterna blev *bättre*
> — bara att de blev *annorlunda*.

---

## 6. Rösten — tystnadsdoktrinen

```ts
export interface VoiceCue {
  readonly atDistanceM: number;   // avstånd till manövern då den ska sägas
  readonly text: string;          // svensk, färdig, HEL mening
}

/**
 * FRUSEN REGEL: MAX TVÅ UTROP PER MANÖVER.
 *   "långt": vid 400 m  (600 m om v > 22 m/s)
 *   "nu":    vid  40 m
 *
 * ⛔ Är det 18 km till nästa sväng säger appen INGENTING på 18 km.
 *    Det är hela produkten i ett designbeslut.
 * ⛔ Frasen "gör en U-sväng när det är möjligt" finns inte i kodbasen.
 *
 * Kedjning: om nästa manöver kommer < 400 m efter denna, slå ihop till EN cue:
 *    "Vänster, sedan direkt höger."
 */
export function cuesFor(m: Maneuver, next: Maneuver | null, speedMs: number): VoiceCue[];

/**
 * Svenska riksvägar saknar ofta `name` och har bara `ref=27`. Vi komponerar:
 *   ref matchar /^E\d+$/    → "E22"
 *   ref matchar /^\d{1,2}$/ → "väg 27"
 *   ref matchar /^\d{3,4}$/ → "väg 641"
 *   annars, name finns      → name
 *   annars                  → utelämna helt (säg bara "sväng vänster")
 */
export function roadLabel(m: Maneuver): string | null;
```

**Uppspelning — frusen:**

- **ETT `HTMLAudioElement`.** Aldrig Web Audio-noder.
  *Web Audio tystas av iOS ringlägesswitch. `<audio>` gör det inte.* En förare med
  telefonen på ljudlöst skulle annars höra **noll**.
- **Hela fraser, aldrig konkatenerade fragment.** Prosodin blir hackig och fel.
- `navigator.audioSession.type = 'transient-solo'` på Safari 16.4+ → **duckar** Spotify
  i stället för att pausa den.
- `speechSynthesis` **endast fallback**, med watchdog (om `onend` inte kommit inom
  `estimeradTid × 2` → `cancel()` + återskapa). Den **hänger sig** på iOS om appen
  bakgrundas mitt i en mening. `getVoices()` ljuger — whitelista `sv-SE`, normalisera
  `sv_SE` → `sv-SE`.
- Fallback-vägen är **alltid komplett i sig**. Säger den bara "sväng vänster" räcker det.

---

## 7. Kalibrering — `bench/`

Alla ⚠️-markerade konstanter är hypoteser. De sätts av mätning, inte av magkänsla på
en biltur.

```
bench/routes.json   20 A→B-par + 10 slingor, i fyra terrängtyper:
                    skogsbygd (Småland) · slätt (Skåne) · kust (Bohuslän) · stad (Göteborg)
                    Varje par körs mot 3 syntetiska minnestillstånd:
                      "tomt" · "pendlare" (samma 40 km körda 200 ggr) · "veteran" (5 000 km)

bench/run.ts        → bench/report.md (checkas in, diffas mellan viktändringar)
```

**Måltal för Fas 2 "definition of done"** (vid ε = 0.35, minnestillstånd "pendlare"):

| Mått | Mål |
|---|---|
| Andel okänd väg i vinnarrutten | ≥ 50 % |
| Svängar/km relativt baseline | ≤ 1,6× |
| Riktningsomkastningar | 0 |
| Motorväg + trunk | < 5 % |
| Medelcurvature | > baseline × 1,3 |
| Kandidater som överlever `isNatural()` | ≥ 4 av 11 |
| Väggklocka | < 3 s |

**Det kritiska testet:** kör benchmarken med minnestillståndet "pendlare" och
kontrollera att gamla riksvägen fortfarande scoras som **ny** när bara E4:an 200 m bort
är körd. Gör den inte det är hela premissen bruten och `NEIGHBOR_SOFTNESS` måste till 0.
