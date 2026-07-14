import { useEffect, useState } from 'react';

/** Safari på iOS exponerar `standalone` på navigator; ingen annan webbläsare gör det. */
interface IOSNavigator extends Navigator {
  readonly standalone?: boolean;
}

function pahemskarmen(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  return (window.navigator as IOSNavigator).standalone === true;
}

function arIOS(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

interface Props {
  readonly onAccept: () => void;
}

/**
 * Första mötet. Två saker ska sägas, och de ska sägas rakt ut:
 * varför kartan är tom, och varför appen måste ligga på hemskärmen.
 *
 * Det andra är inte en tillväxtknep — det är sant. Kör appen i en flik raderar Safari
 * nätet när lagringen städas, och skärmen somnar mitt i en tur.
 */
export function Onboarding({ onAccept }: Props) {
  const [installerad, setInstallerad] = useState(pahemskarmen);

  // Läggs appen till på hemskärmen startas den om som fristående — men i simulator
  // och på desktop kan läget ändras utan omstart, så vi lyssnar.
  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const lyssna = () => setInstallerad(pahemskarmen());
    mq.addEventListener('change', lyssna);
    return () => mq.removeEventListener('change', lyssna);
  }, []);

  return (
    <div className="skarm">
      <div className="intro">
        <h1 className="rubrik" style={{ marginBottom: '24px' }}>
          Kartan är tom.
          <br />
          Det är hela poängen.
        </h1>

        <p>
          Varje väg du kör ritas in. Med tiden växer ett nät som bara är ditt, och appen
          börjar kunna föreslå vägar du aldrig tagit.
        </p>

        <p>
          Appen minns bara vägar du kör med appen öppen och skärmen tänd. Det är en
          webbläsarbegränsning, inte ett val. <b>Lägg telefonen i hållaren. Koppla in
          laddaren.</b>
        </p>

        {!installerad && (
          <>
            <p>
              Och lägg den på hemskärmen först. Gör du inte det raderar Safari ditt nät när
              lagringen städas — ofta redan efter en vecka — och skärmen släcks mitt i turen.
            </p>
            <ol className="intro__steg">
              {arIOS() ? (
                <>
                  <li>Tryck på Dela-ikonen i Safaris verktygsfält.</li>
                  <li>Välj Lägg till på hemskärmen.</li>
                  <li>Starta appen därifrån.</li>
                </>
              ) : (
                <>
                  <li>Öppna webbläsarens meny.</li>
                  <li>Välj Installera app, eller Lägg till på hemskärmen.</li>
                  <li>Starta appen därifrån.</li>
                </>
              )}
            </ol>
          </>
        )}
      </div>

      <div className="stapel">
        {installerad ? (
          <button type="button" className="knapp" onClick={onAccept}>
            Börja
          </button>
        ) : (
          <>
            <button type="button" className="knapp knapp--tyst" onClick={onAccept}>
              Fortsätt ändå
            </button>
            <p className="viskning" style={{ margin: 0, textAlign: 'center' }}>
              Nätet kan försvinna.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
