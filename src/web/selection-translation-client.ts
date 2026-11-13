import { HttpMessagingClient } from '../client/messaging';
import type { SelectionTranslationLanguage } from '../shared/selection-translation';

export type TranslationTarget = SelectionTranslationLanguage;

type ModelOptions = { signal: AbortSignal };

type BrowserTranslation = typeof globalThis & {
  Translator?: {
    create(options: ModelOptions & { sourceLanguage: string; targetLanguage: string }): Promise<{
      translate(text: string, options: ModelOptions): Promise<string>;
      destroy(): void;
    }>;
  };
  LanguageDetector?: {
    availability(): Promise<string>;
    create(options: ModelOptions): Promise<{
      detect(
        text: string,
        options: ModelOptions,
      ): Promise<{ detectedLanguage: string; confidence: number }[]>;
      destroy(): void;
    }>;
  };
};

const translationClient = new HttpMessagingClient();

function guessSourceLanguage(text: string): string | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  if (han && han * 2 >= latin) return 'zh';
  if (latin) return 'en';
}

export function defaultTranslationTarget(text: string): TranslationTarget {
  return guessSourceLanguage(text) === 'zh' ? 'en' : 'zh';
}

async function detectSourceLanguage(
  api: NonNullable<BrowserTranslation['LanguageDetector']>,
  text: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if ((await api.availability()) !== 'available') return;
  signal.throwIfAborted();
  const detector = await api.create({ signal });
  try {
    const [result] = await detector.detect(text, { signal });
    if (!result || result.confidence < 0.5 || result.detectedLanguage === 'und') return;
    const locale = new Intl.Locale(result.detectedLanguage);
    if (locale.language === 'zh' && locale.maximize().script === 'Hant') return 'zh-Hant';
    return locale.language;
  } finally {
    detector.destroy();
  }
}

export async function translateOnDevice(
  text: string,
  targetLanguage: TranslationTarget,
  signal: AbortSignal,
): Promise<string | null> {
  const { Translator, LanguageDetector } = globalThis as BrowserTranslation;
  signal.throwIfAborted();
  if (!Translator?.create) return null;

  let sourceLanguage = guessSourceLanguage(text);
  if (LanguageDetector) {
    // Only use a ready detector and keep the wait short to preserve the click's activation.
    const detectionSignal = AbortSignal.any([signal, AbortSignal.timeout(200)]);
    const detected = await Promise.race([
      detectSourceLanguage(LanguageDetector, text, detectionSignal).catch(() => undefined),
      new Promise<undefined>((resolve) =>
        detectionSignal.addEventListener('abort', () => resolve(undefined), { once: true }),
      ),
    ]);
    sourceLanguage = detected ?? sourceLanguage;
  }

  signal.throwIfAborted();
  if (!sourceLanguage || sourceLanguage === targetLanguage) return null;
  try {
    const translator = await Translator.create({ sourceLanguage, targetLanguage, signal });
    try {
      const translation = await translator.translate(text, { signal });
      signal.throwIfAborted();
      return translation.trim() || null;
    } finally {
      translator.destroy();
    }
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

export async function translationServiceAvailable(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    const status = await translationClient.request<{ available?: boolean }>(
      '/translation',
      'GET',
      undefined,
      signal,
    );
    signal.throwIfAborted();
    return status?.available === true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

export async function translateWithService(
  text: string,
  targetLanguage: TranslationTarget,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  try {
    const result = await translationClient.request<{ translatedText?: unknown }>(
      '/translation',
      'POST',
      { text, targetLanguage },
      signal,
    );
    signal.throwIfAborted();
    if (typeof result?.translatedText === 'string' && result.translatedText.trim())
      return result.translatedText;
  } catch {
    signal.throwIfAborted();
  }
  throw Error('翻译服务暂不可用，请稍后重试。');
}

export function externalTranslationUrl(text: string, targetLanguage: TranslationTarget): string {
  const url = new URL('https://translate.google.com/');
  url.search = new URLSearchParams({
    sl: 'auto',
    tl: targetLanguage === 'zh' ? 'zh-CN' : 'en',
    text,
    op: 'translate',
  }).toString();
  return url.href;
}
