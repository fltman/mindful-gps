/**
 * Navigeringsvyn.
 *
 * Nästan tom. Kartan, rutten, din prick — och överst en pil och ett avstånd. Det är allt
 * en förare behöver veta i det ögonblicket, och varje ytterligare siffra på den skärmen
 * hade varit en siffra att jämföra sig med.
 *
 * ⛔ Ingen ETA-nedräkning. Ingen hastighet. Ingen fartgräns. Ingenting rött.
 *    "1 h 17 min" finns i `Follower.remainingS` och används av ingen — den räknas fram för
 *    att någon vy en dag kan vilja den, inte för att den ska stå här och ticka.
 *
 * ⛔ Ingen omberäkningsstress. Kör föraren en annan väg har hen inte kört fel — hen har
 *    hittat en väg till. Skärmen varnar inte, rösten ber aldrig om en u-sväng, och är den
 *    nya vägen okänd säger vi det enda som är värt att säga: "Fint val."
 *
 * ⚡ Loopen ligger UTANFÖR React. Fixarna kommer en gång i sekunden i två timmar; kartan
 *    matas imperativt av skalet (`app/state.ts`), och den här komponenten renderar bara om
 *    när något SYNLIGT ändrats — ny manöver, ett nytt avrundat avstånd, en ny kilometer
 *    kvar. Att rita om ett komponentträd 7 200 gånger är inte en prestandafråga utan en
 *    batterifråga, och en GPS utan batteri är en tegelsten.
 *
 * All matte kommer ur @mindful/core, all navigeringslogik ur `follower`, `schedule`,
 * `voice` och `offroute`. Här finns bara skärmen och tråden som binder ihop dem.
 */

import {
  SAMPLE_M, cellNovelty, sampleCells, todayDay,
  type Maneuver, type ManeuverModifier, type Route, type VisitedIndex,
} from '@mindful/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { MapHandle } from '../map/index.js';
import { fixAt, type Fix, type Recorder } from '../sense/index.js';
import { HoldButton, formatKm } from '../ui/index.js';

import { Follower, type FollowedRoute } from './follower.js';
import { ankomstMening } from './klockan.sv.js';
import { OFF_ROUTE_M, OffRouteWatch, type NavPlan, type RerouteRequest } from './offroute.js';
import { isSilent } from './phrases.sv.js';
import { CueQueue, scheduleRoute } from './schedule.js';
import { SpeechVoice, Voice, type VoiceEngine } from './voice.js';

// ─── Trösklar ───────────────────────────────────────────────────────────────

/** Så nära målet är vi framme. GPS:en är ändå inte bättre än så på en parkering. */
const FRAMME_M = 50;

/** Hur länge en varm rad om ny väg står kvar. Sedan får kartan skärmen tillbaka. */
const HÄLSNING_MS = 9000;

// ─── Porten mot minnet ──────────────────────────────────────────────────────

/**
 * Bara `visited`-gettern behövs — men den måste vara en GETTER.
 *
 * `VisitedMemory` byter ut hela sitt `VisitedIndex` när nya shards läses in. En sparad
 * referens hade tyst blivit ett gammalt minne, och då hade appen kallat väg du faktiskt
 * kört för ny. `IdbMemory` uppfyller det här interfacet som det är.
 */
export interface Nyhetsminne {
  readonly visited: VisitedIndex;
}

export interface NavScreenProps {
  /** Rutten att följa, med de okända segment planeraren tvingade den genom. */
  readonly plan: NavPlan;
  /** Samma rutt, obearbetad. Kartan ritar ur den. */
  readonly route: Route;
  /** "Kalmar". `null` i en slinga eller ett utsvep — då är målet hemmet man startade i. */
  readonly mål?: string | null;
  readonly minne: Nyhetsminne;
  /**
   * Spelar in turen medan vi navigerar — läge `nav_ab`. En navigerad tur ska landa i
   * nätet precis som en fri körning; kör man 60 mil efter appens egen rutt och den inte
   * minns ett meter av det är minnet en lögn.
   *
   * Skalet äger `start`/`stop` (det är där gesten, tillstånden och spårets väg till
   * lagringen finns). Vi startar bara om ingen redan gjort det.
   */
  readonly recorder: Recorder;
  readonly karta: MapHandle | null;
  /** Injicerbar för test. Annars webbläsarens talsyntes. */
  readonly voice?: VoiceEngine;
  /** Föraren valde en annan väg. Skalet planerar om och matar tillbaka en ny `plan`. */
  readonly onOmrutt: (req: RerouteRequest) => void;
  /** `true` = vi kom fram. `false` = föraren avslutade själv. */
  readonly onAvsluta: (framme: boolean) => void;
}

