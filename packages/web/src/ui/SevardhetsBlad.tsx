/**
 * Bladet som visas när föraren TRYCKER på en sevärdhet.
 *
 * ⛔ Det här är den enda gången appen berättar om en sevärdhet, och det sker aldrig
 *    oombett. Ett tryck öppnade bladet; texten hämtas då, och rösten först om man ber om
 *    den. Doktrinen intakt: appen tiger tills du frågar.
 *
 * Rösten spelas genom ETT `<audio>`-element (aldrig Web Audio — iOS ringknapp tystar det
 * senare). Blob-URL:en återkallas när en ny spelas eller bladet stängs.
 */

import { useEffect, useRef, useState } from 'react';

import type { SevärdhetsTryck } from '../map/index.js';

import { hämtaBerättelse, hämtaRöst, type Berättelse } from './sevardhetBerattelse.js';

interface Props {
  readonly sevärdhet: SevärdhetsTryck;
  readonly onStäng: () => void;
}

type Status = 'laddar' | 'klar' | 'fel';

/** "https://sv.wikipedia.org/wiki/Kosta" → "sv.wikipedia.org". Källan man känner igen. */
function värd(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function SevardhetsBlad({ sevärdhet, onStäng }: Props) {
  const [status, setStatus] = useState<Status>('laddar');
  const [berättelse, setBerättelse] = useState<Berättelse | null>(null);
  const [fel, setFel] = useState<string | null>(null);

  const [spelar, setSpelar] = useState(false);
  const [röstFel, setRöstFel] = useState<string | null>(null);
  const [hämtarRöst, setHämtarRöst] = useState(false);

  const audio = useRef<HTMLAudioElement | null>(null);
  const blobUrl = useRef<string | null>(null);

  const släppLjud = (): void => {
    if (blobUrl.current) {
      URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = null;
    }
  };

  // Ny sevärdhet: hämta texten, nollställ rösten. Avbryts rent om man trycker på nästa
  // prick innan den förra svarat.
  useEffect(() => {
    const styrning = new AbortController();
    setStatus('laddar');
    setBerättelse(null);
    setFel(null);
    setRöstFel(null);
    setSpelar(false);
    audio.current?.pause();
    släppLjud();

    hämtaBerättelse(sevärdhet.id, styrning.signal)
      .then((b) => { setBerättelse(b); setStatus('klar'); })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setFel(e instanceof Error ? e.message : 'Kunde inte hämta berättelsen.');
        setStatus('fel');
      });

    return () => { styrning.abort(); audio.current?.pause(); släppLjud(); };
  }, [sevärdhet.id]);

  async function läsUpp(): Promise<void> {
    const el = audio.current;
    if (!el) return;

    if (spelar) { el.pause(); return; }

    // Har vi redan mp3:en? Spela om den. Annars hämta.
    if (blobUrl.current) { void el.play(); return; }

    setRöstFel(null);
    setHämtarRöst(true);
    try {
      const url = await hämtaRöst(sevärdhet.id);
      blobUrl.current = url;
      el.src = url;
      await el.play();
    } catch (e: unknown) {
      setRöstFel(e instanceof Error ? e.message : 'Kunde inte läsa upp.');
    } finally {
      setHämtarRöst(false);
    }
  }

  return (
    <div className="blad-kort panel">
      <div className="blad__topp">
        <h2 className="blad__namn">{sevärdhet.namn || sortNamn(sevärdhet.kind)}</h2>
        <button type="button" className="blad__stang" onClick={onStäng} aria-label="Stäng">
          ×
        </button>
      </div>

      {status === 'laddar' && <p className="viskning">Läser på om platsen …</p>}

      {status === 'fel' && <p className="viskning">{fel}</p>}

      {status === 'klar' && berättelse && (
        <>
          {berättelse.text.split('\n').filter((s) => s.trim()).map((stycke, i) => (
            <p key={i} className="blad__text">{stycke}</p>
          ))}

          {berättelse.källor.length > 0 && (
            <p className="viskning blad__kallor">
              Källa:{' '}
              {berättelse.källor.slice(0, 2).map((k, i) => (
                <span key={k.url}>
                  {i > 0 && ', '}
                  <a href={k.url} target="_blank" rel="noreferrer">{värd(k.url)}</a>
                </span>
              ))}
            </p>
          )}

          <button
            type="button"
            className="knapp knapp--tyst blad__lyssna"
            onClick={() => void läsUpp()}
            disabled={hämtarRöst}
          >
            {hämtarRöst ? 'Hämtar röst …' : spelar ? 'Tyst' : 'Läs upp'}
          </button>

          {röstFel && <p className="viskning">{röstFel}</p>}
        </>
      )}

      <audio
        ref={audio}
        onPlaying={() => setSpelar(true)}
        onEnded={() => setSpelar(false)}
        onPause={() => setSpelar(false)}
      />
    </div>
  );
}

/** Namn på sorten, för sevärdheter som saknar eget namn (en namnlös runsten). */
function sortNamn(kind: SevärdhetsTryck['kind']): string {
  const namn: Record<SevärdhetsTryck['kind'], string> = {
    utsikt: 'Utsiktsplats', vattenfall: 'Vattenfall', runsten: 'Runsten',
    fornlämning: 'Fornlämning', borg: 'Borg', fyr: 'Fyr', naturreservat: 'Naturreservat',
    kyrka: 'Kyrka', museum: 'Museum', sevärdhet: 'Sevärdhet', konst: 'Konst',
    minnesmärke: 'Minnesmärke',
  };
  return namn[kind];
}
