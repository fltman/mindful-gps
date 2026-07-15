/**
 * Berättelsen och rösten, sedda från klienten.
 *
 * ⛔ Ingen nyckel här. Webbläsaren anropar BARA vår egen server — texten och mp3:en kommer
 *    därifrån. OpenRouter- och ElevenLabs-nycklarna bor på servern och lämnar den aldrig.
 *    En nyckel i klienten är en nyckel i varenda besökares webbläsare.
 */

const API = import.meta.env['VITE_API'] ?? 'http://localhost:8161';

export interface Källa {
  readonly url: string;
  readonly title?: string;
}

export interface Berättelse {
  readonly text: string;
  readonly källor: readonly Källa[];
}

/** Texten. Kastar med ett svenskt, färdigt felmeddelande — inklusive "inte påslaget". */
export async function hämtaBerättelse(id: number, signal?: AbortSignal): Promise<Berättelse> {
  const res = await fetch(`${API}/api/sight/${id}/berattelse`, signal ? { signal } : {});
  const data = await res.json().catch(() => ({})) as {
    text?: string; källor?: Källa[]; error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? 'Kunde inte hämta berättelsen just nu.');
  return { text: data.text ?? '', källor: data.källor ?? [] };
}

/**
 * Värm textcachen för sevärdheterna längs en rutt, i bakgrunden.
 *
 * Fire-and-forget: anropet blockerar ALDRIG starten, och ett fel är tyst — trycker man på
 * en prick under körningen och den inte hann förberedas hämtas den live i stället. Poängen
 * är att den oftast HANN, så att en berättelse finns på ett tryck även utan mobilnät.
 */
export function förhandshämta(polyline: string): void {
  void fetch(`${API}/api/sight/prefetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ polyline }),
  }).catch(() => { /* tyst — täckningsskugga är det normala, inte ett fel */ });
}

/**
 * Rösten som en spelbar url (en Blob-URL). Anroparen äger den och ska återkalla den med
 * `URL.revokeObjectURL` när den spelat klart — annars läcker minne, en mp3 i taget.
 */
export async function hämtaRöst(id: number, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${API}/api/sight/${id}/rost`, signal ? { signal } : {});
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? 'Kunde inte läsa upp just nu.');
  }
  return URL.createObjectURL(await res.blob());
}