// ─── Det synliga ────────────────────────────────────────────────────────────

interface Hud {
  /** Index i `Route.maneuvers`. -1 = ingen manöver att visa (avvikelse, eller tyst svans). */
  readonly manöver: number;
  readonly tillManöverM: number;
  readonly kvarM: number;
  readonly nyaKvarM: number;
  readonly avviker: boolean;
  /**
   * Ankomsten, som ett kvartsnummer sedan epoken — inte som ms.
   *
   * Talet ÄR upplösningen: kvarten är allt vi någonsin visar, så två fixar som landar i
   * samma kvart är samma HUD, och skärmen renderar inte om. Sparade vi ms här hade
   * `samma()` fått avrunda igen, och då hade avrundningen bott på två ställen.
   */
  readonly ankomstKvart: number;
}

const TOM: Hud = {
  manöver: -1, tillManöverM: 0, kvarM: 0, nyaKvarM: 0, avviker: false, ankomstKvart: 0,
};

const KVART_MS = 15 * 60 * 1000;

/**
 * Har något som SYNS ändrats?
 *
 * Avstånden jämförs på skärmens upplösning, inte på GPS:ens: `formatKm` avrundar till
 * tiotal meter och kilometerraden till hundratal. En bil som står stilla i en kö ska inte
 * rendera om skärmen för att fixen darrar tre meter.
 */
function samma(a: Hud, b: Hud): boolean {
  return a.manöver === b.manöver
    && a.avviker === b.avviker
    && Math.round(a.tillManöverM / 10) === Math.round(b.tillManöverM / 10)
    && Math.round(a.kvarM / 100) === Math.round(b.kvarM / 100)
    && Math.round(a.nyaKvarM / 100) === Math.round(b.nyaKvarM / 100)
    && a.ankomstKvart === b.ankomstKvart;
}

/**
 * Nästa manöver som är värd en pil.
 *
 * `Follower` pekar på nästa manöver i motorns lista — och den listan innehåller
 * `continue` och `roundabout_exit`, som är TYSTA (phrases.sv.ts). En pil rakt fram med
 * "12 km" under sig är precis den sortens instruktion produkten finns för att slippa.
 * Vi hoppar över dem på skärmen av exakt samma skäl som rösten gör det.
 *
 * `arrive` är aldrig tyst, så det finns alltid en manöver kvar att hitta.
 */
function nästaTalbara(maneuvers: readonly Maneuver[], från: number): number {
  for (let i = Math.max(0, från); i < maneuvers.length; i++) {
    const m = maneuvers[i];
    if (m && !isSilent(m)) return i;
  }
  return -1;
}

/**
 * Nyheten kvar, meter för meter längs rutten.
 *
 * Talet under kartan ("31 av dem har du aldrig kört") måste kunna läsas om varje sekund,
 * och att sampla om hela ruttens 4 000 celler per fix vore rent slöseri. Vi räknar
 * prefixsumman EN gång, vid ruttens början, och slår upp i den sedan.
 *
 * Summan är per konstruktion identisk med `novelKm()`: samma sampling (SAMPLE_M), samma
 * `cellNovelty`, samma medelvärde × sträcka. Två tal hade blivit två sanningar.
 *
 * Minnet läses vid AVFÄRD, inte per fix. Cellerna vi kör igenom nu blir kända i samma
 * stund — läste vi om nyheten längre fram skulle vägen framför oss krympa medan vi kör
 * mot den, och appen skulle se ut att ta tillbaka sitt löfte.
 */
