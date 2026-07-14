/**
 * "Vart?"
 *
 * Tre lägen, en fråga i taget, och en budget som talar MINUTER.
 *
 * ⛔ Slidern visar aldrig procent. "35 % längre" är ett tal ur en formel; "får ta ungefär
 *    25 minuter längre" är ett beslut en människa kan fatta med en kaffekopp i handen.
 *    Minuterna är UNGEFÄRLIGA här, och det står det — den exakta siffran kommer ur
 *    motorn och står på kortet efteråt. Att gissa exakt vore att ljuga prydligt.
 */

import { useEffect, useRef, useState } from 'react';

import type { LngLat } from '@mindful/core';

import { formatDuration } from '../ui/index.js';

import { EPSILONS, estimeradBaslinjeS, type Epsilon } from './api.js';
import { DEBOUNCE_MS, sök, type Plats } from './geokod.js';
import type { PlanMode } from './types.js';

/** Slingans och utsvepets budget. Under en kvart är det ingen tur; över en dag ingen app. */
const MINUTER = { min: 30, max: 240, steg: 15, start: 90 } as const;

const LÄGEN: ReadonlyArray<{ id: PlanMode; text: string }> = [
  { id: 'ab', text: 'Kör mig dit' },
  { id: 'loop', text: 'Ge mig en slinga' },
  { id: 'explore', text: 'Ut på vift' },
];

const RIKTNINGAR: ReadonlyArray<{ grader: number; text: string }> = [
  { grader: 0, text: 'N' },
  { grader: 45, text: 'NO' },
  { grader: 90, text: 'O' },
  { grader: 135, text: 'SO' },
  { grader: 180, text: 'S' },
  { grader: 225, text: 'SV' },
  { grader: 270, text: 'V' },
  { grader: 315, text: 'NV' },
];

export interface Val {
  readonly mode: PlanMode;
  /** Bara i "Kör mig dit". */
  readonly to?: Plats;
  readonly epsilon: Epsilon;
  readonly minutes: number;
  readonly headingDeg: number;
}

interface Props {
  /** Var vi står. Null tills första fixen kommit — då kan man ännu inte planera. */
  readonly från: LngLat | null;
  readonly laddar: boolean;
  readonly fel: string | null;
  readonly onPlanera: (val: Val) => void;
  /** Ett svar på en fråga användaren har lämnat är inte längre ett svar. */
  readonly onRensaFel: () => void;
  readonly onStäng: () => void;
}

