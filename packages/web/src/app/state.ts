/**
 * Skalet: appens tillstånd, och motorn under det.
 *
 * ⚠️ Två saker lever MEDVETET utanför React: GPS-loopen och kartan.
 *
 * En biltur är två timmar à en fix i sekunden. Ritade vi om ett komponentträd per fix
 * blev det 7 200 renderingar — och det är inte en prestandafråga utan en batterifråga.
 * En GPS utan batteri är en tegelsten. Därför:
 *
 *   fix  →  kartan, imperativt, varje sekund   (`karta.setFix` / `addTracePoint`)
 *   fix  →  storen, var 2:a sekund             (recordern strypar själv sin `progress`)
 *
 * Motorn (minne, recorder, kartans handtag) är modulvariabler, inte state. Ingenting av
 * det ska kunna orsaka en rendering bara för att det ändras.
 */

import {
  decode6, todayDay,
  type LngLat, type RawTrace, type Route, type Waypoint,
} from '@mindful/core';
import { create } from 'zustand';

import type { MapHandle, SevärdhetsTryck, WebThread } from '../map/index.js';
import { memoryStats, startSync, syncOutbox } from '../memory/index.js';
import { prepare, type NavPlan, type RerouteRequest } from '../nav/index.js';
import { omrutta } from '../plan/api.js';
// Direkt ur modulen, inte barrelen: den senare drar in hela ui:t (tsx-komponenter) i
// storen, som inte är React. `sevardhetBerattelse` är ren TS.
import { förhandshämta } from '../ui/sevardhetBerattelse.js';
import {
  createGeoProvider, createRecorder, idbMemory, isSimulated, releaseAwake, requestSenses,
  simFart, simStartFart, sättSimFart, simulateRoute,
  type Fix, type GeoProvider, type IdbMemory, type RecordMode, type Recorder,
} from '../sense/index.js';

/** Sex vyer. Det behöver fortfarande inget routerbibliotek. */
export type Vy = 'intro' | 'hem' | 'planera' | 'navigera' | 'kör' | 'efter';

/**
 * Turen vi navigerar just nu.
 *
 * `plan` bär genompunkterna — de okända vägbitar planeraren tvingade rutten genom. En
 * omruttning ÄRVER dem, och det är hela skillnaden mellan "vi behåller din tur" och
 * "vi tar dig snabbaste vägen tillbaka". `route` är samma rutt, obearbetad, som kartan
 * ritar ur.
 */
export interface NavUppdrag {
  readonly plan: NavPlan;
  readonly route: Route;
  /** "Kalmar", eller `null` i en slinga och ett utsvep — då är målet hemmet man står i. */
  readonly mål: string | null;
}

export interface AppState {
  readonly vy: Vy;
  readonly status: 'idle' | 'recording';
  /** Senaste GPS-fix. Uppdateras i storen var 2:a sekund — kartan får den varje sekund. */
  readonly fix: Fix | null;
  readonly tripKm: number;
  readonly tripNovelKm: number;
  /** Hela nätet, alla turer. */
  readonly netKm: number;
  readonly gapCount: number;
  /** Rutten vi följer, eller null i fri körning. Byts ut vid omruttning. */
  readonly nav: NavUppdrag | null;
  /** Sevärdheten föraren tryckte på, eller null. Öppnar berättelsebladet. */
  readonly valdSevärdhet: SevärdhetsTryck | null;
  /** Svensk, färdig mening. Aldrig en felkod. */
  readonly error: string | null;
}

