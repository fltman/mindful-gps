import { useCallback, useEffect, useRef, useState } from 'react';

const HALLTID_MS = 1000;

interface Props {
  readonly text: string;
  readonly onHold: () => void;
}

/**
 * En knapp som kräver en sekunds medveten tryckning.
 *
 * Man ska inte kunna råka stoppa inspelningen med en knoge mot skärmen när man växlar.
 * Släpper man för tidigt händer ingenting alls — ingen varning, ingen dialog.
 */
export function HoldButton({ text, onHold }: Props) {
  const [halls, setHalls] = useState(false);
  const timer = useRef<number | null>(null);

  const avbryt = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setHalls(false);
  }, []);

  const borja = useCallback(() => {
    if (timer.current !== null) return;
    setHalls(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHalls(false);
      onHold();
    }, HALLTID_MS);
  }, [onHold]);

  useEffect(() => avbryt, [avbryt]);

  return (
    <button
      type="button"
      className={`knapp hall${halls ? ' hall--halls' : ''}`}
      onPointerDown={borja}
      onPointerUp={avbryt}
      onPointerLeave={avbryt}
      onPointerCancel={avbryt}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (!e.repeat) borja();
        }
      }}
      onKeyUp={avbryt}
      onBlur={avbryt}
    >
      <span className="hall__fyllning" aria-hidden="true" />
      <span className="hall__text">{text}</span>
    </button>
  );
}
