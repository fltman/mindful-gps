/**
 * Avvikelsen.
 *
 * ⭐ OFF-ROUTE ÄR INTE ETT FEL.
 *
 * Varje annan GPS behandlar en avvikelse som ett misslyckande: en pling, ett "recalculating",
 * och sedan snabbaste vägen tillbaka till den snabbaste vägen. Vår gör tvärtom. Har föraren
 * svängt av har hen inte kört fel — hen har hittat en väg till. Vi räknar om, vi behåller
 * ruttens karaktär, och vi säger ingenting om det inte finns något varmt att säga.
 *
 * Två löften som modulen håller:
 *
 *  1. **Vi snäpper aldrig tillbaka till den snabba vägen.** Omruttningen ärver de okända
 *     segment som fortfarande ligger framför oss — som `through`-punkter, med samma
 *     snap-filter planeraren gav dem — och startpunkten får `headingDeg` från fixen så att
 *     motorn inte kan lösa problemet med en u-sväng tillbaka till originalrutten.
 *  2. **Vi kommenterar inte det kända.** Är den nya vägen okänd: varm ton. Är den känd:
 *     tystnad.
 */

import {
  angleDiff, bearing, cellsNovelty, haversine, projectOnPolyline, sampleCells,
  NOVELTY_ANCHOR_MIN,
  type LngLat, type VisitedIndex, type Waypoint,
} from '@mindful/core';

import type { FollowState, FollowedRoute } from './follower.js';
import { offRouteText } from './phrases.sv.js';

// ─── Trösklarna ─────────────────────────────────────────────────────────────

/** Längre än så från rutten är vi inte längre på den. */
export const OFF_ROUTE_M = 40;
/** ...och det ska ha varit sant i åtta sekunder. En parkeringsficka är ingen avvikelse. */
export const OFF_ROUTE_S = 8;
/**
 * Max en omruttning per 20 sekunder. Utan den skickar en app som tappat GPS-fix i en
 * tunnel iväg tre rutter i sekunden — och det är stressen vi bygger bort, i nätverkslagret.
 */
export const REROUTE_DEBOUNCE_MS = 20_000;

/**
 * En genompunkt måste ligga mer än så här långt fram på originalrutten för att ärvas.
 * En punkt fem meter framför där vi lämnade rutten är i praktiken redan passerad.
 */
export const AHEAD_MARGIN_M = 50;

/** Nära genompunkter som ligger BAKOM oss (relativt kursen) skulle bli en u-sväng. */
export const UTURN_RADIUS_M = 300;
export const UTURN_ARC_DEG = 120;

/** Avvikelsens nyhet mäts mot samma tröskel som ett ankarsegment. CONTRACT §4. */
export const NY_VÄG_MIN = NOVELTY_ANCHOR_MIN;

// ─── Typerna ────────────────────────────────────────────────────────────────

/**
 * Det planeraren gav oss, och det vi ska bevara.
 *
 * `through` är hela poängen: det är de okända vägbitarna som planeraren tvingade rutten
 * genom. Kastar vi dem vid första omruttning blir en avvikelse i praktiken ett sätt att
 * fråga efter den snabba vägen — och då har vi byggt en vanlig GPS.
 */
export interface NavPlan {
  readonly followed: FollowedRoute;
  readonly through: readonly Waypoint[];
  readonly destination: Waypoint;
}

export interface RerouteRequest {
  /** Där vi är nu. `headingDeg` sitter här — den låser avfärdsriktningen. */
  readonly from: Waypoint;
  /** De okända segment som fortfarande ligger framför oss, i ordning. */
  readonly through: readonly Waypoint[];
  readonly to: Waypoint;
  /** 0..1. Hur ny är vägen föraren själv valde? */
  readonly novelty: number;
  /** Vad rösten ska säga. `null` = tystnad, och det är det vanliga. */
  readonly say: string | null;
}

export interface OffRouteInput {
  readonly at: LngLat;
  /** Millisekunder, `Date.now()`-axeln. */
  readonly t: number;
  /** null under `BEARING_MIN_SPEED_MS` — då är den brus och vi låser ingen riktning. */
  readonly headingDeg: number | null;
  readonly state: FollowState;
  readonly mem: VisitedIndex;
  readonly today: number;
}

// ─── Genompunkterna ─────────────────────────────────────────────────────────

/**
 * Var på rutten ligger varje genompunkt? Meter längs originalrutten.
 *
 * Räknas EN gång per plan. Genompunkten är den plats planeraren bad om, inte den nod
 * motorn snappade till, så avståndet fram till den måste projiceras — den ligger sällan
 * exakt på en rutt-nod.
 */
export function projectThrough(plan: NavPlan): Float64Array {
  const shape = plan.followed.shape;
  const atM = new Float64Array(plan.through.length);
  for (let i = 0; i < plan.through.length; i++) {
    const wp = plan.through[i];
    if (!wp) continue;
    atM[i] = projectOnPolyline(wp.at, shape)?.alongM ?? 0;
  }
  return atM;
}

