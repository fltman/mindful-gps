/**
 * Planeringen, sedd från klienten.
 *
 * Fan-outen sker på servern — tolv parallella ruttanrop från en telefon under körning är
 * batteri och latens. Men NYHETEN ägs av klienten. Servern har inget minne: den får
 * användarens celler med i anropet och kör samma frusna matte som vi (@mindful/core) på
 * dem. Det är därför "62 av 80 km är nya för dig" på kortet är exakt det tal planeraren
 * optimerade mot, och inte ett tal som liknar det.
 *
 * ── Vilka celler skickas? ────────────────────────────────────────────────────
 *
 * Bara de som ligger i sökrymden. Att skicka hela minnet vore 2 MB per planering och 99 %
 * av det ligger i en annan del av landet. Sökrymden är ellipsen i läge (a) och en cirkel
 * runt hemmet i (b) och (c) — men klienten känner inte baslinjens längd D0 (den kommer ur
 * det första ruttanropet, på servern). Vi uppskattar den från fågelvägen och tar till i
 * ÖVERKANT, för felen är inte symmetriska:
 *
 *   för många celler  → några kilobyte extra i anropet
 *   för få celler     → en väg du kört varje dag rapporteras som ny, och kortet ljuger
 */

import { haversine, type LngLat, type Route, type Waypoint } from '@mindful/core';

import {
  bboxToShards, cellTuple, loadShards, shardCells,
  type BBox, type CellTuple, type MemoryStore,
} from '../memory/index.js';

import type { PlanRoute } from './types.js';

export type { PlanMode, PlanRoute } from './types.js';

/** Tidsbudget-slidern. Fyra steg, frusna i `routes/plan.ts`. Ett femte vore en gissning. */
export const EPSILONS = [0.15, 0.35, 0.60, 1.00] as const;
export type Epsilon = (typeof EPSILONS)[number];

/**
 * Marschfart på småväg, m/s (≈ 65 km/h). MINDFUL har `maxSpeedKph: 80` och en
 * svängstraff — den verkliga snittfarten hamnar under den.
 *
 * Används BARA för att uppskatta: hur stort område minnet ska hämtas ur, och ungefär hur
 * många minuter längre en tidsbudget tillåter. Aldrig för att lova något. Siffran som
 * visas efter planeringen kommer från motorn.
 */
export const MARSCHFART_MS = 18;

/** Vägar är längre än fågelvägen. Grovt, och medvetet i överkant. */
const VÄGFAKTOR = 1.3;

/** ADGW-ellipsens k, samma tal som planerarens (design-v1 §3, steg 2). */
const ELLIPS_K = 0.85;

/**
 * Hur stor del av tidsbudgeten som kan tillbringas på väg BORT från hemmet.
 * Planeraren lägger sin isokron på 0,38 × T och behöver marginal för en annan väg hem;
 * 0,55 är den gränsen med luft över.
 */
const UTVÄGSANDEL = 0.55;

const M_PER_DEG_LAT = 111_320;

// ─── Sökrymden ──────────────────────────────────────────────────────────────

/**
 * Radien som rymmer hela ellipsen i läge (a).
 *
 * Varje punkt i ellipsen |Av| + |vB| ≤ L ligger inom L/2 från mittpunkten — det är
 * halva storaxeln. En cirkel är grövre än ellipsen, och det är precis vad vi vill ha
 * här: cellhämtningen ska ta i, inte snåla.
 */
export function sökradieAB(a: LngLat, b: LngLat, epsilon: number): number {
  const d0 = haversine(a, b) * VÄGFAKTOR;
  return ((1 + epsilon) * d0) / ELLIPS_K / 2;
}

/** Radien en slinga eller ett utsvep kan nå inom sin tidsbudget. */
export function sökradieTid(sekunder: number): number {
  return sekunder * MARSCHFART_MS * UTVÄGSANDEL;
}

/** Baslinjens tid, ungefärlig. Slidern behöver ett tal FÖRE planeringen finns. */
export function estimeradBaslinjeS(a: LngLat, b: LngLat): number {
  return (haversine(a, b) * VÄGFAKTOR) / MARSCHFART_MS;
}

/** Bbox runt punkterna, utvidgad med `radiusM`. Lat-marginalen tas på den sämsta breddgraden. */
export function sökruta(punkter: readonly LngLat[], radiusM: number): BBox {
  const första = punkter[0];
  if (!första) return [0, 0, 0, 0];

  let minLon = första[0];
  let maxLon = första[0];
  let minLat = första[1];
  let maxLat = första[1];

  for (const p of punkter) {
    minLon = Math.min(minLon, p[0]);
    maxLon = Math.max(maxLon, p[0]);
    minLat = Math.min(minLat, p[1]);
    maxLat = Math.max(maxLat, p[1]);
  }

  const dLat = radiusM / M_PER_DEG_LAT;
  const värstaLat = Math.max(Math.abs(minLat), Math.abs(maxLat)) + dLat;
  const krymp = Math.max(0.05, Math.cos((värstaLat * Math.PI) / 180));
  const dLon = dLat / krymp;

  return [minLon - dLon, minLat - dLat, maxLon + dLon, maxLat + dLat];
}

