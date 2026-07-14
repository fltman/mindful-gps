/**
 * Rösten. CONTRACT §6 — uppspelningen.
 *
 * ⛔ ETT `HTMLAudioElement`. ALDRIG Web Audio.
 *    Web Audio tystas av iOS ringlägesswitch. `<audio>` gör det inte. En förare med
 *    telefonen på ljudlöst skulle annars höra NOLL — och det är den ena gången i
 *    produktens liv då tystnad inte är en dygd.
 *
 * ⛔ Hela fraser. Aldrig konkatenerade fragment ("sväng " + "vänster"). Prosodin blir
 *    hackig, och en hackig röst låter stressad.
 *
 * Två lager, medvetet:
 *
 *   `VoiceEngine`  — VAD som ljuder. v1 är `SpeechVoice` (webbläsarens speechSynthesis).
 *                    Server-TTS (Piper: hela fraser → MP3 → Cache API → `audioElement()`)
 *                    är en andra implementation av samma interface, och ingen skärm
 *                    skrivs om den dagen.
 *   `Voice`        — NÄR det ljuder. Serialiserar, släpper föråldrade cues, tiger.
 *
 * `audioElement()` ägs av den här filen även i v1, där speechSynthesis inte spelar
 * genom det. Elementet är det som låser upp ljudet på en användargest och det som
 * `navigator.audioSession` hänger på — och det är det Piper-motorn kommer att spela i.
 */

// ─── Ljudsessionen ──────────────────────────────────────────────────────────

type AudioSessionType =
  | 'auto' | 'playback' | 'transient' | 'transient-solo'
  | 'ambient' | 'play-and-record';

interface AudioSession {
  type: AudioSessionType;
}

/** Safari 16.4+. Finns ingen annanstans än, och behöver inte finnas. */
interface NavigatorMedSession extends Navigator {
  audioSession?: AudioSession;
}

/**
 * 44 byte tyst WAV. Spelas en gång på en användargest för att låsa upp uppspelning —
 * iOS spelar aldrig ljud som inte har en gest bakom sig, och den gesten kommer aldrig
 * mitt i en sväng.
 */
const TYST_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

let element: HTMLAudioElement | null = null;

/**
 * Appens ENDA ljudelement. Skapas lat, återanvänds för allt.
 *
 * Ett nytt element per utrop hade fungerat i Chrome och tystnat på iOS, där bara ett
 * element som en gång fått spela på en gest behåller sitt tillstånd.
 */
export function audioElement(): HTMLAudioElement {
  if (element) return element;
  const el = new Audio();
  el.preload = 'auto';
  // Bilhållaren. Skärmen är släckt, appen är i bakgrunden — ljudet ska ändå ut.
  el.setAttribute('playsinline', '');
  element = el;
  return el;
}

/**
 * Kallas från en användargest ("Starta navigering"). Två saker händer:
 *
 *  1. Ljudelementet får spela en gång och räknas därmed som upplåst resten av sessionen.
 *  2. `transient-solo` säger till iOS att DUCKA annat ljud, inte pausa det. Musiken sänks
 *     under "Sväng vänster på väg 27" och kommer tillbaka. En GPS som stänger av Spotify
 *     varannan mil är en GPS man stänger av.
 */
export async function primeAudio(): Promise<void> {
  const nav = navigator as NavigatorMedSession;
  if (nav.audioSession) nav.audioSession.type = 'transient-solo';

  const el = audioElement();
  el.src = TYST_WAV;
  el.muted = true;
  try {
    await el.play();
  } catch {
    // Gesten kan ha varit för gammal, eller så är det en desktop utan ljudpolicy.
    // Antingen är ljudet redan upplåst eller så kommer det aldrig bli det. Vi säger
    // inte till om det — appen ska inte tjata.
  }
  el.pause();
  el.muted = false;
  el.removeAttribute('src');
}

// ─── Motorn ─────────────────────────────────────────────────────────────────

export interface VoiceEngine {
  readonly name: string;
  /**
   * Säger meningen. Resolvar när den är färdigsagd — eller när vi gett upp på den.
   * Kastar aldrig: en röst som inte kom fram är inte ett fel värt att avbryta en
   * bilfärd för.
   */
  speak(text: string): Promise<void>;
  /** Tystnad, nu. Anropas vid omruttning och när navigeringen avslutas. */
  cancel(): void;
}

/** Ungefärlig taltid. Svensk TTS i normal takt ligger kring 13–15 tecken per sekund. */
export function estimatedMs(text: string): number {
  return 500 + text.length * 75;
}

const SV = 'sv-SE';

/** `getVoices()` ljuger: iOS rapporterar `sv_SE`, andra `sv-SE`, någon enstaka bara `sv`. */
function ärSvensk(v: SpeechSynthesisVoice): boolean {
  return v.lang.replace('_', '-').toLowerCase().startsWith('sv');
}

