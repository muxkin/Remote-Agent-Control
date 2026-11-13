import { expect, type Page, type Route } from '@playwright/test';
import { join } from 'node:path';

export const customTranslationFixture = 'Thermal expansion changes the lattice spacing.';
const connectionSample = 'The lattice parameter increases with temperature.';
const connectionTranslation = '晶格参数随温度升高而增大。';
const chatTranslation = '热膨胀会改变晶格间距。';

export async function verifyTranslationSettings(page: Page, workspaceUrl: string, screenshots: string) {
  const apiKey = 'sk-test-selection-translation-fixture';
  const niutransKey = 'test-niutrans-selection-translation-fixture';
  const model = 'deepseek-v4-pro';
  const provider = { id: 'deepseek', apiKey, model };
  const endpoint = '**/api/im/translation';
  const submitted: unknown[] = [];
  const viewport = page.viewportSize()!;
  const setting = page.getByRole('switch', { name: '启用划词翻译' });
  const auto = page.getByRole('radio', { name: /^自动选择/ });
  const deepseek = page.getByRole('radio', { name: /^DeepSeek/ });
  const niutrans = page.getByRole('radio', { name: /^小牛翻译/ });
  const key = page.getByLabel('API Key', { exact: true });
  const savedKey = page.getByText('API Key 已保存', { exact: true });
  const modelSelect = page.getByLabel('模型', { exact: true });
  const save = page.getByRole('button', { name: '保存配置', exact: true });
  const back = page.getByRole('button', { name: '返回', exact: true });
  const trigger = page.getByRole('button', { name: '翻译', exact: true });
  const dialog = page.getByRole('dialog', { name: '划词翻译' });
  const confirm = dialog.getByRole('button', { name: '使用 DeepSeek 翻译', exact: true });

  const handleRoute = async (route: Route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { available: false } });
    const body = request.postDataJSON();
    submitted.push(body);
    return route.fulfill({
      json: { translatedText: body.text === connectionSample ? connectionTranslation : chatTranslation },
    });
  };

  async function selectFixture() {
    const message = page
      .locator('[data-selection-translation]')
      .getByText(customTranslationFixture, { exact: true });
    await message.scrollIntoViewIfNeeded();
    await message.evaluate(async (element) => {
      getSelection()!.selectAllChildren(element);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
  }

  await page.route(endpoint, handleRoute);
  try {
    await page.getByRole('button', { name: '返回会话列表' }).click();
    await page
      .getByRole('navigation', { name: '主要功能' })
      .getByRole('button', { name: '我的', exact: true })
      .click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: /^外观/ }).click();
    await page.getByLabel('浅色', { exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'light');
    await back.click();
    await page.getByRole('button', { name: /^划词翻译/ }).click();
    await expect(page.getByRole('heading', { name: '划词翻译', exact: true })).toBeVisible();
    await expect(setting).toBeChecked();
    await expect(auto).toBeChecked();
    const settingsUrl = page.url();
    await setting.click();
    await expect(setting).not.toBeChecked();
    await page.reload();
    await expect(setting).not.toBeChecked();
    await page.goto(workspaceUrl);
    await selectFixture();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(customTranslationFixture);
    await expect(trigger).toHaveCount(0);
    expect(submitted).toEqual([]);

    await page.goto(settingsUrl);
    await expect(setting).not.toBeChecked();
    await setting.click();
    await expect(setting).toBeChecked();
    await deepseek.check();
    await expect(modelSelect).toHaveValue('deepseek-flash');
    await modelSelect.selectOption(model);
    await expect(key).toHaveAttribute('type', 'password');
    await key.fill(apiKey);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect.poll(() => submitted).toEqual([{ text: connectionSample, targetLanguage: 'zh', provider }]);
    await expect(page.getByRole('status')).toContainText('连接成功');
    await expect(savedKey).toHaveCount(0);
    await save.click();
    await expect(savedKey).toBeVisible();
    await expect(key).toHaveValue('');
    await page.reload();
    await expect(setting).toBeChecked();
    await expect(deepseek).toBeChecked();
    await expect(modelSelect).toHaveValue(model);
    await expect(savedKey).toBeVisible();
    const stored = await page.evaluate((secret) => {
      const entries = Object.entries(localStorage);
      const encrypted = entries.filter(([name]) => name.startsWith('pocket:selection-translation-key:v1:'));
      return {
        plaintext: JSON.stringify(entries).includes(secret),
        credentials: encrypted.map(([, value]) => Object.keys(JSON.parse(value)).sort()),
      };
    }, apiKey);
    expect(stored).toEqual({ plaintext: false, credentials: [['data', 'iv']] });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: join(screenshots, 'translation-settings-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(screenshots, 'translation-settings-mobile.png') });
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshots, 'translation-settings-mobile-config.png') });
    await back.click();
    await page.getByRole('button', { name: /^外观/ }).click();
    await page.getByLabel('深色', { exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto(settingsUrl);
    await expect(setting).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: join(screenshots, 'translation-settings-mobile-dark.png') });
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshots, 'translation-settings-mobile-dark-config.png') });
    await page.setViewportSize(viewport);

    await page.goto(workspaceUrl);
    await selectFixture();
    await expect(trigger).toBeVisible();
    expect(submitted).toHaveLength(1);
    await trigger.click();
    await expect(confirm).toBeEnabled();
    expect(submitted).toHaveLength(1);
    await confirm.click();
    await expect(dialog.getByText(chatTranslation, { exact: true })).toBeVisible();
    expect(submitted).toEqual([
      { text: connectionSample, targetLanguage: 'zh', provider },
      { text: customTranslationFixture, targetLanguage: 'zh', provider },
    ]);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto(settingsUrl);
    await niutrans.check();
    await expect(page.getByRole('heading', { name: '小牛翻译 配置', exact: true })).toBeVisible();
    await expect(modelSelect).toHaveCount(0);
    await expect(savedKey).toHaveCount(0);
    await key.fill(niutransKey);
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('连接成功');
    expect(submitted.at(-1)).toEqual({
      text: connectionSample,
      targetLanguage: 'zh',
      provider: { id: 'niutrans', apiKey: niutransKey },
    });
    await save.click();
    await expect(savedKey).toBeVisible();
    await deepseek.check();
    await expect(savedKey).toBeVisible();
    await expect(modelSelect).toHaveValue(model);
    expect(
      await page.evaluate(
        (secret) => JSON.stringify(Object.entries(localStorage)).includes(secret),
        niutransKey,
      ),
    ).toBe(false);

    await page.goto(workspaceUrl);
    await selectFixture();
    await trigger.click();
    await expect(confirm).toBeEnabled();
    const settingsTab = await page.context().newPage();
    try {
      await settingsTab.goto(settingsUrl);
      await settingsTab.getByRole('radio', { name: /^小牛翻译/ }).check();
      await expect(dialog).toHaveCount(0);
      expect(submitted).toHaveLength(3);
    } finally {
      await settingsTab.close();
    }
  } finally {
    await page.unroute(endpoint, handleRoute);
    await page.setViewportSize(viewport);
  }
}
