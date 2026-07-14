import { HoldButton } from './HoldButton';
import { formatKm, kmTillMeter } from './format';

interface Props {
  readonly tripKm: number;
  readonly tripNovelKm: number;
  readonly gapCount: number;
  readonly onStop: () => void;
}

/**
 * Medan man kör. Kartan och den växande tråden gör jobbet; här står bara två tal.
 *
 * Tappad signal är ett faktum, inte ett fel: vi säger det en gång, i samma ton som
 * allt annat, och går vidare. Ingen röd färg, ingen uppmaning att göra något åt det.
 */
export function RecordingScreen({ tripKm, tripNovelKm, gapCount, onStop }: Props) {
  const nya = Math.min(tripNovelKm, tripKm);

  return (
    <div className="skarm">
      <div className="fyll" />
      <div className="kor">
        <div className="tal">{formatKm(kmTillMeter(tripKm))}</div>
        <div className="tal--liten">{formatKm(kmTillMeter(nya))} av dem nya</div>
        {gapCount > 0 && (
          <p className="viskning" style={{ margin: '8px 0 0' }}>
            {gapCount === 1
              ? 'Tappade signalen en stund.'
              : 'Tappade signalen några gånger.'}
          </p>
        )}
      </div>
      <HoldButton text="Håll in för att stanna" onHold={onStop} />
    </div>
  );
}
