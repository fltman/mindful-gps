/**
 * En tunn klient mot OpenRouter (OpenAI-kompatibelt chat-API).
 *
 * OpenRouter är en gateway: samma anrop, valfri modell bakom en slug. Vi använder två —
 * en söker på webben, en skriver texten — och båda är miljövariabler så de kan bytas utan
 * en deploy. Nyckeln ligger ALDRIG i koden; utan den kastar vi rakt ut, och rutten över
 * oss gör det till ett ärligt svar på svenska i stället för en krasch.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface ORMeddelande {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** En källa modellen faktiskt läste. Bara url:en är intressant för oss. */
export interface ORKälla {
  readonly url: string;
  readonly title?: string;
}

export interface ORSvar {
  readonly content: string;
  readonly källor: readonly ORKälla[];
}

export function harÖppenRouterNyckel(): boolean {
  return (process.env['OPENROUTER_API_KEY'] ?? '').length > 0;
}

interface ORAnnotation {
  readonly type?: string;
  readonly url_citation?: { readonly url?: string; readonly title?: string };
  readonly url?: string;
  readonly title?: string;
}

/** Plocka ut url-citaten oavsett vilken av de två formerna modellen råkar använda. */
function källorUr(annotations: readonly ORAnnotation[] | undefined): ORKälla[] {
  const ut: ORKälla[] = [];
  const sedda = new Set<string>();

  for (const a of annotations ?? []) {
    const url = a.url_citation?.url ?? a.url;
    if (!url || sedda.has(url)) continue;
    sedda.add(url);
    ut.push({ url, ...(a.url_citation?.title ?? a.title ? { title: a.url_citation?.title ?? a.title } : {}) });
  }
  return ut;
}

export interface ORFråga {
  readonly model: string;
  readonly messages: readonly ORMeddelande[];
  /** Sök-modeller (search-preview) tar ingen temperatur — utelämna den då. */
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export async function openrouterChat(f: ORFråga): Promise<ORSvar> {
  const key = process.env['OPENROUTER_API_KEY'];
  if (!key) throw new Error('OPENROUTER_API_KEY saknas');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      // OpenRouter använder de här till attribution i sina topplistor. Ingen hemlighet.
      'HTTP-Referer': 'https://github.com/fltman/mindful-gps',
      'X-Title': 'Mindful GPS',
    },
    body: JSON.stringify({
      model: f.model,
      messages: f.messages,
      ...(f.temperature != null ? { temperature: f.temperature } : {}),
      ...(f.maxTokens != null ? { max_tokens: f.maxTokens } : {}),
    }),
    ...(f.signal ? { signal: f.signal } : {}),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string; annotations?: ORAnnotation[] } }>;
  };
  const msg = data.choices?.[0]?.message;

  return { content: msg?.content ?? '', källor: källorUr(msg?.annotations) };
}
