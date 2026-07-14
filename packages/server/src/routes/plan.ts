/**
 * POST /api/plan — fan-outen sker HÄR, inte på telefonen.
 *
 * Två skäl, och inga andra: tolv parallella ruttanrop från en telefon under körning är
 * batteri och latens, och ruttmotorns nyckel (om motorn är hostad) får inte ligga i
 * klienten.
 *
 * ── Klienten skickar sitt eget minne ─────────────────────────────────────────
 *
 * `cells` är användarens H3-minne — bara de celler som ligger i sökrymden. Servern äger
 * INGEN nyhetslogik: den bygger ett `VisitedIndex` av det klienten skickar och kör samma
 * frusna matte som klienten kör (@mindful/core). Skulle servern räkna nyhet ur sin egen
 * kopia av minnet skulle de två förr eller senare visa olika tal, och den buggen går
 * aldrig att stänga (CONTRACT, ingressen).
 *
 * Planeringen är därmed helt statslös. Ingen X-Device-Id, ingen session.
 *
 * ── Svaret ───────────────────────────────────────────────────────────────────
 *
 *   { routes: [{ route, novelKm, beauty, motorwayKm, gravelKm, score, kind }] }
 *
 * `kind` skiljer förslagen från baslinjen ("raka vägen", alltid kvar så att man kan
 * jämföra). Utan fältet hade klienten fått gissa på ordningen, och en implicit ordning är
 * en bugg som väntar.
 *
 * Geometrin skickas som EN polyline. Klienten delar den själv i "ny" (varm, tjock) och
 * "känd" (grå, tunn) — den har hela sitt minne lokalt och samma core-kod. Att skicka två
 * LineStrings hade varit att skicka tillbaka något klienten redan vet.
 */

import type { FastifyInstance } from 'fastify';

import { MINDFUL, RouteEngineError, VisitedIndex, todayDay } from '@mindful/core';
import type { LngLat, Route, VisitedCell, Waypoint } from '@mindful/core';

import { BadRequest } from '../device.js';
import { ANCHOR_SNAP, planAB, planExplore, planLoop } from '../planner/index.js';
import type { PlanContext, PlanResult, PlannerRoads } from '../planner/index.js';
import type { RouteProvider } from '../engine/RouteProvider.js';

export interface PlanDeps {
  readonly engine: RouteProvider;
  readonly roads: PlannerRoads;
}

/** Tidsbudget-slidern. Fyra steg — visas i MINUTER för användaren, aldrig i procent. */
const EPSILONS = [0.15, 0.35, 0.60, 1.00];

/** Slingans och upptäcktslägets budget. Under en kvart är det ingen tur; över en dag är det ingen app. */
const MIN_MINUTES = 15;
const MAX_MINUTES = 8 * 60;

interface PlanBody {
  readonly mode?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly epsilon?: unknown;
  readonly minutes?: unknown;
  readonly headingDeg?: unknown;
  readonly cells?: unknown;
}

interface RerouteBody {
  readonly from?: unknown;
  readonly through?: unknown;
  readonly to?: unknown;
}

