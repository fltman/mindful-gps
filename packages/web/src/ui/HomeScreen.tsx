import { formatKm, kmTillMeter } from './format';

interface Props {
  readonly netKm: number;
  readonly onStart: () => void;
  readonly onPlan: () => void;
}

/**
 * Kartan är hemskärmen. Det här är bara det som ligger ovanpå den:
 * en lugn rad, och två knappar.
 *
 * "Kör" är fortfarande den stora: att bara ge sig av och låta appen minnas är produkten i
 * sin enklaste form, och den ska inte kräva att man först fattar ett beslut. "Vart?" är
 * den tysta bredvid — den dagen man faktiskt ska någonstans.
 */
export function HomeScreen({ netKm, onStart, onPlan }: Props) {
  const natet =
    netKm < 0.1
      ? 'Ditt nät är tomt.'
      : `${formatKm(kmTillMeter(netKm))} i ditt nät`;

  return (
    <div className="skarm">
      <div className="fyll" />
      <div className="stapel">
        <p className="viskning" style={{ margin: 0, textAlign: 'center' }}>
          {natet}
        </p>
        <div className="knapp-rad">
          <button type="button" className="knapp knapp--tyst" onClick={onPlan}>
            Vart?
          </button>
          <button type="button" className="knapp" onClick={onStart}>
            Kör
          </button>
        </div>
      </div>
    </div>
  );
}
