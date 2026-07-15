/**
 * Simulerad GPS. Spelar upp ett spår i vald hastighet, 1 Hz, med realistiskt brus.
 *
 * Utan den här filen går appen bara att utveckla i bil. Den är därför inte en leksak —
 * den är byggkedjan. Aktiveras med `?sim=1`.
 *
 *   ?sim=1                        Smålandsspåret i 70 km/h
 *   ?sim=1&kph=45&varv=1          långsammare, och spåret börjar om när det tar slut
 *   ?sim=1&brus=25                25 m brus — så här ser en dålig fix ut, testa grinden
 *   ?sim=1&takt=40                väggklockan komprimerad 25× — en timmes körning på två minuter
 *   ?sim=1&start=14.8059,56.8777  börja i Växjö i stället för på Smålandsspåret
 *
 * Väljer man en rutt spelar simulatorn upp DEN i stället för Smålandsspåret (`setTrack`).
 * Det är enda sättet att testa navigeringen utan bil, och navigeringen är halva produkten.
 *
 * Simulatorn ljuger inte snällare än verkligheten: den ger `speedMs` och `headingDeg`
 * precis som en telefon gör, och den lägger på fel som är KORRELERADE mellan sekunder.
 * Vitt brus hade gett en punktsvärm som medelvärdesbildas bort av sig själv; riktig
 * GPS driver i stället långsamt åt sidan i tiotals sekunder, och det är just den driften
 * som gör att `NEIGHBOR_SOFTNESS` behövs.
 *
 * ── Två klockor, och varför ──────────────────────────────────────────────────
 *
 * `takt` komprimerar VÄGGKLOCKAN. Fixarna kommer tätare i verklig tid, men de bär
 * fortfarande en tidsstämpel som går en simulerad sekund per fix.
 *
 * ⚠️ Det är inte en finess, det är ett krav. Recorderns grind (CONTRACT §3.4 steg 3)
 *    släpper bara igenom en fix om `Δt ≥ 1000 ms`, mätt på fixens EGEN tidsstämpel. Satte
 *    vi `t: Date.now()` och tickade var 40:e ms skulle varenda fix falla på grinden, ingen
 *    cell skrivas, och turen landa i nätet som noll kilometer — utan att något syntes gå
 *    fel. Simulatorn har därför en egen tidsaxel, och den går i simulerad takt.
 */

import { bearing, decode6, haversine, type LngLat, type Polyline6 } from '@mindful/core';

import type { Fix, GeoProvider } from './GeoProvider.js';
import { SMALAND_TRACK } from './track.smaland.js';

export interface SimOptions {
  readonly polyline6?: Polyline6;
  /**
   * Var bilen STÅR innan en rutt är vald. "Vart?" börjar med "var är jag", och i en
   * simulering ska den frågan gå att besvara med något annat än spårets början.
   * Ignoreras om `polyline6` är satt — då är startpunkten spårets första punkt.
   */
  readonly startAt?: LngLat;
  readonly speedKph?: number;
  /** Ungefärlig storlek på positionsfelet, meter. Verklig telefon i skog: 5–15 m. */
  readonly noiseM?: number;
  /** Spela spåret om och om igen i stället för att stanna vid slutet. */
  readonly loop?: boolean;
  /** Väggklocka mellan fixar, ms. Under 1000 går simuleringen fortare än verkligheten. */
  readonly tickMs?: number;
}

const DEFAULT_SPEED_KPH = 70;
const DEFAULT_NOISE_M = 8;

/** Simulerad tid per fix. En telefon ger 1 Hz, och det är den takten allt annat räknar med. */
const STEP_MS = 1000;

/** Väggklocka per fix. Lika med `STEP_MS` = realtid. */
const DEFAULT_TICK_MS = 1000;

/** Snabbare än så hinner varken kartan eller talsyntesen med, och då mäter vi dem i stället. */
export const MIN_TICK_MS = 10;

/** Simulerad tid per fix, exporterad så farten kan uttryckas som en multipel av realtid. */
export const SIM_STEG_MS = STEP_MS;

/**
 * Simuleringen bara om `?sim=1`. Returnerar null i skarpt läge — då är det telefonens
 * GPS som gäller, och ingen URL i världen ska kunna byta ut den av misstag.
 */
