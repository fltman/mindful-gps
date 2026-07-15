/**
 * Berättelsen, uppläst. ElevenLabs text-till-tal.
 *
 * ⛔ Bara på begäran. Ljudet spelas i klienten genom ETT `<audio>`-element, aldrig Web
 *    Audio — iOS ringknapp tystar Web Audio men inte `<audio>`, och en reskamrat som blir
 *    tyst för att telefonen råkade stå på ljudlös är en trasig reskamrat. Det ligger i
 *    klienten; det som ligger HÄR är att göra text till mp3.
 *
 * Rösten och modellen är miljövariabler, med förvalen användaren bad om.
 */

const VOICE_ID = process.env['ELEVENLABS_VOICE_ID'] ?? 'Mml2TPQDyjmb9MxQdllJ';
const MODELL = process.env['ELEVENLABS_MODEL'] ?? 'eleven_v3';

/** Kastas när ELEVENLABS_API_KEY inte är satt. Rutten gör den till ett ärligt 501. */
export class RöstSaknasError extends Error {
  constructor() {
    super('Uppläsning är inte påslagen. Sätt ELEVENLABS_API_KEY.');
    this.name = 'RöstSaknasError';
  }
}

export function harRöstNyckel(): boolean {
  return (process.env['ELEVENLABS_API_KEY'] ?? '').length > 0;
}

/** Text → mp3-bytes. */
export async function talTillLjud(text: string, signal?: AbortSignal): Promise<Buffer> {
  const key = process.env['ELEVENLABS_API_KEY'];
  if (!key) throw new RöstSaknasError();

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: MODELL }),
      ...(signal ? { signal } : {}),
    },
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  return Buffer.from(await res.arrayBuffer());
}
