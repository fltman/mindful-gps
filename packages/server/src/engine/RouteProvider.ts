/**
 * Ruttmotor-abstraktionen. CONTRACT §2.
 *
 * Den här filen definierar ingenting nytt — den är sömmen. Typerna bor i
 * `@mindful/core/types` därför att BÅDE klienten och servern läser dem, och en andra
 * uppsättning här hade blivit en andra sanning (CONTRACT, ingressen). Vi återexporterar
 * dem så att motorkoden har en egen dörr att gå in genom, och så att en ny adapter
 * (`OrsProvider`, `GraphHopperProvider`, …) vet exakt vad den ska uppfylla:
 *
 *   import type { RouteProvider } from './RouteProvider.js';
 *   export class MinMotor implements RouteProvider { … }
 *
 * Abstraktionens verkliga jobb är INTE att byta bas-URL — det är teater. Det är att låta
 * planeraren fråga `caps` vad motorn klarar och degradera algoritmen därefter. Appkoden
 * grenar aldrig på motorns namn (CLAUDE.md):
 *
 *   const plan = engine.caps.softEdgePenalties
 *     ? planWithSoftPenalties(engine, memory)
 *     : planByThroughSegments(engine, memory);
 */

export type {
  EdgePenalty,
  EngineCapabilities,
  LngLat,
  Maneuver,
  ManeuverModifier,
  ManeuverType,
  Polyline6,
  RoadClass,
  RoadPreference,
  Route,
  RouteProvider,
  RouteRequest,
  SnapFilter,
  SnappedPoint,
  Span,
  Surface,
  Waypoint,
  WaypointKind,
} from '@mindful/core';

export { RouteEngineError } from '@mindful/core';

import type { LngLat } from '@mindful/core';

/**
 * Ett map-matchat vägstycke — returtypen för `RouteProvider.mapMatch` (CONTRACT §2.4).
 *
 * `wayId` saknas när motorn matchade en kant utan OSM-ursprung (motorns egna
 * transitioner). Den som bygger v2:s way-baserade minne måste hantera det, och därför
 * är fältet valfritt i stället för att vi hittar på ett id.
 */
export interface MatchedSpan {
  readonly wayId?: number;
  readonly shape: LngLat[];
}
