import { computed } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSecrets } from '../src/shared/account-crypto';

function storageFixture() {
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  };
  const window = new EventTarget();
  vi.stubGlobal('window', window);
  vi.stubGlobal('localStorage', localStorage);
  return {
    entries,
    localStorage,
    refresh(key: string | null) {
      window.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: localStorage }));
    },
  };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it('defaults to the existing automatic behavior and validates persisted settings', async () => {
  const { entries, localStorage, refresh } = storageFixture();
  const { translationSettings, updateTranslationSettings } =
    await import('../src/web/selection-translation-settings');
  expect(translationSettings.value).toEqual({
    enabled: true,
    engine: 'automatic',
    deepseekModel: 'deepseek-flash',
  });
  updateTranslationSettings({ enabled: false, engine: 'deepseek', deepseekModel: 'deepseek-v4-pro' });
  const [key] = entries.keys();
  expect(JSON.parse(entries.get(key)!)).toEqual(translationSettings.value);
  localStorage.setItem(key, JSON.stringify({ enabled: false, engine: 'unknown', deepseekModel: 'retired' }));
  refresh(key);
  expect(translationSettings.value).toEqual({
    enabled: false,
    engine: 'automatic',
    deepseekModel: 'deepseek-flash',
  });
  localStorage.setItem(key, '{invalid');
  refresh(key);
  expect(translationSettings.value.enabled).toBe(true);
});

it('preserves the active configuration when the browser refuses a storage write', async () => {
  const { localStorage } = storageFixture();
  const { translationSettings, updateTranslationSettings } =
    await import('../src/web/selection-translation-settings');
  localStorage.setItem = () => {
    throw Error('storage full');
  };
  expect(() => updateTranslationSettings({ ...translationSettings.value, enabled: false })).toThrow(
    'storage full',
  );
  expect(translationSettings.value.enabled).toBe(true);
});

it('stores independently encrypted keys by account and provider, and tracks storage changes', async () => {
  const { entries, localStorage, refresh } = storageFixture();
  const { hasTranslationApiKey, readTranslationApiKey, saveTranslationApiKey, clearTranslationApiKey } =
    await import('../src/web/selection-translation-settings');
  const account = { id: 'fixture-account', secrets: await createSecrets() };
  const other = { id: 'fixture-other', secrets: await createSecrets() };
  const deepSeekKey = 'synthetic-ds-fixture-key';
  const niuTransKey = 'synthetic-niu-fixture-key';
  const hasKey = computed(() => hasTranslationApiKey(account.id, 'deepseek'));
  expect(hasKey.value).toBe(false);
  await saveTranslationApiKey(account, 'deepseek', ` ${deepSeekKey} `);
  expect(hasKey.value).toBe(true);
  expect(hasTranslationApiKey(account.id, 'niutrans')).toBe(false);
  expect(hasTranslationApiKey(other.id, 'deepseek')).toBe(false);
  await saveTranslationApiKey(account, 'niutrans', niuTransKey);
  expect([...entries.values()].join()).not.toContain(deepSeekKey);
  expect([...entries.values()].join()).not.toContain(niuTransKey);
  expect(await readTranslationApiKey(account, 'deepseek')).toBe(deepSeekKey);
  expect(await readTranslationApiKey(account, 'niutrans')).toBe(niuTransKey);
  expect(await readTranslationApiKey(other, 'deepseek')).toBeUndefined();
  await expect(readTranslationApiKey({ ...other, id: account.id }, 'deepseek')).rejects.toThrow(
    '无法读取已保存的 API Key',
  );

  const deepSeekLocation = [...entries.keys()].find((key) => key.endsWith(':deepseek'))!;
  const niuTransLocation = [...entries.keys()].find((key) => key.endsWith(':niutrans'))!;
  localStorage.setItem(niuTransLocation, entries.get(deepSeekLocation)!);
  await expect(readTranslationApiKey(account, 'niutrans')).rejects.toThrow('无法读取已保存的 API Key');
  localStorage.setItem(deepSeekLocation, JSON.stringify({ key: deepSeekKey }));
  refresh(deepSeekLocation);
  expect(hasKey.value).toBe(false);
  expect(await readTranslationApiKey(account, 'deepseek')).toBeUndefined();
  localStorage.removeItem(deepSeekLocation);
  refresh(deepSeekLocation);
  clearTranslationApiKey(account.id, 'niutrans');
  expect(entries.size).toBe(0);
});

it('does not restore a key if it is removed before encryption finishes', async () => {
  storageFixture();
  const { hasTranslationApiKey, saveTranslationApiKey, clearTranslationApiKey } =
    await import('../src/web/selection-translation-settings');
  const account = { id: 'fixture-account', secrets: await createSecrets() };
  const saving = saveTranslationApiKey(account, 'deepseek', 'synthetic-fixture');
  clearTranslationApiKey(account.id, 'deepseek');
  await expect(saving).rejects.toThrow('API Key 已更新');
  expect(hasTranslationApiKey(account.id, 'deepseek')).toBe(false);
});
