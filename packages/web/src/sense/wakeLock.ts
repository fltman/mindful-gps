/**
 * Skärmlåset.
 *
 * ⚠️ Läs det här innan du rör filen.
 *
 * Ett `WakeLockSentinel` släpps AUTOMATISKT av webbläsaren så fort dokumentet blir dolt —
 * en notis, ett inkommande samtal, användaren som byter flik i tio sekunder. Sentinelen är
 * då död för alltid, och den säger det inte högt. Utan återtagning på VARJE
 * `visibilitychange` betyder det: skärmen somnar, `watchPosition` slutar leverera, och
 * resten av turen försvinner UTAN felmeddelande. Det är den värsta buggen i appen,
 * eftersom den bara syns som ett spår som tar slut mitt i ingenstans.
 *
 * Därför är återtagningen inte en optimering utan hela poängen med filen.
 *
 * Låset är en process, inte ett anrop: `keepAwake()` är idempotent och returnerar samma
 * handtag varje gång, `releaseAwake()` river ner det.
 */

interface Awake {
  /** Löser ut när det FÖRSTA försöket är klart. false = webbläsaren kan eller vill inte. */
  readonly granted: Promise<boolean>;
  readonly active: boolean;
}

interface Handle {
  sentinel: WakeLockSentinel | null;
  granted: Promise<boolean>;
  onVisibility: () => void;
  stopped: boolean;
}

let handle: Handle | null = null;

async function acquire(h: Handle): Promise<boolean> {
  if (h.stopped || h.sentinel !== null) return h.sentinel !== null;
  if (!('wakeLock' in navigator)) return false;
  if (document.visibilityState !== 'visible') return false;

  try {
    const s = await navigator.wakeLock.request('screen');
    if (h.stopped) {
      void s.release();
      return false;
    }
    h.sentinel = s;

    // Webbläsaren kan släppa låset på eget bevåg. Nolla referensen, annars tror vi att
    // vi har ett lås vi inte har och tar aldrig ett nytt.
    s.addEventListener('release', () => {
      if (h.sentinel === s) h.sentinel = null;
    });

    return true;
  } catch {
    // NotAllowedError: låg batterinivå, strömsparläge, eller dokumentet dolt just nu.
    // Inget att göra åt — men nästa visibilitychange försöker igen.
    return false;
  }
}

/**
 * Håll skärmen vaken tills `releaseAwake()`.
 *
 * Anropa från samma tap-handler som resten av tillstånden (`permissions.ts`): vissa
 * webbläsare kräver användarinteraktion för det allra första låset.
 */
export function keepAwake(): Awake {
  const existing = handle;
  if (existing && !existing.stopped) {
    return {
      granted: existing.granted,
      get active() {
        return existing.sentinel !== null;
      },
    };
  }

  const h: Handle = {
    sentinel: null,
    granted: Promise.resolve(false),
    onVisibility: () => {},
    stopped: false,
  };

  h.onVisibility = () => {
    if (document.visibilityState === 'visible') void acquire(h);
  };
  document.addEventListener('visibilitychange', h.onVisibility);

  h.granted = acquire(h);
  handle = h;

  return {
    granted: h.granted,
    get active() {
      return h.sentinel !== null;
    },
  };
}

export function releaseAwake(): void {
  const h = handle;
  if (!h) return;

  h.stopped = true;
  document.removeEventListener('visibilitychange', h.onVisibility);
  void h.sentinel?.release();
  h.sentinel = null;
  handle = null;
}

/** Har vi ett levande skärmlås just nu? */
export function isAwake(): boolean {
  return handle?.sentinel != null;
}
