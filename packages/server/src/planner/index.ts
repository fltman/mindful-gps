/**
 * Planeraren — den enda riktiga logiken på servern.
 *
 * Tre lägen, en princip: motorn får aldrig veta något om nyhet. Vi hittar de okända
 * vägarna i vårt eget index och TVINGAR rutten genom dem med `through`-punkter.
 */

export { ANCHOR_CLASSES, ANCHOR_SNAP, fanOutOf } from './context.js';
export type {
  Genomrutt, PlanCandidate, PlanContext, PlanResult, PlanStats, PlannerRoads,
} from './context.js';

export { detourOf, ellipseBudgetM, inEllipse, pruneToEllipse } from './ellipse.js';
export { anchorBeauty, rankAnchors, snapAnchors, spread } from './anchors.js';
export type { Anchor } from './anchors.js';

export { LEASH_CONTOURS_S, inPolygon, leashOf, timeHomeS } from './leash.js';
export type { Leash } from './leash.js';

export { planAB } from './planAB.js';
export type { PlanABInput } from './planAB.js';

export { planLoop } from './planLoop.js';
export type { PlanLoopInput } from './planLoop.js';

export { planExplore } from './planExplore.js';
export type { PlanExploreInput } from './planExplore.js';
