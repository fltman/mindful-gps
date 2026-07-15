/**
 * Kartan.
 *
 * MapLibre-instansen bor i en ref och rörs BARA imperativt. Ingen GPS-fix, ingen
 * ruttändring och ingen tråd passerar genom React-state — den här komponenten renderar
 * i praktiken en gång, och sedan aldrig mer under en biltur. Ett komponentträd som
 * ritas om en gång i sekunden i två timmar tömmer batteriet, och en GPS utan batteri är
 * en tegelsten.
 *
 * Allt som ska hända med kartan går genom `MapHandle`. Är det inte ett anrop där, går
 * det inte att göra.
 */

import type { LngLat, Route, Sight, VisitedIndex } from '@mindful/core';
import maplibregl from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import 'maplibre-gl/dist/maplibre-gl.css';

import { OpenFreeMapSource, type TileSource } from './TileSource.js';
import { debugPåslagen, monteraHex, sättHex } from './hex.debug.js';
import { monteraRutt, sättRutt } from './layers.route.js';
import {
  SEV_MINZOOM, kopplaSevärdhetsTryck, monteraSevärdheter, monteraVald,
  sättSevärdheter, sättVald, type SevärdhetsTryck,
} from './layers.sights.js';
import { monteraNät, sättTrådar, type WebThread } from './layers.web.js';
import { rutnyckel, sevärdheterFör } from './sevardheter.js';
import { LiveSpår } from './live.js';
import { delaBild, type DelaInställningar } from './share.js';
import { BOTTEN, buildStyle, type Tema } from './style.js';

/** Sverige, ungefär. Bara tills första fixen kommer. */
const START: LngLat = [15.2, 59.0];
const START_ZOOM = 4.6;

/** Zoomen man kör på. Nära nog att se nästa avtagsväg, långt nog att se att den finns. */
const KÖR_ZOOM = 14.5;

/**
 * Längsta kamerasvep. Nås bara när fixarna kommer glest — i verklig körning är de en per
 * sekund, och då är 900 ms precis lagom: rörelsen hinner bli klar innan nästa fix.
 */
const MAX_SVEP_MS = 900;

/**
 * Bilen sitter en bit NEDANFÖR mitten, så att skärmen visar vägen framför i stället för
 * vägen bakom. Andel av kartans höjd, räknat från mitten och nedåt.
 */
const FRAMFÖRHÅLL = 0.22;

/** Modulkonstant, inte defaultvärde i signaturen: ett nytt objekt per render hade
 *  rivit och byggt om hela kartan varje gång komponenten renderades. */
const STANDARDKÄLLA: TileSource = new OpenFreeMapSource();

export interface MapHandle {
  /** Ny position. Roterar kartan bara om bäringen är trovärdig — annars ljuger norr. */
  setFix(at: LngLat, headingDeg?: number, accuracyM?: number): void;
  /** Ett steg till på den aktuella turens tråd. */
  addTracePoint(p: LngLat): void;
  /** Ny tur: tråden börjar om. */
  resetTrace(): void;
  fitBounds(pts: readonly LngLat[], marginal?: number): void;
  setRoute(route: Route | null, mem: VisitedIndex, today: number): void;
  /** Hela spindelnätet. Byts sällan — vid start, och när en tur avslutas. */
  setThreads(threads: readonly WebThread[], today: number): void;
  /** Hexagonvyn. Ignoreras om `?debug=1` inte är satt. */
  setDebugMemory(mem: VisitedIndex, today: number): void;
  /** Ring runt den tryckta sevärdheten, eller `null` för att sudda den. */
  markeraSevärdhet(at: LngLat | null): void;
  /** Följer kartan bilen, eller har användaren pannat iväg själv? */
  setFollow(följer: boolean): void;
  /** PNG av trådarna, utan karta. Tillväxtmotorn. */
  shareImage(inst?: DelaInställningar): Promise<Blob>;
}

export interface MapViewProps {
  readonly tema?: Tema;
  readonly source?: TileSource;
  /** Föraren tryckte på en sevärdhet. Appen talar aldrig oombedd — det här ÄR frågan. */
  readonly onSevärdhet?: (s: SevärdhetsTryck) => void;
}

