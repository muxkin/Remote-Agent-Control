export const SELECTION_TRANSLATION_MAX_LENGTH = 2000;
export const SELECTION_TRANSLATION_LANGUAGES = ['zh', 'en'] as const;
export type SelectionTranslationLanguage = (typeof SELECTION_TRANSLATION_LANGUAGES)[number];

export const DEEPSEEK_TRANSLATION_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const;
export const DEFAULT_DEEPSEEK_TRANSLATION_MODEL = DEEPSEEK_TRANSLATION_MODELS[0];

export type SelectionTranslationProvider =
  | { id: 'niutrans'; apiKey: string }
  | { id: 'deepseek'; apiKey: string; model?: (typeof DEEPSEEK_TRANSLATION_MODELS)[number] };

export function isSelectionTranslationApiKey(value: string): boolean {
  return /^[!-~]{1,512}$/.test(value.trim());
}
