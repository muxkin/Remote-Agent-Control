import type { SelectionTranslationLanguage } from '../../shared/selection-translation.js';

export interface TranslationEnvironment {
  POCKET_TRANSLATION_URL?: string;
  POCKET_TRANSLATION_API_KEY?: string;
}

export type SelectionTranslator = (text: string, target: SelectionTranslationLanguage) => Promise<string>;

export function translationProvider(env: TranslationEnvironment): SelectionTranslator | undefined {
  if (!env.POCKET_TRANSLATION_URL?.trim()) return;
  const endpoint = URL.parse(env.POCKET_TRANSLATION_URL);
  const loopback = endpoint && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    !endpoint ||
    (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error('Invalid POCKET_TRANSLATION_URL');

  const apiKey = env.POCKET_TRANSLATION_API_KEY;
  return async (text, target) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        source: 'auto',
        target,
        format: 'text',
        ...(apiKey && { api_key: apiKey }),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Translation request failed');
    }
    const result = (await response.json()) as { translatedText?: unknown } | null;
    if (typeof result?.translatedText !== 'string' || !result.translatedText.trim())
      throw Error('Invalid translation response');
    return result.translatedText;
  };
}