export const MapView = forwardRef<MapHandle, MapViewProps>(function MapView(
  { tema = 'ljust', source = STANDARDKÄLLA, onSevärdhet },
  ref,
) {
  const behållare = useRef<HTMLDivElement>(null);
  const kartan = useRef<maplibregl.Map | null>(null);
  const spår = useRef<LiveSpår | null>(null);

  /**
   * Dagen trådarna senast ritades mot. Recency-ljuset beror på "idag", och "idag" känner
   * bara anroparen till — bench och tester kör mot syntetiska datum. Vi minns det som
   * skickades in i stället för att gissa på `Date.now()` bakom ryggen på dem.
   */
  const dag = useRef(0);

  // Senast kända data. Kartan kan tappa alla lager när stilen byts (tema, fallback), och
  // måste då kunna måla om sig själv utan att fråga någon.
  const trådar = useRef<readonly WebThread[]>([]);
  const rutt = useRef<{ route: Route | null; mem: VisitedIndex; today: number } | null>(null);
  const minne = useRef<{ mem: VisitedIndex; today: number } | null>(null);
  const följer = useRef(true);

  /** När förra fixen kom. Ger kamerasvepet dess längd — se `setFix`. */
  const föregåendeFix = useRef<number | null>(null);

  /** Sevärdheterna i det utsnitt vi senast hämtade. Överlever ett stilbyte. */
  const sevärdheter = useRef<readonly Sight[]>([]);

  /** Den markerade sevärdheten (ringen). Överlever ett stilbyte — se `montera`. */
  const valdPunkt = useRef<readonly [number, number] | null>(null);

  /**
   * Trycket-på-sevärdhet-callbacken i en ref, inte i effektens beroenden.
   *
   * Låg den i deps hade hela kartan byggts om varje gång föräldern renderade om med en ny
   * pilfunktion — och kartan ska byggas EN gång. Handlern binds en gång och läser alltid
   * den färska callbacken härifrån.
   */
  const påSevärdhet = useRef(onSevärdhet);
  påSevärdhet.current = onSevärdhet;

  useEffect(() => {
    const värd = behållare.current;
    if (!värd) return;

    const map = new maplibregl.Map({
      container: värd,
      style: buildStyle(source, tema),
      center: [START[0], START[1]],
      zoom: START_ZOOM,
      attributionControl: { compact: true },
      // En karta man kan snurra på i en bil är en karta man snurrar på av misstag.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: true,
    });

    kartan.current = map;
    spår.current = new LiveSpår(map);

    // Trycket binds EN gång och läser callbacken ur en ref, så den överlever ett temabyte
    // (som river och bygger om lagren) utan att bindas om.
    kopplaSevärdhetsTryck(map, (s) => påSevärdhet.current?.(s));

    // Panorerar användaren själv slutar vi följa. Att rycka tillbaka kartan under
    // fingret är den mest respektlösa saken en navigator kan göra.
    const släpp = (): void => { följer.current = false; };
    map.on('dragstart', släpp);

    // Stilen kan bytas (tema) och kan bytas UNDER OSS (fallback vid fel). Lagren
    // monteras därför varje gång en stil laddat, inte en gång vid start.
    const montera = (): void => {
      monteraNät(map);
      // Sevärdheterna UNDER nätet och rutten: de är bakgrund, inte budskap. Ligger en
      // prick ovanpå den okända vägen har den tagit den plats vägen skulle haft.
      monteraSevärdheter(map, tema);
      monteraVald(map);
      monteraRutt(map, tema);
      spår.current?.montera();
      if (debugPåslagen()) monteraHex(map);

      sättTrådar(map, trådar.current, dag.current);
      sättSevärdheter(map, sevärdheter.current);
      sättVald(map, valdPunkt.current);
      const r = rutt.current;
      if (r) sättRutt(map, r.route, r.mem, r.today);
      const m = minne.current;
      if (m && debugPåslagen()) sättHex(map, m.mem, m.today);
    };
    map.on('style.load', montera);

    // ── Sevärdheterna följer utsnittet ──────────────────────────────────────
    //
    // `moveend`, inte `move`: under en navigering flyttar sig kartan varje sekund, och en
    // fråga per fix hade varit sextio i minuten för data som inte ändrar sig. `moveend`
    // fyras av när kameran landat — och kamerans easeTo landar mellan fixarna.
    //
    // ⛔ VI AVBRYTER ALDRIG EN PÅGÅENDE HÄMTNING på ett nytt `moveend`.
    //
    //    Det var precis vad den här koden gjorde först, och den hämtade då aldrig något
    //    alls under en körning: `moveend` kommer efter varje kamerasvep, svepet kommer
    //    efter varje fix, och en fix som avbryter förra sekundens fetch innan svaret hunnit
    //    fram betyder att svaret aldrig hinner fram. På ett dåligt mobilnät hade lagret
    //    varit permanent tomt — och det hade sett ut som att det inte fanns några
    //    sevärdheter, inte som en bugg.
    //
    //    Ett avbrott hade tjänat oss om svaren var dyra eller kunde komma i fel ordning.
    //    De är varken eller: de cachas per ruta, och det sista svaret vinner ändå. Vi låter
    //    dem landa. Avbrottet finns kvar för AVMONTERING, som är det enda tillfälle då
    //    svaret verkligen är ointressant.
    const avmontering = new AbortController();

    /** Rutorna vi senast ritade. Är de samma finns ingen anledning att fråga igen. */
    let senaste = '';

    const uppdateraSevärdheter = (): void => {
      if (map.getZoom() < SEV_MINZOOM) {
        if (sevärdheter.current.length > 0) {
          senaste = '';
          sevärdheter.current = [];
          sättSevärdheter(map, []);
        }
        return;
      }

      const b = map.getBounds();
      const bbox: [number, number, number, number] = [
        b.getWest(), b.getSouth(), b.getEast(), b.getNorth(),
      ];

      // Rutnätets steg är ~28 km. Sextio kamerasvep i minuten landar nästan alltid i
      // samma rutor, och då sker inget anrop och ingen omritning.
      const nycklar = rutnyckel(bbox);
      if (nycklar === senaste) return;
      senaste = nycklar;

      void sevärdheterFör(bbox, avmontering.signal)
        .then((s) => {
          if (avmontering.signal.aborted) return;
          sevärdheter.current = s;
          sättSevärdheter(map, s);
        })
        .catch(() => {
          // Ett nätfel mitt i en kurva är inget att störa föraren med. Nästa ruta försöker
          // igen — men den här rutan ska få det, så vi glömmer att vi frågat.
          senaste = '';
        });
    };

    map.on('moveend', uppdateraSevärdheter);

    // Går vår egen stil inte att läsa (nätet, en typo, en trasig deploy) är en karta som
    // ser fel ut fortfarande bättre än ingen karta alls vid en vägkorsning.
    let fallbackAnvänd = false;
    const påFel = (e: maplibregl.ErrorEvent): void => {
      if (fallbackAnvänd || map.isStyleLoaded()) return;
      fallbackAnvänd = true;
      console.warn('Mindful-stilen gick inte att läsa:', e.error);
      map.setStyle(source.styleUrl());
    };
    map.on('error', påFel);

    return () => {
      avmontering.abort();
      map.remove();
      kartan.current = null;
      spår.current = null;
    };
  }, [tema, source]);

  useImperativeHandle(ref, (): MapHandle => ({
    setFix(at, headingDeg, accuracyM) {
      spår.current?.sättPosition(at, accuracyM);

      const map = kartan.current;
      if (!map || !följer.current) return;

      // Svepet ska vara klart när NÄSTA fix kommer, inte om 900 ms oavsett vad. Ett fast
      // svep antar en fix i sekunden, och det antagandet håller inte: simulatorn kör i
      // 40× takt (en fix var 25:e ms) och varje nytt svep avbryter det förra innan det
      // hunnit någonstans. Kameran halkar då efter för alltid, och eftersom bäringen
      // pekar uppåt försvinner bilen ut genom överkanten. Vi mäter takten i stället.
      const nu = performance.now();
      const sedanFörra = föregåendeFix.current === null ? MAX_SVEP_MS : nu - föregåendeFix.current;
      föregåendeFix.current = nu;

      map.easeTo({
        center: [at[0], at[1]],
        zoom: Math.max(map.getZoom(), KÖR_ZOOM),
        bearing: headingDeg ?? map.getBearing(),
        // Bilen hamnar nedanför mitten: skärmen ska visa vägen framför, inte bakom.
        padding: { top: map.getContainer().clientHeight * FRAMFÖRHÅLL * 2, bottom: 0, left: 0, right: 0 },
        duration: Math.min(sedanFörra, MAX_SVEP_MS),
        essential: true,        // överlev prefers-reduced-motion; det här är inte pynt
      });
    },

    addTracePoint(p) {
      spår.current?.läggTill(p);
    },

    resetTrace() {
      spår.current?.nollställ();
      följer.current = true;
      föregåendeFix.current = null;
    },

    markeraSevärdhet(at) {
      valdPunkt.current = at ? [at[0], at[1]] : null;
      const map = kartan.current;
      if (map?.isStyleLoaded()) sättVald(map, valdPunkt.current);
    },

    fitBounds(pts, marginal = 48) {
      const map = kartan.current;
      const första = pts[0];
      if (!map || !första) return;

      const bounds = new maplibregl.LngLatBounds(
        [första[0], första[1]], [första[0], första[1]],
      );
      for (const p of pts) bounds.extend([p[0], p[1]]);

      följer.current = false;   // en översikt är ett val: sluta jaga bilen
      map.fitBounds(bounds, { padding: marginal, duration: 700 });
    },

    setRoute(route, mem, today) {
      rutt.current = { route, mem, today };
      const map = kartan.current;
      if (map?.isStyleLoaded()) sättRutt(map, route, mem, today);
    },

    setThreads(threads, today) {
      trådar.current = threads;
      dag.current = today;
      const map = kartan.current;
      if (map?.isStyleLoaded()) sättTrådar(map, threads, today);
    },

    setDebugMemory(mem, today) {
      minne.current = { mem, today };
      const map = kartan.current;
      if (map?.isStyleLoaded() && debugPåslagen()) sättHex(map, mem, today);
    },

    setFollow(v) {
      följer.current = v;
    },

    shareImage(inst) {
      return delaBild(trådar.current, dag.current, inst);
    },
  }), []);

  return (
    <div
      ref={behållare}
      style={{ position: 'absolute', inset: 0, background: BOTTEN[tema] }}
    />
  );
});