export function PlanSheet({ från, laddar, fel, onPlanera, onRensaFel, onStäng }: Props) {
  const [läge, sättLäge] = useState<PlanMode>('ab');
  const [fråga, sättFråga] = useState('');
  const [träffar, sättTräffar] = useState<readonly Plats[]>([]);
  const [mål, sättMål] = useState<Plats | null>(null);
  const [söker, sättSöker] = useState(false);
  const [sökfel, sättSökfel] = useState<string | null>(null);
  const [steg, sättSteg] = useState(1);          // ε = 0.35, mitten
  const [minuter, sättMinuter] = useState<number>(MINUTER.start);
  const [riktning, sättRiktning] = useState(0);

  const senaste = useRef<AbortController | null>(null);

  // Photon, 350 ms efter att fingret slutat röra sig. Varje ny fråga avbryter den förra:
  // ett svar på en fråga användaren redan skrivit över är brus, inte data.
  useEffect(() => {
    if (läge !== 'ab') return;

    const q = fråga.trim();
    if (mål?.namn === q || q.length < 2) {
      sättTräffar([]);
      sättSöker(false);
      return;
    }

    const timer = window.setTimeout(() => {
      senaste.current?.abort();
      const styrning = new AbortController();
      senaste.current = styrning;

      sättSöker(true);
      sättSökfel(null);

      sök(q, från ?? undefined, styrning.signal)
        .then((platser) => {
          sättTräffar(platser);
          sättSöker(false);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          sättSökfel('Sökningen svarade inte. Försök igen om en stund.');
          sättSöker(false);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [fråga, läge, från, mål]);

  useEffect(() => () => senaste.current?.abort(), []);

  const epsilon: Epsilon = EPSILONS[steg] ?? 0.35;

  const väljMål = (p: Plats): void => {
    sättMål(p);
    sättFråga(p.namn);
    sättTräffar([]);
  };

  const redo = från !== null && (läge !== 'ab' || mål !== null);

  const planera = (): void => {
    if (!redo || laddar) return;
    onPlanera({
      mode: läge,
      to: mål ?? undefined,
      epsilon,
      minutes: minuter,
      headingDeg: riktning,
    });
  };

  return (
    <div className="skarm">
      <div className="fyll" onClick={onStäng} style={{ pointerEvents: 'auto' }} />

      <div className="panel plan">
        <div className="plan__lagen">
          {LÄGEN.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip ${läge === l.id ? 'chip--vald' : ''}`}
              onClick={() => {
                sättLäge(l.id);
                onRensaFel();
              }}
            >
              {l.text}
            </button>
          ))}
        </div>

        {läge === 'ab' && (
          <>
            <input
              className="falt"
              type="search"
              inputMode="search"
              autoComplete="off"
              placeholder="Vart?"
              value={fråga}
              onChange={(e) => {
                sättFråga(e.target.value);
                sättMål(null);
                onRensaFel();
              }}
            />

            {träffar.length > 0 && (
              <ul className="traffar">
                {träffar.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="traff" onClick={() => väljMål(p)}>
                      <span>{p.namn}</span>
                      {p.beskrivning && <span className="viskning">{p.beskrivning}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {söker && träffar.length === 0 && <p className="viskning plan__rad">Letar…</p>}
            {sökfel && <p className="viskning plan__rad">{sökfel}</p>}

            {mål && från && (
              <Tidsbudget
                steg={steg}
                epsilon={epsilon}
                baslinjeS={estimeradBaslinjeS(från, mål.at)}
                onSteg={sättSteg}
              />
            )}
          </>
        )}

        {läge !== 'ab' && (
          <label className="plan__rad">
            <span className="viskning">{minutText(minuter)}</span>
            <input
              className="reglage"
              type="range"
              min={MINUTER.min}
              max={MINUTER.max}
              step={MINUTER.steg}
              value={minuter}
              onChange={(e) => sättMinuter(Number(e.target.value))}
            />
          </label>
        )}

        {läge === 'explore' && (
          <div className="plan__lagen">
            {RIKTNINGAR.map((r) => (
              <button
                key={r.grader}
                type="button"
                className={`chip chip--smal ${riktning === r.grader ? 'chip--vald' : ''}`}
                onClick={() => sättRiktning(r.grader)}
              >
                {r.text}
              </button>
            ))}
          </div>
        )}

        {fel && <p className="viskning plan__rad">{fel}</p>}

        {från === null && (
          <p className="viskning plan__rad">Vi väntar in din position.</p>
        )}

        <div className="knapp-rad">
          <button type="button" className="knapp knapp--tyst" onClick={onStäng}>
            Tillbaka
          </button>
          <button
            type="button"
            className="knapp"
            disabled={!redo || laddar}
            style={{ opacity: redo && !laddar ? 1 : 0.5 }}
            onClick={planera}
          >
            {laddar ? 'Letar…' : 'Hitta vägen'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Tidsbudgeten. Fyra steg, och de heter minuter — aldrig 15, 35, 60 och 100 procent.
 *
 * Talet är en uppskattning ur fågelvägen: klienten känner inte baslinjens tid förrän
 * planeraren har frågat motorn. Därför "ungefär", och därför avrundat till fem minuter.
 * En slider som säger "23 min längre" låtsas veta något den inte vet.
 */
function Tidsbudget({
  steg, epsilon, baslinjeS, onSteg,
}: {
  readonly steg: number;
  readonly epsilon: number;
  readonly baslinjeS: number;
  readonly onSteg: (i: number) => void;
}) {
  const extra = Math.max(5, Math.round((baslinjeS * epsilon) / 60 / 5) * 5);

  return (
    <label className="plan__rad">
      <span className="viskning">{`Får ta ungefär ${extra} min längre`}</span>
      <input
        className="reglage"
        type="range"
        min={0}
        max={EPSILONS.length - 1}
        step={1}
        value={steg}
        onChange={(e) => onSteg(Number(e.target.value))}
      />
    </label>
  );
}

/** "1 h 30 min ute". Slingans budget är hela turen, inte en omväg. */
const minutText = (minuter: number): string => `${formatDuration(minuter * 60)} ute`;
