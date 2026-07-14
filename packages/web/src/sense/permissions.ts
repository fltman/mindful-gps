/**
 * Allt vi behöver av användaren, i EN enda tap-handler.
 *
 * ⚠️ Ordningen i `requestSenses()` är inte godtycklig. iOS ger bara "transient activation"
 *    under den synkrona delen av en tap-handler — första `await` konsumerar den. Allt som
 *    KRÄVER en gest (ljuduppspelning, DeviceOrientation, skärmlås) måste därför STARTAS
 *    synkront, före den första `await`:en. Vi startar alla löften först och väntar in dem
 *    sedan. Skriver du om det här till en snygg `await`-kedja slutar ljudet fungera på
 *    iPhone, och bara på iPhone.
 *
 * Rapporten säger vad som lyckades och vad som nekades, för UI:t ska kunna vara ärligt.
 * Appen fortsätter fungera med nekad orientering, nekat ljud och nekat skärmlås — bara
 * nekad position gör den meningslös.
 */

import { keepAwake } from './wakeLock.js';

export type Granted = 'beviljad' | 'nekad' | 'saknas';

export interface PermissionReport {
  /** Utan den här är produkten ingen produkt. */
  readonly geolocation: Granted;
  /** iOS kräver en gest för kompassen. Nekad → kartan roterar inte, inget mer. */
  readonly orientation: Granted;
  /** Ljudet kan bara låsas upp av en gest. Nekat → tyst navigation. */
  readonly audio: Granted;
  readonly wakeLock: Granted;
  readonly speech: Granted;
  /** `navigator.storage.persist()`. Nekad → minnet kan vräkas av iOS. */
  readonly storage: Granted;
  /** Svenska, färdiga meningar. Bara det som INTE fungerar. Tom lista = allt är bra. */
  readonly problems: readonly string[];
}

/** DeviceOrientationEvent har `requestPermission` bara på iOS. Resten av världen saknar den. */
interface OrientationPermissionApi {
  requestPermission?: () => Promise<PermissionState | 'granted' | 'denied'>;
}

/** Safari 16.4+. Duckar Spotify i stället för att pausa den (CONTRACT §6). */
interface AudioSessionApi {
  audioSession?: { type: string };
}

let audio: HTMLAudioElement | undefined;

/**
 * Appens ENDA ljudelement (CONTRACT §6).
 *
 * Ett `<audio>`-element, aldrig Web Audio: iOS ringlägesswitch tystar Web Audio men inte
 * `<audio>`. En förare med telefonen på ljudlöst skulle annars höra exakt ingenting — och
 * inte veta om det.
 *
 * Elementet är också det som röstmodulen ska spela sina fraser genom. Skapa aldrig ett till.
 */
export function audioElement(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio('/silent-100ms.mp3');
    audio.preload = 'auto';
    // iOS vill annars ta över skärmen med sin egen spelare när ljudet startar.
    audio.setAttribute('playsinline', '');
  }
  return audio;
}

/**
 * Fråga om allt, en gång. MÅSTE anropas direkt ur en tap-handler.
 */
export async function requestSenses(): Promise<PermissionReport> {
  // ── Synkron del: allt som kräver en gest startas HÄR, före första await ──────

  const el = audioElement();
  const nav = navigator as Navigator & AudioSessionApi;
  if (nav.audioSession) nav.audioSession.type = 'transient-solo';

  // Tyst 100 ms — vi vill inte höra upplåsningen, bara ha den gjord.
  el.muted = false;
  el.currentTime = 0;
  const audioPlay: Promise<void> = el.play().catch(() => {
    throw new Error('nekad');
  });

  const doe = (globalThis as { DeviceOrientationEvent?: OrientationPermissionApi })
    .DeviceOrientationEvent;
  const orientationAsk: Promise<Granted> = doe === undefined
    ? Promise.resolve<Granted>('saknas')
    : typeof doe.requestPermission !== 'function'
      // Ingen requestPermission = ingen fråga att ställa. Android och desktop skickar
      // orienteringshändelser utan att be om lov.
      ? Promise.resolve<Granted>('beviljad')
      : doe.requestPermission()
          .then((r): Granted => (r === 'granted' ? 'beviljad' : 'nekad'))
          .catch((): Granted => 'nekad');

  const awake = keepAwake();

  const speech: Granted = primeSpeech();

  const geoAsk: Promise<Granted> = askGeolocation();

  const storageAsk: Promise<Granted> = !navigator.storage?.persist
    ? Promise.resolve<Granted>('saknas')
    : navigator.storage.persist()
        .then((ok): Granted => (ok ? 'beviljad' : 'nekad'))
        .catch((): Granted => 'nekad');

  // ── Först här får vi vänta ───────────────────────────────────────────────────

  const [audioR, orientation, wake, geolocation, storage] = await Promise.all([
    audioPlay.then((): Granted => 'beviljad').catch((): Granted => 'nekad'),
    orientationAsk,
    awake.granted.then((ok): Granted => (ok ? 'beviljad' : 'nekad')),
    geoAsk,
    storageAsk,
  ]);

  const problems: string[] = [];
  if (geolocation !== 'beviljad') {
    problems.push('Utan din position kan appen inte minnas var du kört. Slå på platstjänster och ladda om.');
  }
  if (audioR !== 'beviljad') {
    problems.push('Ljudet är låst. Appen kör vidare, men den säger ingenting.');
  }
  if (wake !== 'beviljad') {
    problems.push('Skärmen kan slockna under körningen. Håller du den tänd sparas hela turen.');
  }
  if (storage === 'nekad') {
    problems.push('Telefonen lovar inte att spara minnet. Lägg appen på hemskärmen, så gör den det.');
  }
  if (orientation === 'nekad') {
    problems.push('Kompassen är avstängd. Kartan pekar norrut i stället för framåt.');
  }

  return {
    geolocation,
    orientation,
    audio: audioR,
    wakeLock: wake,
    speech,
    storage,
    problems,
  };
}

/**
 * Väck talsyntesen medan gesten fortfarande gäller.
 *
 * Första `speak()` efter sidladdning är stum på iOS om den inte kommer ur en gest — och
 * `speechSynthesis` är vår fallback-röst. Vi säger ingenting hörbart: en tyst tugga räcker
 * för att motorn ska vakna.
 */
function primeSpeech(): Granted {
  if (!('speechSynthesis' in window)) return 'saknas';
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = 'sv-SE';
    speechSynthesis.speak(u);
    return 'beviljad';
  } catch {
    return 'nekad';
  }
}

/**
 * En enda position, bara för att få fram dialogrutan. Svaret slänger vi — `recorder`
 * startar sin egen `watchPosition` direkt efteråt.
 */
function askGeolocation(): Promise<Granted> {
  if (!('geolocation' in navigator)) return Promise.resolve<Granted>('saknas');

  return new Promise<Granted>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('beviljad'),
      (e) => resolve(e.code === e.PERMISSION_DENIED ? 'nekad' : 'beviljad'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
    );
  });
}