export interface Actions {
  boot(): Promise<void>;
  /** Kartan monteras en gång och ommonteras aldrig. Skalet behöver bara handtaget. */
  registreraKarta(handtag: MapHandle | null): void;
  godkännIntro(): void;
  start(): Promise<void>;
  stopp(): Promise<void>;
  klar(): void;
  dela(): Promise<void>;
  öppnaPlan(): void;
  stängPlan(): void;
  /** En vald rutt blir en navigerad tur. Rutten ligger kvar på kartan medan man kör den. */
  körPlanerad(
    rutt: Route, through: readonly Waypoint[], läge: RecordMode, mål: string | null,
  ): Promise<void>;
  /** Föraren valde en annan väg. Vi räknar om och behåller turens karaktär. */
  omrutt(req: RerouteRequest): Promise<void>;
  /** `true` = vi kom fram. `false` = föraren avslutade själv. */
  avslutaNav(framme: boolean): Promise<void>;
  /** Föraren tryckte på en sevärdhet. Öppnar bladet — appen talar aldrig oombett. */
  visaSevärdhet(s: SevärdhetsTryck): void;
  stängSevärdhet(): void;
}

interface Motor {
  readonly minne: IdbMemory;
  readonly recorder: Recorder;
}

// ─── Utanför React ──────────────────────────────────────────────────────────

let motor: Motor | null = null;
let karta: MapHandle | null = null;
/** GPS:en. Recordern äger den under en tur; mellan turerna får planeringen låna den. */
let geo: GeoProvider | null = null;
/** Pejlar vi efter en engångsposition just nu? Se `siktaPosition`. */
let siktar = false;
/** Alla körda turer, som trådar i spindelnätet. */
let trådar: WebThread[] = [];
/** Senaste fixen, orörd. Skrivs varje sekund, läses in i storen varannan. */
let senasteFix: Fix | null = null;
let bootad = false;
let stoppaSync: (() => void) | null = null;

const INTRO_NYCKEL = 'mindful.intro';

/** Introt är en UI-preferens, inte ett minne — därför localStorage och inte `meta`
 *  (vars nycklar är frusna i CONTRACT §3.5). */
const introSedd = (): boolean => localStorage.getItem(INTRO_NYCKEL) === '1';

/** Ett råspår blir en tråd. Ljusstyrkan sätter kartan själv, ur `lastSeenDay`. */
const tillTråd = (t: RawTrace): WebThread => ({
  id: t.id,
  shape: decode6(t.polyline6),
  lastSeenDay: todayDay(t.endedAt),
});

const felText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback;

/**
 * En rutt blir något att följa.
 *
 * Målet läses ur ruttens EGEN sista punkt, inte ur det användaren skrev in. De två är
 * nästan alltid samma plats — men "nästan" räcker inte: motorn snappar målet till närmaste
 * väg, och en omruttning som siktar på adressen i stället för på vägen framför den kan
 * hamna på fel sida om en älv. Rutten slutar där den slutar. Det gäller alla tre lägena,
 * och därför behöver funktionen inte veta vilket läge den är i.
 */
function navPlanAv(rutt: Route, through: readonly Waypoint[]): NavPlan | null {
  const followed = prepare(rutt);
  const slut = followed.shape[followed.shape.length - 1];
  if (!slut) return null;

  return { followed, through, destination: { at: slut, kind: 'break' } };
}