/**
 * v1-motorn: webbläsarens egen talsyntes.
 *
 * ⚠️ Den HÄNGER SIG på iOS om appen bakgrundas mitt i en mening: `onend` kommer aldrig,
 *    och `speechSynthesis` fastnar i `speaking` — varenda utrop resten av färden
 *    försvinner tyst. Därför watchdogen. Utan den är motorn inte körbar i en bil, och
 *    en bil är det enda stället den ska köras.
 */
export class SpeechVoice implements VoiceEngine {
  readonly name = 'speechSynthesis';

  readonly #synth: SpeechSynthesis;
  #voice: SpeechSynthesisVoice | null = null;
  #letade = false;

  constructor(synth: SpeechSynthesis = window.speechSynthesis) {
    this.#synth = synth;
  }

  /**
   * Röstlistan fylls asynkront i Chrome — första `getVoices()` ger ofta tom lista. Vi
   * letar om varje gång vi inte hittat någon, och nöjer oss med systemrösten om svenska
   * saknas helt. En engelsk röst som säger "sväng vänster" är begriplig; tystnad är det
   * inte.
   */
  #svenskRöst(): SpeechSynthesisVoice | null {
    if (this.#voice) return this.#voice;
    const alla = this.#synth.getVoices();
    if (alla.length === 0) {
      this.#letade = false;
      return null;
    }
    this.#letade = true;
    this.#voice = alla.find(ärSvensk) ?? null;
    return this.#voice;
  }

  speak(text: string): Promise<void> {
    if (!text) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const röst = this.#svenskRöst();
      if (röst) u.voice = röst;
      // Språket sätts även utan röst: talsyntesen väljer då själv en svensk om den finns.
      u.lang = SV;
      u.rate = 0.95;   // en aning under normalfart. Appen har inte bråttom.
      u.pitch = 1;

      let klar = false;
      const färdig = (): void => {
        if (klar) return;
        klar = true;
        clearTimeout(vakt);
        resolve();
      };

      // WATCHDOG. Kommer inte `onend` inom dubbla den estimerade taltiden har motorn
      // hängt sig. Då river vi den och bygger upp den igen — nästa utrop ska höras.
      const vakt = setTimeout(() => {
        if (klar) return;
        this.#återskapa();
        färdig();
      }, estimatedMs(text) * 2);

      u.onend = färdig;
      u.onerror = färdig;

      this.#synth.speak(u);
    });
  }

  cancel(): void {
    this.#synth.cancel();
  }

  /**
   * Ur det hängda tillståndet. `cancel()` tömmer kön och släpper `speaking`-flaggan;
   * `resume()` behövs för det andra iOS-läget, där syntesen i stället fastnat i `paused`.
   * Röstreferensen kastas — efter en bakgrundning är den ofta ogiltig.
   */
  #återskapa(): void {
    this.#synth.cancel();
    this.#synth.resume();
    this.#voice = null;
    this.#letade = false;
  }

  /** Bara för test och felsökning. */
  get hittadeRöst(): boolean {
    return this.#letade && this.#voice !== null;
  }
}

// ─── Kön ────────────────────────────────────────────────────────────────────

/**
 * En cue som väntat längre än så har föraren redan kört förbi. Den sägs aldrig i
 * efterhand — "sväng vänster" efter korsningen är värre än tystnad.
 */
export const FÖRÅLDRAD_MS = 12_000;

interface Väntande {
  readonly text: string;
  readonly kö: number;
}

/**
 * Serialiserar utropen. Talar ett i taget, kastar det som hunnit bli inaktuellt.
 *
 * Kön är avsiktligt trubbig: tystnadsdoktrinen ger max två utrop per manöver, och
 * `CueQueue` (schedule.ts) släpper aldrig igenom båda på samma fix. Blir det ändå kö är
 * det för att motorn är seg — och då är svaret att glömma, inte att hinna ikapp.
 */
export class Voice {
  readonly #engine: VoiceEngine;
  readonly #now: () => number;
  #väntande: Väntande[] = [];
  #talar = false;
  #tyst = false;

  constructor(engine: VoiceEngine, now: () => number = Date.now) {
    this.#engine = engine;
    this.#now = now;
  }

  get talar(): boolean {
    return this.#talar;
  }

  /** Tystar rösten helt. Kartan och skärmen fortsätter — de har aldrig stört någon. */
  set tystad(v: boolean) {
    this.#tyst = v;
    if (v) this.stop();
  }

  get tystad(): boolean {
    return this.#tyst;
  }

  say(text: string): void {
    if (this.#tyst || !text) return;
    this.#väntande.push({ text, kö: this.#now() });
    if (!this.#talar) void this.#kör();
  }

  /** Ny rutt, ny tystnad. Allt som låg i kön gällde den gamla vägen. */
  stop(): void {
    this.#väntande = [];
    this.#engine.cancel();
    this.#talar = false;
  }

  async #kör(): Promise<void> {
    this.#talar = true;
    try {
      for (;;) {
        const nästa = this.#väntande.shift();
        if (!nästa) break;
        if (this.#now() - nästa.kö > FÖRÅLDRAD_MS) continue;
        await this.#engine.speak(nästa.text);
      }
    } finally {
      this.#talar = false;
    }
  }
}
