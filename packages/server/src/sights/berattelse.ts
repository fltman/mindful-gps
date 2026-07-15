/**
 * Berättelsen om en sevärdhet. Ett grundat anrop över OpenRouter.
 *
 * ── Varför ETT anrop, inte två ──────────────────────────────────────────────
 *
 * ⚠️ Planen var två modeller: gpt-4o-search-preview söker, claude-haiku-4.5 skriver. Mätt
 *    mot OpenRouter föll den: sök-modellen returnerar noll STRUKTURERADE källor — länkarna
 *    ligger inbäddade i texten och går inte att plocka ut säkert. Utan källor kan vi inte
 *    visa var texten kommer ifrån, och då är "aldrig ha rätt" bruten.
 *
 *    `:online` — OpenRouters egen websök-plugin — gör i stället både sökningen OCH texten i
 *    ett anrop, och returnerar riktiga citat (Wikipedia, Länsstyrelsen, kommunernas sidor).
 *    Ett anrop, billigare, och det ger det vi faktiskt behövde: källorna.
 *
 * Grundningen sköts av plugin:en, ärligheten av systemprompten:
 *
 * ⛔ Hittar den inget säkert ska texten SÄGA det ("jag hittar inte mycket om den här
 *    platsen"), inte gissa. En självsäker påhittad historia om en namnlös runsten är det
 *    värsta funktionen kan göra — och den läses dessutom upp.
 */

import type { Sight, SightKind } from '@mindful/core';

import { harÖppenRouterNyckel, openrouterChat, type ORKälla } from '../ai/openrouter.js';

/** Kastas när OPENROUTER_API_KEY inte är satt. Rutten gör den till ett ärligt 501. */
export class AISaknasError extends Error {
  constructor() {
    super('AI-berättelser är inte påslagna. Sätt OPENROUTER_API_KEY.');
    this.name = 'AISaknasError';
  }
}

/**
 * Modellen som både söker och skriver. `:online` slår på OpenRouters websök-plugin, som är
 * det som ger de strukturerade källorna. Byter du modell: behåll `:online`, annars tystnar
 * källorna och texten blir ogrundad.
 */
const MODELL = process.env['OPENROUTER_STORY_MODEL'] ?? 'perplexity/sonar-pro-search';

/**
 * Rensa citatmarkörer ur texten.
 *
 * Sök-modeller väver in källhänvisningar i själva texten — Perplexity som fotnoter `[4][7]`,
 * andra som markdown-länkar `[text](url)`. På skärmen är de skräp, och UPPLÄSTA är de
 * katastrof: ElevenLabs säger "fyra sju" mitt i en mening. Url:erna finns ändå kvar,
 * strukturerat, i `källor`. Här tar vi bort dem ur prosan.
 */
function städa(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')   // markdown-länk → bara texten
    .replace(/\[\d+\]/g, '')                              // fotnot [4], [7], ...
    .replace(/^#{1,6}\s+/gm, '')                          // rubriker # ## ...
    .replace(/\*\*([^*]+)\*\*/g, '$1')                    // **fetstil**
    .replace(/__([^_]+)__/g, '$1')                        // __fetstil__
    .replace(/\*([^*]+)\*/g, '$1')                        // *kursiv*
    .replace(/[ \t]+([.,!?;:])/g, '$1')                   // mellanslag som blev kvar före tecken
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Sortens svenska namn, för att fråga modellen om rätt sak. */
const SORT_SV: Record<SightKind, string> = {
  utsikt: 'utsiktsplats', vattenfall: 'vattenfall', runsten: 'runsten',
  fornlämning: 'fornlämning', borg: 'borg eller fästning', fyr: 'fyr',
  naturreservat: 'naturreservat', kyrka: 'kyrka', museum: 'museum',
  sevärdhet: 'sevärdhet', konst: 'offentlig konst', minnesmärke: 'minnesmärke',
};

export interface Berättelse {
  readonly text: string;
  readonly källor: readonly ORKälla[];
}

const SKRIV_SYSTEM = [
  'Du är en lugn, kunnig reskamrat i passagerarsätet. Föraren har just tryckt på en plats',
  'på kartan och undrar vad det är. Skriv 2–3 meningar på svenska.',
  '',
  'Regler:',
  '- Grunda dig STRIKT i faktaunderlaget nedan. Lägg aldrig till egna fakta, årtal eller',
  '  namn som inte står där.',
  '- Säger underlaget lite eller inget, säg det rakt ut: "Jag hittar inte mycket om den',
  '  här platsen." Gissa aldrig.',
  '- Engagerande men aldrig reklam. Ingen brådska, inga utrop, inga superlativ.',
  '- Skriv som man pratar i en bil, inte som en uppslagsbok.',
].join('\n');

/**
 * Komponera en berättelse. `ort` är valfri — vet vi den närmaste orten hjälper det
 * sökningen, men den klarar sig på koordinaterna.
 */
export async function komponeraBerättelse(
  sight: Sight, ort?: string, signal?: AbortSignal,
): Promise<Berättelse> {
  if (!harÖppenRouterNyckel()) throw new AISaknasError();

  const [lon, lat] = sight.at;
  const vad = sight.name
    ? `"${sight.name}" (en ${SORT_SV[sight.kind]})`
    : `en ${SORT_SV[sight.kind]} utan namn`;
  const var_ = ort ? `nära ${ort}, ` : '';

  const svar = await openrouterChat({
    model: MODELL,
    temperature: 0.7,
    maxTokens: 260,
    messages: [
      { role: 'system', content: SKRIV_SYSTEM },
      {
        role: 'user',
        content: `Sök på webben och berätta om ${vad}, ${var_}vid koordinaterna`
          + ` ${lat.toFixed(5)}, ${lon.toFixed(5)} i Sverige. Hittar du inget om just den`
          + ' här platsen, säg det rakt ut.',
      },
    ],
    ...(signal ? { signal } : {}),
  });

  const text = städa(svar.content);
  if (text.length === 0) {
    return { text: 'Jag hittar inte mycket om den här platsen.', källor: [] };
  }
  return { text, källor: svar.källor };
}