export const useApp = create<AppState & Actions>((set, get) => ({
  // Avgörs synkront, redan här: `boot()` är asynkron, och hade vyn valts först när den
  // var klar hade en förstagångsanvändare sett hemskärmen blinka förbi före introt.
  vy: introSedd() ? 'hem' : 'intro',
  status: 'idle',
  fix: null,
  tripKm: 0,
  tripNovelKm: 0,
  netKm: 0,
  gapCount: 0,
  nav: null,
  valdSevärdhet: null,
  error: null,

  async boot(): Promise<void> {
    if (bootad) return;
    bootad = true;

    const minne = await idbMemory();

    /*
     * Hela nyhetsminnet i RAM innan en enda meter körs.
     *
     * ⚠️ Det här är korrekthet, inte optimering. Recordern läser varje cells nyhet i det
     * ögonblick den ser cellen FÖRSTA gången, medan `VisitedMemory` läser in en shard
     * först när den ska SKRIVA till den — alltså vid första svepet, tio sekunder in.
     * Utan förladdning är indexet tomt när turens första celler bokförs, och en väg du
     * kört femtio gånger rapporteras som ny. Ett veteranminne (5 000 km) är 2,1 MB.
     * Det får plats.
     */
    await minne.nät.loadAll();

    geo = createGeoProvider((m) => set({ error: m }));
    const recorder = createRecorder(geo, minne);
    motor = { minne, recorder };

    // Varje fix: kartan, direkt. Ingen render, ingen store.
    recorder.on('fix', (f) => {
      senasteFix = f;
      const at: LngLat = [f.lon, f.lat];
      karta?.setFix(at, f.headingDeg ?? undefined, f.accuracyM);
      karta?.addTracePoint(at);
    });

    // Var 2:a sekund: siffrorna. Recordern strypar själv — vi strypar inte en gång till.
    recorder.on('progress', (p) => {
      set({
        fix: senasteFix,
        tripKm: p.tripKm,
        tripNovelKm: p.tripNovelKm,
        gapCount: p.gapCount,
      });
    });

    recorder.on('error', (m) => set({ error: m }));

    const [stats, spår] = await Promise.all([
      memoryStats(minne.store),
      minne.store.allTraces(),
    ]);

    trådar = spår.map(tillTråd);
    målaOm();

    set({ netKm: stats.netKm });

    stoppaSync = startSync(minne.store);
    globalThis.addEventListener('pagehide', () => stoppaSync?.());
  },

  registreraKarta(handtag: MapHandle | null): void {
    karta = handtag;
    // Kartan kan monteras före ELLER efter boot(). Den som kommer sist målar.
    målaOm();
  },

  visaSevärdhet(s): void {
    karta?.markeraSevärdhet(s.at);
    set({ valdSevärdhet: s });
  },

  stängSevärdhet(): void {
    karta?.markeraSevärdhet(null);
    set({ valdSevärdhet: null });
  },

  godkännIntro(): void {
    localStorage.setItem(INTRO_NYCKEL, '1');
    set({ vy: 'hem' });
  },

  async start(): Promise<void> {
    await starta(set, get, 'free');
  },

  öppnaPlan(): void {
    set({ error: null, vy: 'planera' });
  },

  stängPlan(): void {
    // Rutten man valde bort ska inte ligga kvar och lysa på hemskärmen.
    if (motor) karta?.setRoute(null, motor.minne.visited, todayDay());
    set({ vy: 'hem' });
  },

  async körPlanerad(rutt, through, läge, mål): Promise<void> {
    const plan = navPlanAv(rutt, through);
    if (!plan) {
      set({ error: 'Rutten saknar väg att följa.' });
      return;
    }

    // Simulatorn kör den rutt vi just valde, inte sitt eget spår. Tyst no-op i skarpt läge.
    // Måste ske FÖRE `starta()`, som startar mottagaren.
    if (geo) simulateRoute(geo, rutt.geometry);

    if (motor) karta?.setRoute(rutt, motor.minne.visited, todayDay());
    set({ nav: { plan, route: rutt, mål } });

    // Värm textcachen för sevärdheterna längs rutten, i bakgrunden. Nu, medan telefonen
    // troligen har nät — så en berättelse finns på ett tryck sen, ute i täckningsskuggan.
    // Fire-and-forget: får aldrig fördröja starten.
    förhandshämta(rutt.geometry);

    // ⚠️ Ingen `await` före `starta()`: gesten som tryckte på "Kör" är den enda
    //    transienta aktivering iOS ger oss (se `starta`).
    await starta(set, get, läge, 'navigera');
  },

  async omrutt(req): Promise<void> {
    try {
      const svar = await omrutta({ from: req.from, through: req.through, to: req.to });

      const plan = navPlanAv(svar.route, svar.through);
      if (!plan) return;

      // Målet ändras aldrig av en omruttning — bara vägen dit.
      set({ nav: { plan, route: svar.route, mål: get().nav?.mål ?? null } });
    } catch (e) {
      // En omruttning som inte gick igenom är ingen kris. Den gamla rutten ligger kvar på
      // skärmen, föraren kör vidare på den väg hen valde, och nästa avvikelse frågar igen.
      // Ingen pling, ingen dialog, ingen "beräknar om".
      set({ error: felText(e, 'Vi kunde inte räkna om rutten just nu.') });
    }
  },

  async avslutaNav(): Promise<void> {
    // Framme eller avbruten — turen ska landa i nätet på exakt samma sätt. En navigerad
    // tur som inte bokförs är den enda tur appen inte får glömma.
    await get().stopp();
  },

  async stopp(): Promise<void> {
    const m = motor;
    if (!m || get().status !== 'recording') return;

    // Recordern skickar en sista `progress` innan den svarar — turens sluttal är alltså
    // redan i storen när vi kommer hit.
    const tur = await m.recorder.stop();
    releaseAwake();
    set({ status: 'idle' });

    if (!tur) {
      set({ vy: 'hem' });
      return;
    }

    // Turen blir en tråd i nätet. Det är den intoningen efterkörningsskärmen väntar in —
    // animationen är belöningen, inte siffran.
    trådar = [...trådar, tillTråd(tur)];
    målaOm();

    const form = decode6(tur.polyline6);
    if (form.length > 1) karta?.fitBounds(form);

    const stats = await memoryStats(m.minne.store);
    set({ netKm: stats.netKm, vy: 'efter' });

    // Töm kön nu, inte vid nästa poll. Ett spår som ligger kvar i outboxen är ett spår
    // som försvinner med telefonen.
    void syncOutbox(m.minne.store);
  },

  klar(): void {
    // Turens egen tråd slocknar — den lever vidare som en tråd i nätet. Rutten är körd
    // och slocknar med den.
    karta?.resetTrace();
    if (motor) karta?.setRoute(null, motor.minne.visited, todayDay());
    set({ nav: null, vy: 'hem' });
  },

  async dela(): Promise<void> {
    const handtag = karta;
    if (!handtag) return;

    try {
      const bild = await handtag.shareImage();
      const fil = new File([bild], 'mitt-nät.png', { type: 'image/png' });

      if (navigator.canShare?.({ files: [fil] })) {
        await navigator.share({ files: [fil] });
        return;
      }

      // Ingen delningsdialog (desktop): ladda ner i stället.
      const url = URL.createObjectURL(bild);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mitt-nät.png';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      // Användaren som ångrar sig i delningsdialogen har inte råkat ut för ett fel.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      set({ error: felText(e, 'Bilden gick inte att skapa.') });
    }
  },
}));

