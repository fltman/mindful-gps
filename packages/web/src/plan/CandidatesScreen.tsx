/**
 * Rutterna, som kort man sveper mellan.
 *
 * ⭐ Det viktigaste på den här skärmen står inte på korten. Det är KARTAN: den valda
 *    rutten ritas i två färger — ny väg varm och tjock, känd väg grå och tunn. Man ska
 *    SE nyheten, inte läsa om den. Korten är bara bildtexten.
 *
 * Därför är svepet kopplat till kartan och inte tvärtom: byter man kort byter kartan
 * rutt i samma rörelse (`onVälj`). Ingen "visa på kartan"-knapp. Kartan visar redan.
 */

import { useCallback, useEffect, useRef } from 'react';

import { grusrad, motorvägsrad, nyhetsrad, tidsrad } from './text.js';
import type { PlanRoute } from './types.js';

interface Props {
  /** Förslagen först, baslinjen sist. Ordningen är `PlanFlow`s, inte serverns. */
  readonly rutter: readonly PlanRoute[];
  readonly vald: number;
  readonly onVälj: (i: number) => void;
  readonly onKör: () => void;
  readonly onTillbaka: () => void;
}

export function CandidatesScreen({ rutter, vald, onVälj, onKör, onTillbaka }: Props) {
  const rad = useRef<HTMLDivElement>(null);
  const rullning = useRef<number | null>(null);

  /**
   * Vilket kort ligger mitt i rutan? Vi mäter mot korten, inte mot en kortbredd — då
   * behöver vi aldrig veta något om marginaler, och en halvsvept rad väljer ändå rätt.
   */
  const läsAvSvep = useCallback(() => {
    const värd = rad.current;
    if (!värd) return;

    const mitt = värd.scrollLeft + värd.clientWidth / 2;
    let bäst = 0;
    let minst = Infinity;

    for (let i = 0; i < värd.children.length; i++) {
      const kort = värd.children[i];
      if (!(kort instanceof HTMLElement)) continue;
      const avstånd = Math.abs(kort.offsetLeft + kort.offsetWidth / 2 - mitt);
      if (avstånd < minst) {
        minst = avstånd;
        bäst = i;
      }
    }

    if (bäst !== vald) onVälj(bäst);
  }, [onVälj, vald]);

  // Ett svep ger dussintals scroll-händelser. Kartan ska bytas en gång per bildruta,
  // inte en gång per pixel.
  const svep = useCallback(() => {
    if (rullning.current !== null) return;
    rullning.current = requestAnimationFrame(() => {
      rullning.current = null;
      läsAvSvep();
    });
  }, [läsAvSvep]);

  useEffect(() => () => {
    if (rullning.current !== null) cancelAnimationFrame(rullning.current);
  }, []);

  const gåTill = (i: number): void => {
    const kort = rad.current?.children[i];
    if (kort instanceof HTMLElement) {
      kort.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
    onVälj(i);
  };

  const baslinje = rutter.find((k) => k.kind === 'baseline');

  return (
    <div className="skarm">
      <div className="fyll" />

      {/*
        ⚠️ Nyckeln är platsen i listan, inte `route.id`. Motorn ger inte unika id:n —
        Valhalla svarar med "valhalla@3.5.1#0" för både baslinjen och första kandidaten,
        eftersom numret räknas per ANROP och vi gör flera. Listan ordnas om aldrig efter
        att den satts, så platsen är en stabil identitet; `route.id` var det inte.
      */}
      <div className="kort-rad" ref={rad} onScroll={svep}>
        {rutter.map((k, i) => (
          <Kort key={i} kandidat={k} baslinje={baslinje} vald={i === vald} />
        ))}
      </div>

      {rutter.length > 1 && (
        <div className="prickar">
          {rutter.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Rutt ${i + 1}`}
              className={`prick ${i === vald ? 'prick--vald' : ''}`}
              onClick={() => gåTill(i)}
            />
          ))}
        </div>
      )}

      <div className="knapp-rad">
        <button type="button" className="knapp knapp--tyst" onClick={onTillbaka}>
          Tillbaka
        </button>
        <button type="button" className="knapp" onClick={onKör}>
          Kör
        </button>
      </div>
    </div>
  );
}

function Kort({
  kandidat, baslinje, vald,
}: {
  readonly kandidat: PlanRoute;
  readonly baslinje: PlanRoute | undefined;
  readonly vald: boolean;
}) {
  const motorväg = motorvägsrad(kandidat);
  const grus = grusrad(kandidat);

  return (
    <article className={`panel kort ${vald ? '' : 'kort--vilande'}`}>
      {kandidat.kind === 'baseline' && <p className="kort__etikett">Raka vägen</p>}

      <p className="kort__nyhet">{nyhetsrad(kandidat)}</p>
      <p className="kort__tid">{tidsrad(kandidat, baslinje)}</p>

      {motorväg && <p className="viskning kort__not">{motorväg}</p>}
      {grus && <p className="viskning kort__not">{grus}</p>}
    </article>
  );
}
