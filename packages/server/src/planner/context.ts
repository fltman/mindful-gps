/**
 * Planerarens sammanhang, konstanter och kapabilitetsberoende degradering.
 *
 * Här bor det planeraren behöver VETA om sig själv. Matten bor i @mindful/core, vägarna i
 * roadindex/, motorn i engine/. Den här filen är sömmen mellan dem — och stället där
 * "hur många kandidater vågar vi be om" avgörs av ett SVAR från motorn, aldrig av dess namn:
 *
 *   ✅ engine.caps.requestsPerSecond === null ? 8 : max(3, floor(rps · 3))
 *   ❌ if (engine.name === 'valhalla') { … }
 */

import type {
  EngineCapabilities, LngLat, RoadClass, RoadIndex, RoadPreference, RoadSegment, Route,
  RouteCells, RouteProvider, SnapFilter, VisitedIndex, Waypoint,
} from '@mindful/core';

// ─── Vägindexet, sett från planeraren ───────────────────────────────────────

/**
 * `RoadIndex` plus den D0 planeraren HAR och vägindexet omöjligt kan känna till.
 *
 * CONTRACT §4 fryser `segmentsInEllipse(a, b, epsilon, classes)` — utan baslinjens längd,
 * därför att ett vägindex inte har någon ruttmotor att fråga. Utelämnad faller den tillbaka
 * på fågelvägen A→B, och eftersom den riktiga rutten alltid är längre blir ellipsen då
 * MINDRE än den borde: vi hade prunat bort just de omvägar produkten finns för.
 *
 * Planeraren har baslinjen. Den skickar in den. Den extra parametern är valfri, så varje
 * `RoadIndex` uppfyller fortfarande det frusna interfacet.
 */
export interface PlannerRoads extends RoadIndex {
  segmentsInEllipse(
    a: LngLat, b: LngLat, epsilon: number, classes: readonly RoadClass[], d0M?: number,
  ): Promise<RoadSegment[]>;
}

// ─── Sammanhanget ───────────────────────────────────────────────────────────

export interface PlanContext {
  readonly engine: RouteProvider;
  readonly roads: PlannerRoads;
  /** Användarens H3-minne. Klienten skickar det; servern äger ingen nyhetslogik. */
  readonly mem: VisitedIndex;
  /** Dagar sedan EPOCH_DAY0. Samma dagnummer på klienten och på servern. */
  readonly today: number;
  readonly prefs: RoadPreference;
  readonly signal?: AbortSignal;
  /** Kandidater som dör är normalt, inte exceptionellt. De loggas, de kastas inte. */
  readonly log?: (line: string) => void;
}

/** En kandidat på väg ut till klienten. `kind` skiljer "raka vägen" från förslagen. */
export interface PlanCandidate {
  readonly route: Route;
  /** "62 av 80 km är nya för dig" — talet användaren läser. Aldrig procent (§0.4). */
  readonly novelKm: number;
  readonly beauty: number;
  /** "2,1 km E4 gick tyvärr inte att undvika". Motorväg + trunk. */
  readonly motorwayKm: number;
  /** "Grus sista biten". Obelagd väg: grus + grov mark. */
  readonly gravelKm: number;
  /** Lägets egen målfunktion: U(P) i (a), U_loop i (b), bensvalet i (c). */
  readonly score: number;
  readonly kind: 'baseline' | 'candidate';
  /**
   * De okända vägbitarna rutten TVINGADES genom, med samma snappfilter de ruttades med.
   * Tom för baslinjen och för motorns egna alternativ — de gick ingenstans särskilt.
   *
   * ⚠️ Fältet finns för att överleva en AVVIKELSE. Svänger föraren av räknar `nav/offroute`
   * om rutten och ärver de här punkterna, så att den nya rutten fortfarande går genom den
   * okända vägen. Utan dem degraderar första omruttningen till "snabbaste vägen tillbaka"
   * — och då har vi byggt en vanlig GPS. Att kasta dem här och låta klienten gissa vore
   * att kasta bort hela skälet till att `through` finns.
   */
  readonly through: readonly Waypoint[];
}

