import { shallowReadonly, shallowRef } from 'vue';
import { openPrivate, sealPrivate, type AccountSecrets, type Ciphertext } from '../shared/account-crypto';
import {
  DEEPSEEK_TRANSLATION_MODELS,
  DEFAULT_DEEPSEEK_TRANSLATION_MODEL,
  isSelectionTranslationApiKey,
} from '../shared/selection-translation';

const engines = ['automatic', 'device', 'site', 'niutrans', 'deepseek'] as const;
export type TranslationEngine = (typeof engines)[number];
export type CloudTranslationEngine = Extract<TranslationEngine, 'niutrans' | 'deepseek'>;

export interface TranslationSettings {
  enabled: boolean;
  engine: TranslationEngine;
  deepseekModel: (typeof DEEPSEEK_TRANSLATION_MODELS)[number];
}

export interface TranslationAccount {
  id: string;
  secrets: AccountSecrets;
}

const SETTINGS_KEY = 'pocket:selection-translation:v1';
const API_KEY_PREFIX = 'pocket:selection-translation-key:v1:';

function parseSettings(value: Partial<TranslationSettings> | null): Readonly<TranslationSettings> {
  return Object.freeze({
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : true,
    engine: value?.engine && engines.includes(value.engine) ? value.engine : 'automatic',
    deepseekModel:
      value?.deepseekModel && DEEPSEEK_TRANSLATION_MODELS.includes(value.deepseekModel)
        ? value.deepseekModel
        : DEFAULT_DEEPSEEK_TRANSLATION_MODEL,
  });
}

function readSettings() {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'));
  } catch {
    return parseSettings(null);
  }
}

const preferences = shallowRef(readSettings());
const keyRevision = shallowRef(0);
const pendingWrites = new Map<string, symbol>();
export const translationSettings = shallowReadonly(preferences);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== localStorage) return;
    if (event.key === SETTINGS_KEY || event.key === null) preferences.value = readSettings();
    if (event.key?.startsWith(API_KEY_PREFIX) || event.key === null) keyRevision.value++;
  });
}

export function updateTranslationSettings(next: TranslationSettings) {
  const clean = parseSettings(next);
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(clean));
  preferences.value = clean;
}

function apiKeyLocation(accountId: string, engine: CloudTranslationEngine) {
  return `${API_KEY_PREFIX}${encodeURIComponent(accountId)}:${engine}`;
}

function readCiphertext(location: string): Ciphertext | undefined {
  const serialized = localStorage.getItem(location);
  if (!serialized) return;
  try {
    const value = JSON.parse(serialized);
    if (
      typeof value?.iv === 'string' &&
      /^[A-Za-z0-9+/]{16}$/.test(value.iv) &&
      typeof value.data === 'string' &&
      /^[A-Za-z0-9+/]{24,4096}={0,2}$/.test(value.data)
    )
      return { iv: value.iv, data: value.data };
  } catch {
    return;
  }
}

export function hasTranslationApiKey(accountId: string, engine: CloudTranslationEngine): boolean {
  // Track credential changes without retaining plaintext in reactive state.
  void keyRevision.value;
  try {
    return !!readCiphertext(apiKeyLocation(accountId, engine));
  } catch {
    return false;
  }
}

export async function readTranslationApiKey(account: TranslationAccount, engine: CloudTranslationEngine) {
  const location = apiKeyLocation(account.id, engine);
  try {
    const ciphertext = readCiphertext(location);
    if (!ciphertext) return;
    const value = await openPrivate<unknown>(account.secrets, location, ciphertext);
    if (typeof value === 'string' && isSelectionTranslationApiKey(value)) return value;
  } catch {
    throw Error('无法读取已保存的 API Key，请重新保存。');
  }
  throw Error('无法读取已保存的 API Key，请重新保存。');
}

export async function saveTranslationApiKey(
  account: TranslationAccount,
  engine: CloudTranslationEngine,
  apiKey: string,
) {
  const value = apiKey.trim();
  if (!isSelectionTranslationApiKey(value)) throw Error('请输入有效的 API Key。');
  const location = apiKeyLocation(account.id, engine);
  const previous = localStorage.getItem(location);
  const write = Symbol();
  pendingWrites.set(location, write);
  try {
    const ciphertext = await sealPrivate(account.secrets, location, value);
    if (pendingWrites.get(location) !== write || localStorage.getItem(location) !== previous)
      throw Error('API Key 已更新，请重试。');
    localStorage.setItem(location, JSON.stringify(ciphertext));
    keyRevision.value++;
  } finally {
    if (pendingWrites.get(location) === write) pendingWrites.delete(location);
  }
}

export function clearTranslationApiKey(accountId: string, engine: CloudTranslationEngine) {
  const location = apiKeyLocation(accountId, engine);
  localStorage.removeItem(location);
  pendingWrites.delete(location);
  keyRevision.value++;
}