function nyhetsprofil(
  followed: FollowedRoute,
  distanceM: number,
  mem: VisitedIndex,
  today: number,
): Float64Array {
  const cells = sampleCells(followed.shape);
  const n = cells.length;

  // prefix[i] = nya meter fram till sampel i. prefix[n] = hela ruttens nya meter.
  const prefix = new Float64Array(n + 1);
  if (n === 0) return prefix;

  const meterPerSampel = distanceM / n;
  let prev: bigint | undefined;
  let nov = 0;

  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (c !== undefined && c !== prev) {
      nov = cellNovelty(c, mem, today);
      prev = c;
    }
    prefix[i + 1] = (prefix[i] ?? 0) + nov * meterPerSampel;
  }

  return prefix;
}

/** Nya meter kvar från `alongM` till målet. Samplingen ligger var SAMPLE_M meter. */
function nyaKvar(prefix: Float64Array, alongM: number): number {
  const n = prefix.length - 1;
  if (n <= 0) return 0;
  const i = Math.min(Math.max(Math.round(alongM / SAMPLE_M), 0), n);
  return Math.max(0, (prefix[n] ?? 0) - (prefix[i] ?? 0));
}

// ─── Skärmen ────────────────────────────────────────────────────────────────

export function NavScreen({
  plan, route, mål, minne, recorder, karta, voice, onOmrutt, onAvsluta,
}: NavScreenProps) {
  const [hud, setHud] = useState<Hud>(TOM);
  const [hälsning, setHälsning] = useState<string | null>(null);
  const [framme, setFramme] = useState<number | null>(null);

  // Skalets callbacks får bytas ut mellan renderingar utan att navigeringsloopen startas
  // om. En loop som river sin `Follower` för att en pilfunktion fick ny identitet hade
  // tappat både position och tystnad.
  const rutt = useRef({ onOmrutt, onAvsluta });
  rutt.current = { onOmrutt, onAvsluta };

  /** Turens nya kilometer, från recordern. Läses först när vi är framme. */
  const turNyaKm = useRef(0);

  const idag = useMemo(() => todayDay(), []);
  const prefix = useMemo(
    () => nyhetsprofil(plan.followed, route.distanceM, minne.visited, idag),
    [plan, route.distanceM, minne, idag],
  );

  // ── Kartan ────────────────────────────────────────────────────────────────
  //
  // Kameran sköter skalet: `app/state.ts` matar `karta.setFix()` per fix, och `MapView`
  // svarar med bäring uppåt, körzoom och en mjuk `easeTo` på 900 ms. Vi bygger ingen ny
  // karta och ingen egen kamera — vi säger bara vilken rutt som ska ligga där.
  useEffect(() => {
    karta?.setRoute(route, minne.visited, idag);
    karta?.setFollow(true);
    return () => karta?.setRoute(null, minne.visited, idag);
  }, [karta, route, minne, idag]);

  // ── Navigeringsloopen ─────────────────────────────────────────────────────
  useEffect(() => {
    const följare = new Follower(plan.followed);
    const vakt = new OffRouteWatch(plan);

    // Cuerna schemaläggs EN gång, mot ruttens medelfart. Den avgör bara om den långa cuen
    // kommer vid 400 eller 600 m (schedule.ts), och en rutt som byter fart mitt i är
    // fortfarande samma rutt. Att lägga om schemat varje gång bilen passerar 79 km/h hade
    // gett en app som ändrar sig om när den ska prata.
    const medelfart = plan.followed.timeS > 0
      ? plan.followed.distanceM / plan.followed.timeS
      : 0;
    const cues = new CueQueue(scheduleRoute(plan.followed.maneuvers, medelfart));

    const röst = new Voice(voice ?? new SpeechVoice());

    // Skyddsnät: har skalet redan startat inspelningen gör det här ingenting. Har det inte
    // det räddar raden turen — en navigerad tur som inte hamnar i nätet är den enda tur
    // appen inte får glömma.
    if (!recorder.recording) recorder.start('nav_ab');

    let hälsningsTimer: ReturnType<typeof setTimeout> | undefined;
    let anlänt = false;
    let senaste = TOM;

    const avFix = recorder.on('fix', (f: Fix) => {
      if (anlänt) return;

      const at = fixAt(f);
      const state = följare.update(at);

      // Rösten först, alltid. "Framme." ska hinna sägas i samma ögonblick skärmen ändå
      // hade bytt bild.
      for (const c of cues.due(state.maneuverIndex, state.toManeuverM)) röst.say(c.text);

      const req = vakt.update({
        at,
        t: f.t,
        headingDeg: f.headingDeg,
        state,
        mem: minne.visited,
        today: idag,
      });

      if (req) {
        // Ingen varning, ingen omberäkningspling. Är vägen känd säger vi ingenting alls —
        // `offRouteText` ger `null`, och tystnad är det normala.
        if (req.say !== null) {
          röst.say(req.say);
          setHälsning(req.say);
          clearTimeout(hälsningsTimer);
          hälsningsTimer = setTimeout(() => setHälsning(null), HÄLSNING_MS);
        }
        rutt.current.onOmrutt(req);
      }

      if (state.remainingM <= FRAMME_M) {
        anlänt = true;
        setFramme(turNyaKm.current);
        return;
      }

      const avviker = state.offRouteM > OFF_ROUTE_M;
      // Är vi av rutten pekar vi inte. En pil mot en sväng på en väg vi inte kör på är
      // appen som har rätt — och den har aldrig rätt.
      const manöver = avviker
        ? -1
        : nästaTalbara(plan.followed.maneuvers, state.maneuverIndex);

      const nästa: Hud = {
        manöver,
        tillManöverM: manöver < 0
          ? 0
          : Math.max(0, (plan.followed.maneuverAtM[manöver] ?? 0) - state.alongM),
        kvarM: state.remainingM,
        nyaKvarM: Math.min(state.remainingM, nyaKvar(prefix, state.alongM)),
        avviker,
        ankomstKvart: Math.round((Date.now() + state.remainingS * 1000) / KVART_MS),
      };

      if (!samma(senaste, nästa)) {
        senaste = nästa;
        setHud(nästa);
      }
    });

    const avProgress = recorder.on('progress', (p) => {
      turNyaKm.current = p.tripNovelKm;
    });

    return () => {
      avFix();
      avProgress();
      clearTimeout(hälsningsTimer);
      röst.stop();
    };
  }, [plan, minne, recorder, voice, prefix, idag]);

  if (framme !== null) {
    return <Framme nyaKm={framme} onKlar={() => rutt.current.onAvsluta(true)} />;
  }

  const m = hud.manöver >= 0 ? plan.followed.maneuvers[hud.manöver] : undefined;

  return (
    <div className="skarm">
      <div className="nav__topp">
        {m && (
          <div className="nav__manover">
            <Pil m={m} />
            <span className="nav__avstand">{formatKm(hud.tillManöverM)}</span>
          </div>
        )}
        {hälsning && <p className="nav__halsning">{hälsning}</p>}
      </div>

      <div className="fyll" />

      {hud.ankomstKvart > 0 && (
        <p className="nav__framme">
          {ankomstMening(new Date(hud.ankomstKvart * KVART_MS), mål ?? null)}
        </p>
      )}
      <p className="nav__kvar">{kvarText(hud.kvarM, hud.nyaKvarM)}</p>
      <HoldButton text="Håll in för att avsluta" onHold={() => rutt.current.onAvsluta(false)} />
    </div>
  );
}