// ─── Planeringens fönster in i motorn ───────────────────────────────────────
//
// Planeraren behöver två saker skalet äger: kartan (för att rita den valda rutten i två
// färger) och minnet (för att skicka cellerna i sökrymden med i anropet). Båda lever
// utanför React och har ingenting i storen att göra — en karta som är state ritas om,
// och ett minne som är state kopieras.

/** Kartan, eller null innan den monterat. */
export const kartan = (): MapHandle | null => karta;

/** Simfarten just nu, som multipel av realtid. Före `geo` finns: startfarten ur URL:en. */
export const simFartNu = (): number => (geo ? simFart(geo) : simStartFart());

/** Sätt simfarten (multipel av realtid). Reglaget i simläget ropar hit. */
export const sättSimFartNu = (fart: number): void => { if (geo) sättSimFart(geo, fart); };

/** Minnet, eller null före `boot()`. */
export const minnet = (): IdbMemory | null => motor?.minne ?? null;

/** Recordern, eller null före `boot()`. Navigeringen lyssnar på dess fixar. */
export const recordern = (): Recorder | null => motor?.recorder ?? null;

/**
 * EN position, inte en ström.
 *
 * "Vart?" behöver veta var man står — men GPS:en är inte igång på hemskärmen, och den ska
 * inte vara det: en telefon som lyssnar på satelliterna medan den ligger i en ficka är en
 * telefon som är död när man behöver den. Vi tänder alltså mottagaren när arket öppnas och
 * släcker den i samma ögonblick vi fått ett svar.
 *
 * ⚠️ Både `BrowserGeoProvider` och `SimGeoProvider` ignorerar ett `start()` när de redan
 *    är igång. Pejlingen MÅSTE därför vara släckt innan recordern tar över GPS:en, annars
 *    startar turen med en mottagare som levererar till fel lyssnare — och spåret blir tomt
 *    utan att något syns gå fel. `starta()` släcker den, först av allt.
 */