export function simOptionsFromUrl(search: string = location.search): SimOptions | null {
  const q = new URLSearchParams(search);
  if (q.get('sim') !== '1') return null;

  // `Number(null)` är 0, inte NaN. En saknad parameter hade annars blivit "noll meters
  // brus" — en perfekt GPS som inte finns, i just den körning som ska visa att vi tål brus.
  const num = (key: string): number => {
    const raw = q.get(key);
    return raw === null ? Number.NaN : Number(raw);
  };

  const kph = num('kph');
  const brus = num('brus');
  const takt = num('takt');
  const start = punkt(q.get('start'));

  return {
    ...(start ? { startAt: start } : {}),
    speedKph: Number.isFinite(kph) && kph > 0 ? kph : DEFAULT_SPEED_KPH,
    noiseM: Number.isFinite(brus) && brus >= 0 ? brus : DEFAULT_NOISE_M,
    loop: q.get('varv') === '1',
    tickMs: Number.isFinite(takt) && takt > 0
      ? Math.max(MIN_TICK_MS, takt)
      : DEFAULT_TICK_MS,
  };
}

/** `?start=14.8059,56.8777` → [lon, lat]. Alltid lon först — inga undantag (CONTRACT §0.1). */
function punkt(raw: string | null): LngLat | null {
  if (raw === null) return null;

  const delar = raw.split(',').map(Number);
  const [lon, lat] = delar;
  if (delar.length !== 2 || lon === undefined || lat === undefined) return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;

  return [lon, lat];
}

/**
 * Spåret för en bil som står stilla.
 *
 * Två punkter drygt en meter isär, inte en. Ett spår med en enda punkt är ingen väg, och
 * simulatorn hade tystnat helt (`start()` kräver två punkter) — vilket hade sett ut som en
 * GPS som aldrig får fix, i just det läge som ska visa var vi står.
 */
function stillastående(at: LngLat): LngLat[] {
  return [at, [at[0], at[1] + 1e-5]];
}

/** Deterministisk brusgenerator: samma sim-körning varje gång, annars går buggar inte att jaga. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Kumulativ längd fram till varje punkt. `cum[i]` hör till `shape[i]`. */
function cumulative(shape: readonly LngLat[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1];
    const b = shape[i];
    cum.push((cum[i - 1] ?? 0) + (a && b ? haversine(a, b) : 0));
  }
  return cum;
}

export class SimGeoProvider implements GeoProvider {
  #shape: readonly LngLat[];
  #cum: readonly number[];
  readonly #speedMs: number;
  readonly #noiseM: number;
  readonly #loop: boolean;
  /** Väggklocka per fix. INTE readonly: ett reglage i simläge ändrar den under körning. */
  #tickMs: number;
  readonly #rnd = lcg(0x5eed_1e55);

  #timer: ReturnType<typeof setInterval> | undefined;
  /** Callbacken som tar emot fixar. Sparad så takten kan bytas utan att tappa mottagaren. */
  #cb: ((f: Fix) => void) | undefined;
  #alongM = 0;
  /** Simulatorns egen tidsaxel. Går en simulerad sekund per fix, oavsett väggklockan. */
  #t = 0;
  /** Positionsfelet just nu, i meter öster/norr. Ett AR(1)-brus, inte en tärning per tick. */
  #errE = 0;
  #errN = 0;

  constructor(options: SimOptions = {}) {
    this.#shape = options.polyline6 !== undefined
      ? decode6(options.polyline6)
      : options.startAt !== undefined
        ? stillastående(options.startAt)
        : decode6(SMALAND_TRACK);
    this.#cum = cumulative(this.#shape);
    this.#speedMs = ((options.speedKph ?? DEFAULT_SPEED_KPH) * 1000) / 3600;
    this.#noiseM = options.noiseM ?? DEFAULT_NOISE_M;
    this.#loop = options.loop ?? false;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  get lengthM(): number {
    return this.#cum[this.#cum.length - 1] ?? 0;
  }

  /**
   * Byt spår. Det här är vad som gör navigeringen testbar utan bil: den valda rutten blir
   * det simulerade GPS-spåret, och appen får följa exakt den väg den själv föreslog.
   *
   * Ett spår med färre än två punkter är ingen väg — då behåller vi det gamla hellre än att
   * tyst leverera noll fixar och låta någon leta i navigeringen efter felet.
   */
  setTrack(polyline6: Polyline6): void {
    const shape = decode6(polyline6);
    if (shape.length < 2) return;

    this.stop();
    this.#shape = shape;
    this.#cum = cumulative(shape);
    this.#alongM = 0;
  }

