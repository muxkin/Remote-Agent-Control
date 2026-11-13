export const SELECTION_TRANSLATION_MAX_LENGTH = 2000;
export const SELECTION_TRANSLATION_LANGUAGES = ['zh', 'en'] as const;
export type SelectionTranslationLanguage = (typeof SELECTION_TRANSLATION_LANGUAGES)[number];