export function siktaPosition(): void {
  const g = geo;
  if (!g || siktar || useApp.getState().status === 'recording') return;

  siktar = true;
  g.start((f) => {
    senasteFix = f;
    useApp.setState({ fix: f });
    slutaSikta();
  });
}

export function slutaSikta(): void {
  if (!siktar) return;
  siktar = false;
  geo?.stop();
}

// ─── Starten ────────────────────────────────────────────────────────────────

type Sätt = (delvis: Partial<AppState>) => void;
type Hämta = () => AppState & Actions;

/**
 * Vägen in i en tur. Samma väg vare sig man tryckte "Kör" på hemskärmen eller valde en
 * rutt först — `läge` är råspårets etikett (CONTRACT §3.5) och `mål` är vyn man hamnar i:
 * `kör` är fri körning, `navigera` är en rutt att följa.
 *
 * ⚠️ `requestSenses()` anropas SYNKRONT, som första sak.
 *
 * iOS ger "transient activation" bara under den synkrona delen av en tap-handler, och den
 * första `await` konsumerar den. Allt som kräver en gest — ljudupplåsning, kompass,
 * skärmlås — startas inuti `requestSenses()` före dess egen första await, men bara om VI
 * hinner anropa den innan vi själva väntar på något. Ett `await` ovanför den raden gör
 * appen tyst på iPhone, och bara på iPhone. Det gäller även anroparen: `körPlanerad` får
 * inte hämta något innan den kommer hit.
 *
 * Simulatorn ber om ingenting: en platsdialog i ett läge som inte läser platsen lär bara
 * användaren att klicka bort dialoger.
 */
async function starta(
  set: Sätt, get: Hämta, läge: RecordMode, mål: Vy = 'kör',
): Promise<void> {
  const m = motor;
  if (!m || get().status !== 'idle') return;

  const sinnen = isSimulated() ? null : requestSenses();

  set({ error: null, tripKm: 0, tripNovelKm: 0, gapCount: 0, fix: null });

  if (sinnen) {
    const rapport = await sinnen;
    if (rapport.geolocation !== 'beviljad') {
      set({
        error: rapport.problems[0]
          ?? 'Appen behöver din position för att minnas var du kört.',
      });
      return;
    }
    // Nekat ljud eller skärmlås stoppar ingen tur. Men det ska sägas, en gång.
    const kvarstår = rapport.problems[0];
    if (kvarstår !== undefined) set({ error: kvarstår });
  }

  // Först av allt: släck pejlingen. Recordern ska äga GPS:en ensam från och med nu.
  slutaSikta();

  karta?.resetTrace();
  m.recorder.start(läge);
  set({ status: 'recording', vy: mål });
}

/** Rita nätet (och, bakom `?debug=1`, hexagonerna). Tål att kartan inte finns än. */
function målaOm(): void {
  if (!karta) return;
  const idag = todayDay();
  karta.setThreads(trådar, idag);
  if (motor) karta.setDebugMemory(motor.minne.visited, idag);
}
