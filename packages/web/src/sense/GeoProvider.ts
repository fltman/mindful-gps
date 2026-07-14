/**
 * Appens enda fönster mot verkligheten.
 *
 * 🔒 Interfacet är avsiktligt magert. Byte till Capacitors bakgrunds-GPS ska vara EN ny
 *    fil som implementerar `GeoProvider` — ingenting annat i kodbasen får behöva veta
 *    var fixarna kommer ifrån. Lägg därför aldrig till något här som bara webbläsaren
 *    (eller bara simulatorn) kan leverera.
 *
 * En `Fix` är RÅ. Ingen filtrering, ingen throttling, ingen utjämning sker på vägen hit.
 * Skrivgrinden (accuracy ≤ 30 m, Δt ≥ 1 s, Δd ≥ 10 m) sitter i `recorder.ts`, för
 * CONTRACT §3.4 steg 1 är absolut: råpunkten sparas ALLTID, även den som är för dålig
 * för att skriva in i H3-minnet. Råspåren är sanningen, allt annat är en cache.
 */

import type { LngLat } from '@mindful/core';

export interface Fix {
  readonly lon: number;
  readonly lat: number;
  /** Horisontell osäkerhet i meter, som webbläsaren rapporterar den. */
  readonly accuracyM: number;
  /** null när enheten inte kan säga något om farten. Aldrig 0 som "vet inte". */
  readonly speedMs: number | null;
  /** 0..359, medurs från norr. null under `BEARING_MIN_SPEED_MS` — då är den brus. */
  readonly headingDeg: number | null;
  /** Millisekunder, samma tidsaxel som `Date.now()`. */
  readonly t: number;
}

export interface GeoProvider {
  start(cb: (f: Fix) => void): void;
  stop(): void;
}

/** Fixen som koordinat. [lon, lat] — alltid. */
export function fixAt(f: Fix): LngLat {
  return [f.lon, f.lat];
}
