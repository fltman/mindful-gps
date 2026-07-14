/**
 * Skrivvägen. CONTRACT §3.4, steg för steg.
 *
 *   fix → råspår (ALLTID) → grind → densifiering ≤15 m → gridPathCells → upsert → IndexedDB
 *
 * Tre saker är värda att förstå innan man ändrar något här.
 *
 * 1. RÅSPÅRET FÅR ALLT. Även fixen med 400 meters osäkerhet. Råspåren är sanningen och
 *    kan alltid räknas om; H3-minnet är en cache som byggs ur dem. Därför sitter grinden
 *    (accuracy ≤ 30 m, Δt ≥ 1 s, Δd ≥ 10 m) mellan råspåret och cellerna, aldrig före
 *    råspåret — och därför filtrerar `BrowserGeoProvider` ingenting.
 *
 * 2. DENSIFIERINGEN ÄR INTE EN OPTIMERING. Vid 90 km/h och 1 Hz rör du dig 25 m per fix,
 *    och medelkordan i H3 res 11 är 39,3 m. Utan interpolation hoppar vi över celler och
 *    minnet blir ett streckat spår. MEN över ett hål större än 200 m interpolerar vi
 *    aldrig: då hittar vi på en väg vi inte har kört. Hålet bokförs som `Gap` i stället,
 *    och kilometrarna i det räknas inte — appen påstår hellre för lite än för mycket.
 *
 * 3. NYHETEN MÄTS VID FÖRSTA ANBLICKEN. Cellerna skrivs till minnet var tionde sekund,
 *    och en cell som just skrivits är per definition inte längre ny. Läste vi nyheten i
 *    efterhand skulle turen tappa sin nyhet medan den pågår — så vi läser varje cells
 *    nyhet i samma ögonblick som vi första gången ser den, och sparar talet.
 *    (Att grannceller från samma tur inte smittar följer av `visits ≥ 2` i §3.3: en
 *    cell vi kört EN gång bidrar inte till sina grannars familiaritet.)
 */

import {
  MAX_GAP_M, MIN_ACCURACY_M, MIN_FIX_DISTANCE_M, MIN_FIX_INTERVAL_MS,
  cellNovelty, encode6, haversine, todayDay,
  type CellVisit, type Gap, type RawTrace,
} from '@mindful/core';

import { cellsAlong } from '../memory/visited.js';

import { fixAt, type Fix, type GeoProvider } from './GeoProvider.js';
import type { RecorderMemory } from './memory.js';

/** CONTRACT §3.4 steg 8. Aldrig per fix — en IndexedDB-transaktion i sekunden dödar batteriet. */
const FLUSH_MS = 10_000;

/** UI:t behöver inte veta om varje meter. Kartan uppdateras per fix, siffrorna sällan. */
const PROGRESS_MS = 2000;

export type RecordMode = RawTrace['mode'];

export interface RecorderProgress {
  readonly tripKm: number;
  readonly tripNovelKm: number;
  readonly gapCount: number;
}

interface Events {
  /** Varje fix, orörd. Kartan ritar ur den här — utanför React. */
  readonly fix: Fix;
  readonly progress: RecorderProgress;
  /** Svensk mening. Lagringen sviktade; körningen fortsätter ändå. */
  readonly error: string;
}

export interface Recorder {
  readonly recording: boolean;
  start(mode: RecordMode): void;
  /** Returnerar spåret, eller null om ingen inspelning pågick. */
  stop(): Promise<RawTrace | null>;
  on<K extends keyof Events>(event: K, cb: (value: Events[K]) => void): () => void;
}