/**
 * En ruttad kandidat och de okända vägbitar den TVINGADES genom.
 *
 * De två hör ihop och skiljs aldrig åt. `settle` släpper tyst de anrop som misslyckades,
 * så ett index in i ankarlistan pekar på fel ankare så fort ett enda ruttanrop bommat —
 * därför föds rutten och dess punkter i samma promise och reser tillsammans.
 */
export interface Genomrutt {
  readonly cells: RouteCells;
  readonly through: readonly Waypoint[];
}

/** Vad planeringen kostade. Bench och DoD-måltalen (CONTRACT §7) läser detta. */
export interface PlanStats {
  /** Logiska anrop mot motorn: route + locate + matrix + isochrone. */
  readonly engineCalls: number;
  readonly anchorsFound: number;
  readonly anchorsSnapped: number;
  readonly anchorsRouted: number;
  readonly survivedNatural: number;
  readonly ms: number;
}

export interface PlanResult {
  readonly routes: readonly PlanCandidate[];
  readonly stats: PlanStats;
}

// ─── Ankarna ────────────────────────────────────────────────────────────────

/**
 * Klasserna vi letar ANKARSEGMENT bland — och de är färre än klasserna vi indexerar.
 *
 * ⚠️ Mätt mot motorn, inte resonerat fram. Snappfiltret nedan (`ANCHOR_SNAP`) är designens,
 *    och det tar `min_road_class: residential`. En `track` ligger hos Valhalla i klassen
 *    `service_other` — samma klass som en villainfart. Filtret utesluter alltså tracks:
 *
 *      en tracks mittpunkt, fritt snappad     → service_other/track  @0 m
 *      samma punkt med designens filter       → unclassified/road    @253 m   ⇒ förkastad
 *
 *    253 m är inte samma väg, och adaptern förkastar den mot `radiusM: 25`. Att ändå be
 *    vägindexet om tracks hade varit att välja ankare som DÖR i steg 4 — och de rankar
 *    HÖGST (skönhet 0,75 × medelkurvighet 239°/km), så de hade trängt undan de ankare som
 *    faktiskt fungerar. 37 % av tabellen är tracks.
 *
 *    Att i stället vidga filtret till `min_road_class: service_other` tar tillbaka tracken
 *    — och villainfarten med den (mätt: `service_other/driveway @0 m`). Det är precis vad
 *    `minRoadClass` finns för att förhindra.
 *
 *    Grusvägen är alltså inte bortvald ur produkten. `MINDFUL.track = 0.35` gör att motorn
 *    gärna LÄGGER en track i rutten när den ligger på vägen — vi TVINGAR bara aldrig
 *    rutten genom en. Det är rätt: en svensk skogsbilväg är ofta bommad, och en rutt som
 *    tvingas genom en bom är motsatsen till lugn.
 *
 * `secondary` faller på den andra sidan: `max_road_class: tertiary` utesluter den.
 */
export const ANCHOR_CLASSES: readonly RoadClass[] = [
  'tertiary', 'unclassified', 'residential', 'living_street',
];

/**
 * Snappfiltret för ankarpunkter (design-v1 §3, steg 4).
 *
 * `maxRoadClass` löser "via-punkten snappade till E4:an som går parallellt 300 m bort" —
 * den enskilt mest underskattade parametern i hela researchen (CLAUDE.md).
 * `minRoadClass` löser "via-punkten snappade till någons uppfart".
 * `radiusM` löser "punkten hamnade i en sjö": Valhalla letar vidare tills den hittar NÅGOT,
 * så avvisningen görs i adaptern mot det faktiska snappavståndet.
 */
export const ANCHOR_SNAP: SnapFilter = {
  maxRoadClass: 'tertiary',
  minRoadClass: 'residential',
  minReachability: 50,
  radiusM: 25,
};