/**
 * Minnet i sökrymden, som tuplar. Samma format som `GET /api/memory` svarar med — ett
 * format i systemet, inte två.
 *
 * Vi läser ur LAGRINGEN och inte ur RAM-indexet: shardarna är den enda vy där en cell
 * går att räkna upp, och recordern skriver dem var tionde sekund. Ett tomt svar är ett
 * giltigt svar — det är dessutom det vanligaste, för det är så varje ny användare börjar.
 */
export async function planCeller(
  store: MemoryStore,
  punkter: readonly LngLat[],
  radiusM: number,
): Promise<CellTuple[]> {
  const shards = await loadShards(store, bboxToShards(sökruta(punkter, radiusM)));

  const tuplar: CellTuple[] = [];
  for (const s of shards) {
    for (const c of shardCells(s)) tuplar.push(cellTuple(c));
  }
  return tuplar;
}

// ─── Anropet ────────────────────────────────────────────────────────────────

export interface PlanRequest {
  readonly mode: 'ab' | 'loop' | 'explore';
  readonly from: LngLat;
  /** Målet i (a). Hemmet — den punkt kopplet mäts mot — i (c). */
  readonly to?: LngLat;
  /** Bara i (a). */
  readonly epsilon?: Epsilon;
  /** Bara i (b) och (c). Tidsbudget för hela turen. */
  readonly minutes?: number;
  /** Bara i (c). Riktningen användaren pekade ut. */
  readonly headingDeg?: number;
  readonly cells: readonly CellTuple[];
}

interface PlanSvar {
  readonly routes?: readonly PlanRoute[];
  readonly error?: string;
}

/**
 * Motorns fel är svenska meningar hela vägen ut (CONTRACT §0.6). Ett `no_route` är inte
 * ett fel användaren har begått — det är ett svar, och det ska låta som ett.
 */
export async function plan(
  req: PlanRequest,
  signal?: AbortSignal,
): Promise<readonly PlanRoute[]> {
  let svar: Response;
  try {
    svar = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error('Vi når inte planeraren just nu.');
  }

  const kropp = (await svar.json().catch(() => ({}))) as PlanSvar;

  if (!svar.ok) {
    throw new Error(kropp.error ?? 'Planeringen gick inte igenom.');
  }

  // Noll rutter är ett ärligt svar, inte ett fel: ibland finns det inga små vägar kvar att
  // föreslå. Vi säger det som det är, och användaren får dra i tidsbudgeten eller köra ändå.
  if (!Array.isArray(kropp.routes) || kropp.routes.length === 0) {
    throw new Error(req.mode === 'ab'
      ? 'Vi hittade ingen väg dit den här gången.'
      : 'Vi hittade ingen tur åt dig den här gången.');
  }

  return kropp.routes;
}

// ─── Omruttningen ───────────────────────────────────────────────────────────

export interface RerouteBody {
  /** Där bilen är, med `headingDeg` — den låser avfärdsriktningen. */
  readonly from: Waypoint;
  /** De okända vägbitar som fortfarande ligger framför oss. Turens karaktär. */
  readonly through: readonly Waypoint[];
  readonly to: Waypoint;
}

export interface RerouteSvar {
  readonly route: Route;
  /** De genompunkter som faktiskt gick att nå. Kan vara färre än vi bad om. */
  readonly through: readonly Waypoint[];
}

/**
 * Föraren valde en annan väg. Vi räknar om — och behåller turens karaktär.
 *
 * Ingen nyhet skickas med och ingen kommer tillbaka: klienten har hela sitt minne lokalt
 * och samma frusna matte (@mindful/core), så den räknar om talen själv. Servern gör ett
 * enda ruttanrop och skickar tillbaka vägen.
 */
export async function omrutta(
  body: RerouteBody,
  signal?: AbortSignal,
): Promise<RerouteSvar> {
  let svar: Response;
  try {
    svar = await fetch('/api/reroute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new Error('Vi når inte planeraren just nu.');
  }

  const kropp = (await svar.json().catch(() => ({}))) as Partial<RerouteSvar> & {
    error?: string;
  };

  if (!svar.ok || !kropp.route) {
    throw new Error(kropp.error ?? 'Vi kunde inte räkna om rutten.');
  }

  return { route: kropp.route, through: kropp.through ?? [] };
}