export async function planRoutes(
  app: FastifyInstance, opts: { deps: PlanDeps },
): Promise<void> {
  const { engine, roads } = opts.deps;

  app.post('/plan', async (req, reply) => {
    const body = (req.body ?? {}) as PlanBody;

    const ctx: PlanContext = {
      engine,
      roads,
      mem: memoryOf(body.cells),
      today: todayDay(),
      prefs: MINDFUL,
      log: (line) => req.log.info(line),
    };

    const mode = body.mode;
    const from = coordOf(body.from, 'from');

    let result: PlanResult;

    switch (mode) {
      case 'ab':
        result = await planAB(ctx, {
          from,
          to: coordOf(body.to, 'to'),
          epsilon: epsilonOf(body.epsilon),
        });
        break;

      case 'loop':
        result = await planLoop(ctx, { from, seconds: minutesOf(body.minutes) * 60 });
        break;

      case 'explore':
        result = await planExplore(ctx, {
          from,
          // I upptäcktsläget är `to` HEMMET — den punkt kopplet mäts mot. Det är samma
          // fråga som i läge (a): var måste rutten kunna ta mig?
          home: coordOf(body.to, 'to'),
          headingDeg: headingOf(body.headingDeg),
          seconds: minutesOf(body.minutes) * 60,
        });
        break;

      default:
        throw new BadRequest("mode ska vara 'ab', 'loop' eller 'explore'");
    }

    req.log.info(
      `plan(${String(mode)}): ${result.routes.length} rutter · ${result.stats.engineCalls}`
      + ` motoranrop · ${result.stats.ms} ms`,
    );

    return reply.send({ routes: result.routes });
  });

  /**
   * POST /reroute — föraren valde en annan väg.
   *
   * ⭐ Detta är INTE "hitta tillbaka till rutten". Off-route är inte ett fel: har föraren
   * svängt av har hen hittat en väg till, och vår enda uppgift är att behålla turens
   * KARAKTÄR. Därför bär anropet med sig de okända vägbitar som fortfarande ligger framför
   * oss (`through`), och de tvingas rutten genom precis som första gången. Utan dem hade en
   * avvikelse i praktiken varit ett sätt att be om den snabba vägen — och då hade vi byggt
   * en vanlig GPS.
   *
   * Ett enda motoranrop i det normala fallet. Ingen nyhetsräkning: klienten har hela sitt
   * minne lokalt och samma frusna matte (@mindful/core), så den räknar om de nya talen
   * själv. Servern skickar inte tillbaka något klienten redan vet.
   *
   * `headingDeg` på startpunkten är det som hindrar motorn från att "lösa" problemet med en
   * u-sväng rakt tillbaka till originalrutten. Den frasen finns inte i den här kodbasen.
   */
  app.post('/reroute', async (req, reply) => {
    const body = (req.body ?? {}) as RerouteBody;

    const from = startOf(body.from);
    const to = coordOf(objectOf(body.to, 'to')['at'], 'to.at');
    const through = throughOf(body.through);

    const { route, kept } = await rerouteThrough(engine, from, to, through, (line) => {
      req.log.info(line);
    });

    req.log.info(
      `reroute: ${(route.distanceM / 1000).toFixed(1)} km,`
      + ` ${kept.length} av ${through.length} genompunkter bevarade`,
    );

    return reply.send({ route, through: kept });
  });
}

// ─── Omruttningen ───────────────────────────────────────────────────────────

/**
 * Rutta genom så många av genompunkterna som går.
 *
 * En punkt kan ha blivit onåbar sedan planeringen: föraren körde förbi avtagsvägen, eller
 * vägen dit är enkelriktad åt fel håll nu när vi står någon annanstans. `nav/offroute` kan
 * inte veta det — bara motorn kan svara på om en punkt går att nå, och den svarar genom att
 * säga `no_route`.
 *
 * Då släpper vi den FÖRSTA kvarvarande punkten och frågar igen. Den första är den vi
 * sannolikt redan passerat eller står på fel sida om; punkterna längre fram är de som
 * fortfarande kan rädda turens karaktär, och de är de sista vi ger upp.
 *
 * Sista utvägen är den nakna vägen till målet. Den är tråkig, men den finns alltid, och en
 * app som svarar "ingen väg" till en förare som redan kör är värre än en tråkig väg.
 */
async function rerouteThrough(
  engine: RouteProvider,
  from: Waypoint,
  to: LngLat,
  through: readonly LngLat[],
  log: (line: string) => void,
): Promise<{ readonly route: Route; readonly kept: readonly Waypoint[] }> {
  for (let drop = 0; drop <= through.length; drop++) {
    const kept: readonly Waypoint[] = through.slice(drop).map((at) => ({
      at,
      kind: 'through' as const,
      // Snappfiltret sätts HÄR, aldrig av klienten. Punkterna är ankare, och de ska snappa
      // som ankare gör — till en liten väg, aldrig till E4:an som går parallellt 300 m bort.
      snap: ANCHOR_SNAP,
    }));

    try {
      const trips = await engine.route({
        waypoints: [from, ...kept, { at: to, kind: 'break' }],
        prefs: MINDFUL,
        locale: 'sv-SE',
      });

      const route = trips[0];
      if (route) return { route, kept };
    } catch (err) {
      // Bara "det finns ingen väg dit" är värt ett nytt försök. Är motorn nere, eller är
      // frågan trasig, hjälper det inte att ställa den en gång till med färre punkter.
      if (!(err instanceof RouteEngineError) || err.code !== 'no_route') throw err;
    }

    if (drop < through.length) {
      log(`reroute: genompunkt ${drop + 1} går inte att nå härifrån — släpper den`);
    }
  }

  throw new RouteEngineError('no_route', 'vi hittar ingen väg vidare härifrån');
}

// ─── Inläsning ──────────────────────────────────────────────────────────────