/**
 * Snappfiltret för UPPTÄCKTSLÄGETS mål. Samma vägklasser, helt annan radie.
 *
 * ⚠️ Utsvepet använde `ANCHOR_SNAP` först, och det var en kategorimiss som gav NOLL ben
 *    söderut från Växjö, varje gång:
 *
 *      ett ankare  är en punkt PÅ en väg vi hämtat ur vägindexet. Snappar den mer än 25 m
 *                  bort har den snappat till en ANNAN väg, och då är den värdelös — hela
 *                  poängen var att tvinga rutten genom just den vägbiten.
 *
 *      ett mål     är en punkt vi HITTAT PÅ: sju kilometer söderut, mitt i skogen. Att
 *                  närmaste väg ligger sjuttio meter bort är inte ett fel, det är det
 *                  normala. Punkten betyder "någonstans ditåt", inte "exakt här".
 *
 *    Med ankarradien avvisade adaptern alla femton kastade mål — Valhalla hade snappat dem
 *    utmärkt — och användaren fick "vi hittade ingen tur åt dig" när det i själva verket
 *    fanns gott om väg.
 *
 * 800 m är ungefär halva avståndet mellan två småvägar på småländsk landsbygd. Längre än så
 * och målet har slutat peka åt det håll användaren bad om.
 */
export const TARGET_SNAP: SnapFilter = {
  maxRoadClass: 'tertiary',
  minRoadClass: 'residential',
  minReachability: 50,
  radiusM: 800,
};

// ─── Talen ──────────────────────────────────────────────────────────────────

/** Ankarsegment ur ellipsen, efter spridning. Matrisen gallrar dem sedan till fan-outen. */
export const ANCHOR_COUNT = 14;

/**
 * Marginal i matris-förfiltret. `t(A,mid) + t(mid,B)` är en ÄKTA undre gräns för rutten
 * genom segmentet — varje rutt genom segmentet passerar mittpunkten — men through-tvånget
 * gör den verkliga rutten något långsammare än gränsen. 8 % är den luften.
 */
export const MATRIX_MARGIN = 0.92;

/** Två kandidater som delar mer än så mycket väg (H3 res 9, Jaccard) är samma rutt. */
export const DEDUP_JACCARD = 0.80;

/** Så många förslag visas, utöver baslinjen som alltid finns kvar som "raka vägen". */
export const TOP_N = 3;

/**
 * Fan-out: hur många ankare vi vågar rutta parallellt.
 *
 * Självhostad motor = ingen kvot = inget skäl att hålla igen (CONTRACT §2.3). En hostad
 * motor med 1 req/s hade gjort 8 parallella anrop till 8 sekunders väntan, och då är
 * sämre kandidater bättre än en app som hänger sig.
 */
export function fanOutOf(caps: EngineCapabilities): number {
  return caps.requestsPerSecond === null
    ? 8
    : Math.max(3, Math.floor(caps.requestsPerSecond * 3));
}

// ─── Parallellism ───────────────────────────────────────────────────────────

export interface Settled<T> {
  readonly ok: readonly T[];
  readonly failed: readonly unknown[];
}

/**
 * Kör allt parallellt och skilj på svar och fel.
 *
 * En kandidat som inte går att rutta är NORMALT: ankaret låg på en ö, eller vägen dit är
 * avstängd. Den kandidaten faller bort och svepet fortsätter. Att låta ett `no_route` på
 * ett av åtta ankare spränga hela planeringen vore att göra motorns tillfälliga nej till
 * användarens problem.
 *
 * Att motorn är NERE märks redan på baslinjeanropet, som inte fångas.
 */
export async function settle<T>(work: readonly Promise<T>[]): Promise<Settled<T>> {
  const results = await Promise.allSettled(work);
  const ok: T[] = [];
  const failed: unknown[] = [];

  for (const r of results) {
    if (r.status === 'fulfilled') ok.push(r.value);
    else failed.push(r.reason);
  }

  return { ok, failed };
}