/**
 * "48 km kvar. 31 av dem har du aldrig kört."
 *
 * Aldrig procent — kilometer. Och andra meningen står bara där när den har något att säga:
 * kör man hem sista biten på en väg man kört tusen gånger är "0 m av dem har du aldrig
 * kört" inte ödmjukt, det är bara larvigt.
 */
function kvarText(kvarM: number, nyaM: number): string {
  const kvar = `${formatKm(kvarM)} kvar.`;
  if (kvarM < 1000 || nyaM < 500) return kvar;
  return `${kvar} ${formatKm(nyaM)} av dem har du aldrig kört.`;
}

/** "Du är framme. 62 km av det var nytt." Turen är slut, och den var värd något. */
function Framme({ nyaKm, onKlar }: { readonly nyaKm: number; readonly onKlar: () => void }) {
  const nya = nyaKm * 1000;
  const text = nya >= 500
    ? `Du är framme. ${formatKm(nya)} av det var nytt.`
    : 'Du är framme.';

  return (
    <div className="skarm">
      <div className="fyll" />
      <div className="stapel">
        <p className="rubrik">{text}</p>
        <button type="button" className="knapp" onClick={onKlar}>Klar</button>
      </div>
    </div>
  );
}

// ─── Pilen ──────────────────────────────────────────────────────────────────