/** Koordinater är ALLTID [lon, lat]. Aldrig [lat, lon]. Inga undantag (CONTRACT §0.1). */
function coordOf(raw: unknown, field: string): LngLat {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new BadRequest(`${field} ska vara [lon, lat]`);
  }

  const [lon, lat] = raw as [unknown, unknown];
  if (typeof lon !== 'number' || typeof lat !== 'number'
    || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new BadRequest(`${field} ska vara två tal`);
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new BadRequest(`${field} ligger utanför jorden`);
  }

  return [lon, lat];
}

/**
 * ε är slidern, och slidern har fyra lägen. Ett godtyckligt ε är inte ett användarval —
 * det är en klient som gissar. Utelämnat: 0,35, mitten.
 */
function epsilonOf(raw: unknown): number {
  if (raw === undefined) return 0.35;
  if (typeof raw !== 'number' || !EPSILONS.includes(raw)) {
    throw new BadRequest(`epsilon ska vara ett av ${EPSILONS.join(', ')}`);
  }
  return raw;
}

function minutesOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new BadRequest('minutes ska vara ett tal');
  }
  if (raw < MIN_MINUTES || raw > MAX_MINUTES) {
    throw new BadRequest(`minutes ska ligga mellan ${MIN_MINUTES} och ${MAX_MINUTES}`);
  }
  return raw;
}

function headingOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new BadRequest('headingDeg ska vara ett tal (0–359)');
  }
  return ((raw % 360) + 360) % 360;
}

function objectOf(raw: unknown, field: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequest(`${field} ska vara en punkt`);
  }
  return raw as Record<string, unknown>;
}

/**
 * Omruttningens startpunkt: där bilen ÄR, och åt vilket håll den pekar.
 *
 * `headingDeg` är inte kosmetik. Utan den får motorn lov att lösa uppgiften med en u-sväng
 * rakt tillbaka till originalrutten — och då hade avvikelsen inte betytt någonting. Saknas
 * riktningen (bilen står still; under 5 m/s är GPS-bäring rent brus, CONTRACT §3.1) låser
 * vi ingenting, för då vore låsningen en gissning.
 */
function startOf(raw: unknown): Waypoint {
  const wp = objectOf(raw, 'from');
  const at = coordOf(wp['at'], 'from.at');
  const heading = wp['headingDeg'];

  if (heading === undefined || heading === null) return { at, kind: 'break' };

  return {
    at,
    kind: 'break',
    headingDeg: Math.round(headingOf(heading)),
    headingToleranceDeg: 45,
  };
}

/**
 * Genompunkterna som fortfarande ligger framför oss.
 *
 * Bara koordinaten läses. Snappfiltret sätts av servern (`ANCHOR_SNAP`), aldrig av klienten
 * — en klient som får bestämma hur en punkt snappar kan be om att få snappa till motorvägen,
 * och det är precis det filtret finns för att förhindra.
 */
function throughOf(raw: unknown): LngLat[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequest('through ska vara en lista med punkter');

  return raw.map(
    (wp, i) => coordOf(objectOf(wp, `through[${i}]`)['at'], `through[${i}].at`),
  );
}

/**
 * Klientens minne → `VisitedIndex`. Samma trådformat som `GET /api/memory` svarar med:
 *
 *     [h3hex, visits, lastSeenDay, axisMask]
 *
 * Hex och inte tal, därför att JSON inte kan bära en u64 utan att tappa precision. Ett tomt
 * minne är ett giltigt minne — det är dessutom det VANLIGASTE, för det är så varje ny
 * användare börjar. Då är varje väg ny, och det är hela poängen.
 */
function memoryOf(raw: unknown): VisitedIndex {
  if (raw === undefined || raw === null) return VisitedIndex.empty();
  if (!Array.isArray(raw)) throw new BadRequest('cells ska vara en lista');

  const cells: VisitedCell[] = [];

  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 4) {
      throw new BadRequest('varje cell ska vara [h3hex, visits, lastSeenDay, axisMask]');
    }

    const [hex, visits, lastSeenDay, axisMask] = entry as [unknown, unknown, unknown, unknown];
    if (typeof hex !== 'string' || typeof visits !== 'number'
      || typeof lastSeenDay !== 'number' || typeof axisMask !== 'number') {
      throw new BadRequest('en cell är [h3hex: string, number, number, number]');
    }

    let h3: bigint;
    try {
      h3 = BigInt('0x' + hex);
    } catch {
      throw new BadRequest(`"${hex}" är ingen H3-cell`);
    }

    cells.push({ h3, visits, lastSeenDay, axisMask });
  }

  return VisitedIndex.fromCells(cells);
}
