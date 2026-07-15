/**
 * Vy-växeln. Fyra vyer behöver inget routerbibliotek.
 *
 * ⚠️ Kartan monteras EN gång, utanför växeln, och ommonteras aldrig. Den ligger under
 * skärmarna och överlever varje vybyte — en karta som byggs om mellan hem och körning
 * tappar både tråden och positionen, och det syns.
 *
 * Skärmarna är genomsläppliga lager (`.skarm` har `pointer-events: none`); bara det man
 * faktiskt kan trycka på fångar fingret. Därför kan man panorera kartan mitt i en tur.
 *
 * `Skärmar` är en egen komponent, inte kroppen i `Router`. Det är hela poängen: siffrorna
 * ändras varannan sekund under en tur, och bara den komponent som LÄSER dem ska ritas om.
 * `Router` prenumererar inte på något som rör sig, så `MapView` renderas aldrig om.
 */

import { useEffect, useRef } from 'react';

import { MapView, type MapHandle, type Tema } from '../map/index.js';
import { NavScreen } from '../nav/index.js';
import { PlanFlow } from '../plan/index.js';
import {
  AfterDriveScreen, HomeScreen, Onboarding, RecordingScreen, SevardhetsBlad,
} from '../ui/index.js';

import { kartan, minnet, recordern, useApp } from './state.js';

/**
 * Temat läses en gång, inte reaktivt.
 *
 * `MapView` bygger om hela kartan när `tema` ändras (det är en ny MapLibre-instans).
 * Byter man mörkt läge mitt i en tur ska inte tråden man just kört försvinna — och en
 * bil kör sällan tillräckligt länge för att solen ska hinna gå ner två gånger.
 */
const TEMA: Tema = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'mörkt'
  : 'ljust';

export function Router() {
  const handtag = useRef<MapHandle>(null);
  const registreraKarta = useApp((s) => s.registreraKarta);
  const visaSevärdhet = useApp((s) => s.visaSevärdhet);

  useEffect(() => {
    registreraKarta(handtag.current);
    return () => registreraKarta(null);
  }, [registreraKarta]);

  return (
    <>
      <MapView ref={handtag} tema={TEMA} onSevärdhet={visaSevärdhet} />
      <Skärmar />
      <Blad />
      <Felrad />
    </>
  );
}

/**
 * Berättelsebladet, utanför vy-växeln.
 *
 * Det ligger inte i en `Vy` för att en sevärdhet kan tryckas i vilket läge som helst —
 * kartan är ju alltid under skärmarna. Egen komponent så att den ström av siffror som rör
 * sig under en tur aldrig ritar om bladet, och tvärtom.
 */
function Blad() {
  const valdSevärdhet = useApp((s) => s.valdSevärdhet);
  const stängSevärdhet = useApp((s) => s.stängSevärdhet);
  if (!valdSevärdhet) return null;

  return (
    <SevardhetsBlad
      key={valdSevärdhet.id}
      sevärdhet={valdSevärdhet}
      onStäng={stängSevärdhet}
    />
  );
}

function Skärmar() {
  const vy = useApp((s) => s.vy);
  const netKm = useApp((s) => s.netKm);
  const tripKm = useApp((s) => s.tripKm);
  const tripNovelKm = useApp((s) => s.tripNovelKm);
  const gapCount = useApp((s) => s.gapCount);
  const nav = useApp((s) => s.nav);

  const godkännIntro = useApp((s) => s.godkännIntro);
  const start = useApp((s) => s.start);
  const stopp = useApp((s) => s.stopp);
  const klar = useApp((s) => s.klar);
  const dela = useApp((s) => s.dela);
  const öppnaPlan = useApp((s) => s.öppnaPlan);
  const omrutt = useApp((s) => s.omrutt);
  const avslutaNav = useApp((s) => s.avslutaNav);

  switch (vy) {
    case 'intro':
      return <Onboarding onAccept={godkännIntro} />;

    case 'hem':
      return (
        <HomeScreen
          netKm={netKm}
          onStart={() => void start()}
          onPlan={öppnaPlan}
        />
      );

    case 'planera':
      return <PlanFlow />;

    case 'navigera': {
      // Minnet, recordern och kartan lever utanför React och hämtas därför här, inte ur
      // storen. Alla tre finns garanterat: man kommer bara hit genom en planering, och den
      // krävde både `boot()` och en monterad karta.
      const minne = minnet();
      const recorder = recordern();
      if (!nav || !minne || !recorder) return null;

      return (
        <NavScreen
          plan={nav.plan}
          route={nav.route}
          mål={nav.mål}
          minne={minne}
          recorder={recorder}
          karta={kartan()}
          onOmrutt={(req) => void omrutt(req)}
          onAvsluta={(framme) => void avslutaNav(framme)}
        />
      );
    }

    case 'kör':
      return (
        <RecordingScreen
          tripKm={tripKm}
          tripNovelKm={tripNovelKm}
          gapCount={gapCount}
          onStop={() => void stopp()}
        />
      );

    case 'efter':
      return (
        <AfterDriveScreen
          tripKm={tripKm}
          tripNovelKm={tripNovelKm}
          netKm={netKm}
          onShare={() => void dela()}
          onDone={klar}
        />
      );
  }
}

/** Fel sägs lågmält, en gång, och tar aldrig över skärmen. Ingen röd färg, ingen dialog. */
function Felrad() {
  const error = useApp((s) => s.error);
  if (error === null) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top) + var(--rytm) * 2)',
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 calc(var(--rytm) * 3)',
        pointerEvents: 'none',
        zIndex: 11,
      }}
    >
      <p
        className="viskning"
        style={{
          margin: 0,
          textAlign: 'center',
          background: 'var(--yta)',
          border: '1px solid var(--linje)',
          borderRadius: 'var(--radie)',
          padding: 'calc(var(--rytm) * 1.5) calc(var(--rytm) * 2)',
        }}
      >
        {error}
      </p>
    </div>
  );
}
