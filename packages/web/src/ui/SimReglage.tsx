/**
 * Fartreglaget — bara i simläge (`?sim=1`).
 *
 * Simulatorn spelar upp spåret i en komprimerad väggklocka. Förr styrdes den bara av
 * `&takt=` i URL:en, vilket betydde att man fick ladda om sidan för att prova en annan
 * fart. Det här är ett reglage i stället: dra, och farten ändras mitt i körningen — den
 * simulerade tiden och positionen rör sig inte, bara hur ofta fixarna kommer.
 *
 * ⛔ Det här är ett utvecklarverktyg, inte en produktfunktion. Det ritas ALDRIG i skarpt
 *    läge — `isSimulated()` avgör, och en URL utan `?sim=1` kan aldrig tända det.
 */

import { useState } from 'react';

import { MAX_SIM_FART } from '../sense/index.js';
import { simFartNu, sättSimFartNu } from '../app/state.js';

export function SimReglage() {
  const [fart, setFart] = useState<number>(() => Math.round(simFartNu()));

  const ändra = (v: number): void => {
    setFart(v);
    sättSimFartNu(v);
  };

  return (
    <div className="simreglage">
      <span className="simreglage__val">{fart === 1 ? 'realtid' : `${fart}×`}</span>
      <input
        type="range"
        min={1}
        max={MAX_SIM_FART}
        step={1}
        value={fart}
        onChange={(e) => ändra(Number(e.target.value))}
        aria-label="Simuleringsfart"
      />
    </div>
  );
}