/**
 * Vilka av planens genompunkter är kvar att köra?
 *
 * "Framför oss" mäts längs ORIGINALRUTTEN, inte fågelvägen: en punkt kan ligga nära i
 * meter och ändå vara körd. Vi lägger till ett u-svängsskydd för punkter som ligger nära
 * men bakom kursen — motorn hade nått dem, men bara genom att be föraren vända, och den
 * frasen finns inte i den här kodbasen.
 *
 * Att punkten faktiskt är NÅBAR från den nya positionen kan bara ruttmotorn svara på.
 * Går den inte att nå kastar motorn `no_route` och planeraren släpper den punkten — det
 * är rätt ställe att ta det beslutet, inte här.
 */
export function throughAhead(
  plan: NavPlan,
  throughAtM: Float64Array,
  alongM: number,
  at: LngLat,
  headingDeg: number | null,
): Waypoint[] {
  const kvar: Waypoint[] = [];

  for (let i = 0; i < plan.through.length; i++) {
    const wp = plan.through[i];
    if (!wp) continue;

    const wpAlongM = throughAtM[i];
    if (wpAlongM === undefined || wpAlongM <= alongM + AHEAD_MARGIN_M) continue;

    if (headingDeg !== null && haversine(at, wp.at) < UTURN_RADIUS_M) {
      const mot = bearing(at, wp.at);
      if (Math.abs(angleDiff(headingDeg, mot)) > UTURN_ARC_DEG) continue;
    }

    kvar.push(wp);
  }

  return kvar;
}

// ─── Vakten ─────────────────────────────────────────────────────────────────

/**
 * Håller reda på om vi är av rutten, hur länge, och vad vi i så fall ska göra.
 *
 * Ren logik. Den ANROPAR inte planeraren — den beskriver vad en omruttning ska bevara
 * och överlämnar det. Vem som helst kan därmed testa den utan en ruttmotor.
 */
export class OffRouteWatch {
  #plan: NavPlan | null = null;
  #throughAtM: Float64Array = new Float64Array(0);
  #offSince: number | null = null;
  #lastReroute = Number.NEGATIVE_INFINITY;
  /** Fixarna sedan vi lämnade rutten. Det är DE som avgör om vägen är ny. */
  #avvikelse: LngLat[] = [];
  /** Hur många gånger vi hälsat på en ny väg under färden. Varierar formuleringen. */
  #hälsningar = 0;

  constructor(plan?: NavPlan) {
    if (plan) this.setPlan(plan);
  }

  /**
   * Ny rutt att följa. Nollställer avvikelsen men INTE debouncen: har vi just räknat om
   * ska nästa omräkning fortfarande vänta ut sina 20 sekunder.
   */
  setPlan(plan: NavPlan): void {
    this.#plan = plan;
    this.#throughAtM = projectThrough(plan);
    this.#offSince = null;
    this.#avvikelse = [];
  }

  get avvikerSedan(): number | null {
    return this.#offSince;
  }

  /** @returns en omruttning att utföra, eller `null` — vilket är det normala. */
  update(i: OffRouteInput): RerouteRequest | null {
    const plan = this.#plan;
    if (!plan) return null;

    if (i.state.offRouteM <= OFF_ROUTE_M) {
      this.#offSince = null;
      this.#avvikelse = [];
      return null;
    }

    this.#avvikelse.push(i.at);

    if (this.#offSince === null) {
      this.#offSince = i.t;
      return null;
    }

    if (i.t - this.#offSince < OFF_ROUTE_S * 1000) return null;
    if (i.t - this.#lastReroute < REROUTE_DEBOUNCE_MS) return null;

    this.#lastReroute = i.t;
    // Klockan startar om. Håller inte den nya rutten heller får vi fråga igen — men
    // tidigast efter ytterligare åtta sekunder plus debounce.
    this.#offSince = null;

    const novelty = this.#nyhet(i.mem, i.today);
    const nyVäg = novelty >= NY_VÄG_MIN;
    const say = offRouteText(nyVäg, this.#hälsningar);
    if (say !== null) this.#hälsningar++;

    this.#avvikelse = [];

    return {
      from: {
        at: i.at,
        kind: 'break',
        // Låser avfärdsriktningen till den väg föraren faktiskt valde. Utan detta får
        // motorn lov att lösa uppgiften med en u-sväng rakt tillbaka till originalrutten,
        // och då har avvikelsen inte betytt någonting.
        ...(i.headingDeg !== null
          ? { headingDeg: Math.round(i.headingDeg), headingToleranceDeg: 45 }
          : {}),
      },
      through: throughAhead(plan, this.#throughAtM, i.state.alongM, i.at, i.headingDeg),
      to: plan.destination,
      novelty,
      say,
    };
  }

  /**
   * Hur ny är vägen föraren valde?
   *
   * Mätt på de fixar vi samlat sedan vi lämnade rutten — åtta sekunder i landsvägsfart är
   * ett par hundra meter, vilket räcker för att avgöra om vägbiten är körd förut. Samma
   * matte som allt annat nyhetstal i appen (`cellsNovelty`), aldrig en egen variant.
   */
  #nyhet(mem: VisitedIndex, today: number): number {
    if (this.#avvikelse.length < 2) return 0;
    return cellsNovelty(sampleCells(this.#avvikelse), mem, today);
  }
}