/**
 * Manöverns riktning i grader. 0 = rakt fram, negativt = vänster.
 *
 * Vinkeln räknas fram till EN pilbana (`pilBana`) i stället för att fjorton handritade
 * SVG-vägar ska underhållas i par. En pil som pekar 45° upp åt vänster är samma pil som
 * den som pekar 45° upp åt höger, speglad — och båda är samma matte.
 */
const VINKEL: Record<ManeuverModifier, number> = {
  sharp_left: -135,
  left: -90,
  slight_left: -45,
  straight: 0,
  slight_right: 45,
  right: 90,
  sharp_right: 135,
};

/** 0° = uppåt (−y). Medurs, som en kompass. */
function riktning(grader: number): readonly [number, number] {
  const r = (grader * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

const rund = (x: number): string => x.toFixed(1);

/**
 * Skaftet från bilen (nere i mitten), genom svängen, ut till spetsen — plus pilhuvudet.
 *
 * Kvadratisk kurva i böjen: en pil med ett skarpt hörn ser ut som ett felmeddelande.
 */
function pilBana(grader: number, längd = 36, huvud = 24): string {
  const [ux, uy] = riktning(grader);

  const bx = 50;
  const by = 50;
  const qx = bx + 14 * ux;
  const qy = by + 14 * uy;
  const tx = bx + längd * ux;
  const ty = by + längd * uy;

  const [ax, ay] = riktning(grader + 145);
  const [cx, cy] = riktning(grader - 145);

  const skaft = `M50 92 L50 64 Q${bx} ${by} ${rund(qx)} ${rund(qy)} L${rund(tx)} ${rund(ty)}`;
  const spets =
    `M${rund(tx + huvud * ax)} ${rund(ty + huvud * ay)} L${rund(tx)} ${rund(ty)} `
    + `L${rund(tx + huvud * cx)} ${rund(ty + huvud * cy)}`;

  return `${skaft} ${spets}`;
}

/**
 * Rondellen är den enda manöver en riktad pil skulle ljuga om: en pil som pekar höger
 * säger "sväng höger", inte "ta andra avfarten". Ringen ritas därför ut, och avfarten
 * lämnar den i sin egen riktning. Numret säger rösten — skärmen behöver inte upprepa det.
 */
function rondellBana(grader: number): string {
  const [ux, uy] = riktning(grader);
  const cx = 50;
  const cy = 44;
  const r = 17;

  const ex = cx + r * ux;
  const ey = cy + r * uy;
  const tx = cx + 36 * ux;
  const ty = cy + 36 * uy;

  const [ax, ay] = riktning(grader + 145);
  const [bx, by] = riktning(grader - 145);

  return `M50 92 L50 ${rund(cy + r)} `
    + `M${rund(ex)} ${rund(ey)} L${rund(tx)} ${rund(ty)} `
    + `M${rund(tx + 20 * ax)} ${rund(ty + 20 * ay)} L${rund(tx)} ${rund(ty)} `
    + `L${rund(tx + 20 * bx)} ${rund(ty + 20 * by)}`;
}

/** En stor pil. Ingen etikett, inget vägnummer, ingen ram. Rösten säger resten. */
function Pil({ m }: { readonly m: Maneuver }) {
  const grader = m.modifier ? VINKEL[m.modifier] : 0;

  const svg = (children: ReactNode) => (
    <svg
      className="nav__pil"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );

  if (m.type === 'arrive') {
    // Målet: en ring och en punkt. Ingen målflagga — det här är inte en tävling.
    return svg(
      <>
        <circle cx="50" cy="50" r="21" />
        <circle cx="50" cy="50" r="7" fill="currentColor" stroke="none" />
      </>,
    );
  }

  if (m.type === 'roundabout_enter') {
    return svg(
      <>
        <circle cx="50" cy="44" r="17" />
        <path d={rondellBana(grader)} />
      </>,
    );
  }

  return svg(<path d={pilBana(grader)} />);
}
