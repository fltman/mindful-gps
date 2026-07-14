import { formatKm, kmTillMeter } from './format';

interface Props {
  readonly tripKm: number;
  readonly tripNovelKm: number;
  readonly netKm: number;
  readonly onShare: () => void;
  readonly onDone: () => void;
}

/**
 * Kartan ritar in den nya tråden i nätet under ungefär två sekunder. Texten och
 * knapparna väntar in den — det är animationen som är belöningen, inte siffran.
 */
export function AfterDriveScreen({ tripKm, tripNovelKm, netKm, onShare, onDone }: Props) {
  const nya = Math.min(tripNovelKm, tripKm);
  const alltVarNytt = tripKm - nya < 0.1;

  return (
    <div className="skarm">
      <div className="fyll" />
      <div className="stapel">
        <div className="panel eftertext">
          <p className="rubrik">
            Du la till {formatKm(kmTillMeter(nya))}.
            <br />
            Nätet är {formatKm(kmTillMeter(netKm))}.
          </p>
          {!alltVarNytt && (
            <p className="viskning" style={{ margin: '12px 0 0' }}>
              Du körde {formatKm(kmTillMeter(tripKm))}. Resten kände du redan.
            </p>
          )}
        </div>
        <div className="knapp-rad eftertext eftertext--knappar">
          <button type="button" className="knapp knapp--tyst" onClick={onShare}>
            Dela
          </button>
          <button type="button" className="knapp" onClick={onDone}>
            Klar
          </button>
        </div>
      </div>
    </div>
  );
}