  start(cb: (f: Fix) => void): void {
    if (this.#timer !== undefined || this.#shape.length < 2) return;

    this.#cb = cb;

    // En ny tur börjar vid spårets början, inte där den förra slutade. Utan den här raden
    // står andra körningen i samma flik still vid slutmålet och levererar en enda fix.
    this.#alongM = 0;

    // Den simulerade klockan startar på den riktiga: `todayDay(f.t)` ska ge dagens datum,
    // annars bokförs turen på fel dag och recency-decayen (τ = 500 d) räknar från fel dag.
    this.#t = Date.now();

    // Första fixen direkt: en riktig telefon som redan har låst har också en position
    // att ge oss i samma ögonblick som vi börjar lyssna.
    cb(this.#sample());

    this.#startaIntervall();
  }

  /** Själva tickandet. Bruten ur `start` så takten kan bytas: klipp och starta om. */
  #startaIntervall(): void {
    const cb = this.#cb;
    if (cb === undefined) return;

    this.#timer = setInterval(() => {
      this.#t += STEP_MS;
      this.#alongM += this.#speedMs * (STEP_MS / 1000);

      if (this.#alongM >= this.lengthM) {
        if (!this.#loop) {
          this.#alongM = this.lengthM;
          cb(this.#sample());
          this.stop();
          return;
        }
        this.#alongM -= this.lengthM;
      }

      cb(this.#sample());
    }, this.#tickMs);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Väggklockan per fix, just nu. Realtid = SIM_STEG_MS. */
  get taktMs(): number {
    return this.#tickMs;
  }

  /**
   * Byt fart under körningen. Simulerad tid och position rör sig inte — bara hur ofta
   * fixarna kommer i verklig tid. Ett löpande intervall klipps och startas om med den nya
   * takten; står simulatorn still rör vi ingenting.
   */
  setTaktMs(ms: number): void {
    this.#tickMs = Math.max(MIN_TICK_MS, ms);
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#startaIntervall();
    }
  }

  /** Standardnormalfördelat tal, Box–Muller. */
  #gauss(): number {
    const u = Math.max(1e-9, this.#rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.#rnd());
  }

  /**
   * AR(1): felet minns 90 % av förra sekunden. Med `a = 0.9` blir felets stationära
   * spridning `sigma / sqrt(1 - a²)`, så vi skalar insteget därefter — annars hade
   * "8 meters brus" blivit 18 meter efter en halv minut.
   */
  #drift(): void {
    const a = 0.9;
    const step = (this.#noiseM / 2) * Math.sqrt(1 - a * a);
    this.#errE = a * this.#errE + this.#gauss() * step;
    this.#errN = a * this.#errN + this.#gauss() * step;

    const r = Math.hypot(this.#errE, this.#errN);
    if (r > this.#noiseM) {
      this.#errE *= this.#noiseM / r;
      this.#errN *= this.#noiseM / r;
    }
  }

  #sample(): Fix {
    const { at, brg } = this.#pointAt(this.#alongM);
    this.#drift();

    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos((at[1] * Math.PI) / 180);

    const speed = Math.max(0, this.#speedMs + this.#gauss() * 0.4);

    return {
      lon: at[0] + this.#errE / mPerDegLon,
      lat: at[1] + this.#errN / mPerDegLat,
      accuracyM: Math.max(3, this.#noiseM * 0.8 + this.#gauss() * 1.5),
      speedMs: speed,
      headingDeg: brg,
      // Simulerad tid, inte väggklocka. Se filhuvudet: recorderns grind mäter Δt på FIXENS
      // tidsstämpel, och en komprimerad väggklocka hade stängt den helt.
      t: this.#t,
    };
  }

  /** Punkten `alongM` meter in på spåret, plus vägens riktning där. */
  #pointAt(alongM: number): { at: LngLat; brg: number } {
    const first = this.#shape[0] ?? ([0, 0] as LngLat);

    let i = 1;
    while (i < this.#cum.length - 1 && (this.#cum[i] ?? 0) < alongM) i++;

    const a = this.#shape[i - 1] ?? first;
    const b = this.#shape[i] ?? first;
    const segStart = this.#cum[i - 1] ?? 0;
    const segM = (this.#cum[i] ?? 0) - segStart;
    const t = segM > 0 ? Math.min(1, Math.max(0, (alongM - segStart) / segM)) : 0;

    return {
      at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      brg: bearing(a, b),
    };
  }
}