export function createRecorder(geo: GeoProvider, mem: RecorderMemory): Recorder {
  const listeners: { [K in keyof Events]: Set<(v: Events[K]) => void> } = {
    fix: new Set(),
    progress: new Set(),
    error: new Set(),
  };

  let recording = false;
  let mode: RecordMode = 'free';
  let startedAt = 0;

  // Råspåret. Ingen fix kastas.
  let raw: Fix[] = [];
  let gaps: Gap[] = [];
  let distanceM = 0;
  let novelM = 0;

  /** Senaste fix som tog sig igenom grinden. Densifieringen går alltid härifrån. */
  let lastKept: Fix | undefined;

  /**
   * Cellerna vi redan bokfört den här turen, med sin nyhet läst vid första anblicken
   * (se punkt 3 i filhuvudet). Nyckelmängden är också turens dedup: en cell räknas som
   * ETT besök hur många fixar den än rymmer. Densifieringen lägger en punkt var 15:e
   * meter genom en cell som är 50 m bred — utan dedupen hade en enda genomkörning
   * bokförts som tre.
   */
  let noveltyOf = new Map<bigint, number>();
  /** Celler som väntar på att skrivas ner. Töms var tionde sekund. */
  let pending: CellVisit[] = [];

  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let lastProgress = 0;

  function emit<K extends keyof Events>(event: K, value: Events[K]): void {
    for (const cb of listeners[event]) cb(value);
  }

  function progress(): RecorderProgress {
    return {
      tripKm: distanceM / 1000,
      tripNovelKm: novelM / 1000,
      gapCount: gaps.length,
    };
  }

  /** Duger fixen att skriva in i minnet? Råspåret har redan fått den. */
  function passesGate(f: Fix): boolean {
    if (!(f.accuracyM <= MIN_ACCURACY_M)) return false;   // NaN och Infinity faller här
    if (!lastKept) return true;

    const dt = f.t - lastKept.t;
    const dm = haversine(fixAt(lastKept), fixAt(f));
    return dt >= MIN_FIX_INTERVAL_MS && dm >= MIN_FIX_DISTANCE_M;
  }

  function onFix(f: Fix): void {
    if (!recording) return;

    const prevRaw = raw[raw.length - 1];
    raw.push(f);
    emit('fix', f);

    if (prevRaw) {
      const d = haversine(fixAt(prevRaw), fixAt(f));
      if (d > MAX_GAP_M) {
        // Signalförlust, tunnel, eller en skärm som somnade. Vi vet inte vad som hände
        // däremellan, och vi gissar inte.
        gaps.push({
          fromIdx: raw.length - 2,
          toIdx: raw.length - 1,
          distanceM: d,
          ms: f.t - prevRaw.t,
        });
      } else {
        distanceM += d;
      }
    }

    if (passesGate(f)) {
      const from = lastKept;
      lastKept = f;

      if (from) {
        const a = fixAt(from);
        const b = fixAt(f);
        const legM = haversine(a, b);

        if (legM <= MAX_GAP_M) {
          // Densifiering, cellifiering, diagonalhål och axelmask ligger i `cellsAlong` —
          // samma kod som minnesmodulen använder när den bygger om ett spår i efterhand.
          // Två implementationer av §3.4 hade blivit två olika minnen av samma tur.
          const speed = f.speedMs ?? (legM * 1000) / Math.max(1, f.t - from.t);
          const cells = cellsAlong([a, b], [speed]);
          const today = todayDay(f.t);

          let noveltySum = 0;
          for (const v of cells) {
            let n = noveltyOf.get(v.h3);
            if (n === undefined) {
              n = cellNovelty(v.h3, mem.visited, today);
              noveltyOf.set(v.h3, n);
              pending.push(v);
            }
            noveltySum += n;
          }

          if (cells.length > 0) novelM += (noveltySum / cells.length) * legM;
        }
      }
    }

    const now = Date.now();
    if (now - lastProgress >= PROGRESS_MS) {
      lastProgress = now;
      emit('progress', progress());
    }
  }

  async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;

    const batch = pending;
    pending = [];
    flushing = true;

    try {
      await mem.commitVisits(batch, todayDay());
    } catch {
      // Cellerna får inte tappas bort bara för att en transaktion sket sig — lägg
      // tillbaka dem först i kön och ta dem i nästa svep.
      pending = [...batch, ...pending];
      emit('error', 'Minnet kunde inte sparas just nu. Vi försöker igen om tio sekunder.');
    } finally {
      flushing = false;
    }
  }

  return {
    get recording() {
      return recording;
    },

    start(m: RecordMode): void {
      if (recording) return;

      recording = true;
      mode = m;
      startedAt = Date.now();

      raw = [];
      gaps = [];
      distanceM = 0;
      novelM = 0;
      lastKept = undefined;
      noveltyOf = new Map();
      pending = [];
      lastProgress = 0;

      geo.start(onFix);
      flushTimer = setInterval(() => void flush(), FLUSH_MS);
    },

    async stop(): Promise<RawTrace | null> {
      if (!recording) return null;
      recording = false;

      geo.stop();
      if (flushTimer !== undefined) {
        clearInterval(flushTimer);
        flushTimer = undefined;
      }

      await flush();
      emit('progress', progress());

      const trace: RawTrace = {
        id: crypto.randomUUID(),
        startedAt,
        endedAt: Date.now(),
        mode,
        polyline6: encode6(raw.map(fixAt)),
        // Hålens meter räknas inte in. Vi tar bara betalt för väg vi har sett.
        distanceM,
        gaps,
        synced: false,
      };

      try {
        await mem.putTrace(trace);
      } catch {
        emit('error', 'Turen kunde inte sparas. Stäng inte fliken — försök igen.');
      }

      return trace;
    },

    on<K extends keyof Events>(event: K, cb: (value: Events[K]) => void): () => void {
      listeners[event].add(cb);
      return () => {
        listeners[event].delete(cb);
      };
    },
  };
}
