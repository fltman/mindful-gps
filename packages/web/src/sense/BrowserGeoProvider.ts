/**
 * Riktig GPS, via webbläsaren.
 *
 * `enableHighAccuracy: true` och `maximumAge: 0` är inte förhandlingsbara (CONTRACT §3.4):
 * utan dem svarar telefonen gärna med en cachad wifi-position på 800 meters osäkerhet,
 * och den positionen ser i övrigt precis ut som en riktig fix.
 *
 * Den här filen filtrerar INGENTING. Skrivgrinden bor i `recorder.ts` — se GeoProvider.ts.
 */

import type { Fix, GeoProvider } from './GeoProvider.js';

export interface BrowserGeoOptions {
  /** Svensk, färdig mening. UI:t visar den som den är. */
  readonly onError?: (message: string) => void;
}

/** Webbläsarens felkoder är tre tal. Användaren ska läsa svenska. */
function errorMessage(e: GeolocationPositionError): string {
  switch (e.code) {
    case e.PERMISSION_DENIED:
      return 'Appen får inte läsa din position. Du kan slå på det igen i webbläsarens inställningar.';
    case e.POSITION_UNAVAILABLE:
      return 'Ingen GPS-signal just nu. Vi väntar — den brukar komma tillbaka.';
    case e.TIMEOUT:
      return 'GPS:en svarade inte i tid. Vi fortsätter lyssna.';
    default:
      return 'Positionen gick inte att läsa.';
  }
}

export class BrowserGeoProvider implements GeoProvider {
  readonly #onError: ((message: string) => void) | undefined;
  #watchId: number | undefined;

  constructor(options: BrowserGeoOptions = {}) {
    this.#onError = options.onError;
  }

  start(cb: (f: Fix) => void): void {
    if (this.#watchId !== undefined) return;

    if (!('geolocation' in navigator)) {
      this.#onError?.('Den här webbläsaren har ingen GPS.');
      return;
    }

    this.#watchId = navigator.geolocation.watchPosition(
      (p) => cb(toFix(p)),
      (e) => {
        // TIMEOUT och POSITION_UNAVAILABLE är övergående — watchPosition fortsätter
        // leverera av sig själv. Vi säger till, men vi avbryter ingenting.
        this.#onError?.(errorMessage(e));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
  }

  stop(): void {
    if (this.#watchId === undefined) return;
    navigator.geolocation.clearWatch(this.#watchId);
    this.#watchId = undefined;
  }
}

/**
 * `coords.speed` och `coords.heading` är null på de flesta stillastående enheter, och
 * `heading` är NaN på vissa Android-telefoner. Båda kastas till null — "vet inte" är ett
 * ärligare svar än 0, som i heading betyder "rakt norrut".
 */
function toFix(p: GeolocationPosition): Fix {
  const c = p.coords;
  const speed = typeof c.speed === 'number' && Number.isFinite(c.speed) ? c.speed : null;
  const heading = typeof c.heading === 'number' && Number.isFinite(c.heading) ? c.heading : null;

  return {
    lon: c.longitude,
    lat: c.latitude,
    accuracyM: Number.isFinite(c.accuracy) ? c.accuracy : Number.POSITIVE_INFINITY,
    speedMs: speed,
    headingDeg: heading,
    t: p.timestamp,
  };
}
