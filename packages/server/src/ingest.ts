/**
 * Skrivvägen på servern: ett råspår in, celler ut. CONTRACT §3.4.
 *
 * All matte kommer från @mindful/core. Servern räknar INTE själv — klienten och
 * servern måste komma fram till exakt samma celler för samma spår, annars visar appen
 * ett nyhetstal och servern ett annat, och den buggen går aldrig att stänga.
 */

import {
  BEARING_MIN_SPEED_MS, DENSIFY_M, EPOCH_DAY0, H3_RES, MAX_GAP_M,
  axisBucket, bearing, cell, decode6, densify, gridPathCells, haversine,
} from '@mindful/core';
import type { LngLat, RawTrace } from '@mindful/core';

const MS_PER_DAY = 86_400_000;

/** En cell som spåret passerat. En post per cell och tur — aldrig en per GPS-fix. */
export interface IngestedCell {
  readonly h3: bigint;
  /** `1 << axisBucket(bearing)`. 0 när farten var för låg för att lita på bäringen. */
  readonly axisMask: number;
  /** Punkten vi observerade i cellen. Ankare för bbox-frågan i GET /api/memory. */
  readonly at: LngLat;
}

/** Dagar sedan EPOCH_DAY0. u16 i kontraktet — negativa dagar finns inte. */
export function dayOf(ms: number): number {
  return Math.max(0, Math.floor((ms - EPOCH_DAY0) / MS_PER_DAY));
}

/**
 * Linjär interpolation över en kant på högst MAX_GAP_M. Skillnaden mot storcirkeln är
 * millimeter på den skalan — punkten ska bara hamna inuti rätt 50-meterscell.
 */
function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Får vi lita på bäringen i det här spåret?
 *
 * Under BEARING_MIN_SPEED_MS är GPS-bäringen rent brus. Klienten ser farten per fix;
 * servern ser bara en polyline utan tidsstämplar per punkt, så vi kan bara fråga
 * spårets MEDELFART. Det gör axelmasken konservativ på servern: en tur i stadstrafik
 * med långa stopp får inga axelbitar alls, i stället för fyra slumpvisa.
 *
 * Det är rätt avvägning, för masken används inte av någon frusen formel — den är
 * lagrad så att "räkna motsatt håll som nytt" ska kunna bli en A/B-toggle i stället
 * för ett arkitekturbeslut (§3.2).
 */
function trustsBearing(trace: RawTrace): boolean {
  const seconds = (trace.endedAt - trace.startedAt) / 1000;
  if (seconds <= 0) return false;
  return trace.distanceM / seconds >= BEARING_MIN_SPEED_MS;
}

/**
 * Cellerna ett råspår passerat, deduplicerade.
 *
 * Densifiering till 15 m före cellindexeringen är inte en optimering: vid 90 km/h och
 * 1 Hz rör du dig 25 m per fix, och medelkordan i res 11 är 39,3 m — utan mellanpunkter
 * hoppar spåret rakt över celler.
 *
 * Men vi densifierar aldrig över ett hål > MAX_GAP_M, och vi drar heller ingen
 * cellväg genom det. Ett stort hål är signalförlust eller en släckt skärm. Vi hittar
 * aldrig på en väg vi inte observerat.
 */
export function cellsOfTrace(trace: RawTrace): IngestedCell[] {
  const pts = decode6(trace.polyline6);
  const dense = densify(pts, DENSIFY_M, MAX_GAP_M);
  const trustBearing = trustsBearing(trace);

  const acc = new Map<bigint, IngestedCell>();

  // Samma cell flera gånger i samma tur räknas som ETT besök: densifieringen lägger en
  // punkt var 15:e meter genom en cell som är ~50 m bred, och utan den här dedupen hade
  // en enda genomkörning bokförts som tre.
  const add = (h3: bigint, at: LngLat, axisMask: number): void => {
    const prev = acc.get(h3);
    if (prev) acc.set(h3, { h3, at: prev.at, axisMask: prev.axisMask | axisMask });
    else acc.set(h3, { h3, at, axisMask });
  };

  let prev: LngLat | undefined;
  let prevCell: bigint | undefined;

  for (const p of dense) {
    const here = cell(p, H3_RES);

    if (prev === undefined || prevCell === undefined) {
      add(here, p, 0);
    } else if (haversine(prev, p) > MAX_GAP_M) {
      add(here, p, 0);                       // hålet: ingen väg mellan punkterna
    } else {
      const bits = trustBearing ? 1 << axisBucket(bearing(prev, p)) : 0;

      // gridPathCells täpper diagonalhålen: två grannceller i luftlinje behöver inte
      // dela kant, och utan mellancellerna blir minnet ett streckat spår (§3.4 steg 6).
      const path = gridPathCells(prevCell, here);
      const last = path.length - 1;
      for (let k = 0; k <= last; k++) {
        const h = path[k];
        if (h === undefined) continue;
        add(h, last > 0 ? lerp(prev, p, k / last) : p, bits);
      }
    }

    prev = p;
    prevCell = here;
  }

  return [...acc.values()];
}
