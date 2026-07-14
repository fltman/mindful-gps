/**
 * Sinnena: GPS, skärm, tillstånd, skrivväg.
 *
 * Resten av appen ska aldrig importera `BrowserGeoProvider` eller `SimGeoProvider` direkt.
 * Den ber om `createGeoProvider()` och får en GPS — verklig eller simulerad. Vilken det
 * blev avgörs på ett enda ställe, och `?sim=1` är det enda som kan byta ut den riktiga.
 */

export { fixAt, type Fix, type GeoProvider } from './GeoProvider.js';
export { BrowserGeoProvider, type BrowserGeoOptions } from './BrowserGeoProvider.js';
export { SimGeoProvider, simOptionsFromUrl, type SimOptions } from './SimGeoProvider.js';
export { SMALAND_TRACK } from './track.smaland.js';
export { isAwake, keepAwake, releaseAwake } from './wakeLock.js';
export { audioElement, requestSenses, type Granted, type PermissionReport } from './permissions.js';
export { ephemeralMemory, type RecorderMemory } from './memory.js';
export { idbMemory, type IdbMemory } from './idbMemory.js';
export {
  createRecorder,
  type Recorder, type RecorderProgress, type RecordMode,
} from './recorder.js';

import type { Polyline6 } from '@mindful/core';

import { BrowserGeoProvider } from './BrowserGeoProvider.js';
import type { GeoProvider } from './GeoProvider.js';
import { SimGeoProvider, simOptionsFromUrl } from './SimGeoProvider.js';

/** Simulator om `?sim=1`, annars telefonens GPS. */
export function createGeoProvider(onError?: (message: string) => void): GeoProvider {
  const sim = simOptionsFromUrl();
  return sim ? new SimGeoProvider(sim) : new BrowserGeoProvider({ onError });
}

/** Kör vi på ett simulerat spår? UI:t bör säga det — annars ljuger kartan. */
export function isSimulated(): boolean {
  return simOptionsFromUrl() !== null;
}

/**
 * Låt simulatorn köra den rutt användaren valde.
 *
 * Tyst no-op i skarpt läge: där kommer positionen från satelliterna, och en rutt är ett
 * förslag — inte ett facit för var bilen faktiskt befinner sig.
 *
 * ⚠️ Frågan ställs HÄR och inte i `GeoProvider`. Interfacet är avsiktligt magert (se dess
 *    filhuvud): lägger man in "spela upp det här spåret" i det, är det inte längre ett
 *    interface mot verkligheten utan mot simulatorn, och den dag GPS:en byts mot Capacitors
 *    bakgrundsläge står där en metod som ingen riktig mottagare kan uppfylla.
 */
export function simulateRoute(geo: GeoProvider, polyline6: Polyline6): void {
  if (geo instanceof SimGeoProvider) geo.setTrack(polyline6);
}
