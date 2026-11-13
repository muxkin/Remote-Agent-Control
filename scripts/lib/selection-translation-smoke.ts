import { expect, type Locator, type Page, type Route } from '@playwright/test';

const endpoint = '**/api/im/translation';
const selected = 'Verify material selection here.';
export const selectionTranslationFixture = `Start ${selected} End`;
const localTranslation = '请在这里确认材料选择。';
const siteTranslation = '请在这里核对材料选择。';

export async function verifyOnDeviceSelectionTranslation(
  page: Page,
  paragraph: Locator,
  composer: Locator,
  screenshot: string,
) {
  await page.evaluate(
    ({ selected, translated }) => {
      Object.defineProperty(window, 'LanguageDetector', { configurable: true, value: undefined });
      Object.defineProperty(window, 'Translator', {
        configurable: true,
        value: {
          async create({
            sourceLanguage,
            targetLanguage,
          }: {
            sourceLanguage: string;
            targetLanguage: string;
          }) {
            if (sourceLanguage !== 'en' || !targetLanguage.startsWith('zh'))
              throw Error('Unexpected language pair');
            return {
              async translate(text: string) {
                if (text !== selected) throw Error('Unexpected selection');
                return translated;
              },
              destroy() {},
            };
          },
        },
      });
    },
    { selected, translated: localTranslation },
  );
  const requests: string[] = [];
  const handleRoute = (route: Route) => {
    requests.push(route.request().method());
    return route.fulfill({ json: { available: false } });
  };
  await page.route(endpoint, handleRoute);
  try {
    await paragraph.scrollIntoViewIfNeeded();
    const [start, end] = await paragraph.evaluate((el, selection) => {
      const text = el.firstChild as Text;
      const offset = text.data.indexOf(selection);
      return [offset, offset + selection.length].map((index) => {
        const range = document.createRange();
        range.setStart(text, index);
        range.collapse(true);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      });
    }, selected);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
    const trigger = page.getByRole('button', { name: '翻译', exact: true });
    await expect(trigger).toBeVisible();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(selected);
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: '划词翻译' });
    await expect(dialog.getByLabel('目标语言')).toHaveValue('zh');
    await expect(dialog.getByText(localTranslation, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '复制译文', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(localTranslation);
    expect(requests).toEqual([]);
    await page.screenshot({ path: screenshot });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.evaluate(() => getSelection()?.removeAllRanges());
    await composer.fill('Editable translation fixture');
    await composer.selectText();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(trigger).toHaveCount(0);
    await composer.clear();
  } finally {
    await page.unroute(endpoint, handleRoute);
  }
}

export async function verifySiteSelectionTranslation(page: Page, paragraph: Locator, screenshot: string) {
  await page.evaluate(() => {
    Object.defineProperty(window, 'Translator', { configurable: true, value: undefined });
  });
  let available = true;
  const submitted: unknown[] = [];
  const handleRoute = (route: Route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { available } });
    submitted.push(route.request().postDataJSON());
    return route.fulfill({ json: { translatedText: siteTranslation } });
  };
  const trigger = page.getByRole('button', { name: '翻译', exact: true });
  const dialog = page.getByRole('dialog', { name: '划词翻译' });
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  await page.route(endpoint, handleRoute);
  try {
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.tap();
    await paragraph.evaluate((el) => getSelection()?.selectAllChildren(el));
    await expect(trigger).toBeVisible();
    expect(
      await trigger.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      }),
    ).toBe(true);
    expect(submitted).toEqual([]);
    await trigger.tap();
    const language = dialog.getByLabel('目标语言');
    const site = dialog.getByRole('button', { name: '使用站点翻译', exact: true });
    await expect(site).toBeEnabled();
    await expect(language).toHaveValue('zh');
    await language.selectOption('en');
    await expect(language).toHaveValue('en');
    await expect(site).toBeEnabled();
    await language.selectOption('zh');
    await expect(site).toBeEnabled();
    expect(submitted).toEqual([]);
    await site.click();
    await expect(dialog.getByText(siteTranslation, { exact: true })).toBeVisible();
    expect(submitted).toEqual([{ text: selectionTranslationFixture, targetLanguage: 'zh' }]);
    await page.screenshot({ path: screenshot });
    await close.click();
    await expect(dialog).toHaveCount(0);

    available = false;
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await expect(trigger).toHaveCount(0);
    await paragraph.evaluate((el) => getSelection()?.selectAllChildren(el));
    await trigger.tap();
    const external = dialog.getByRole('link', { name: '在 Google 翻译中打开', exact: true });
    const url = new URL((await external.getAttribute('href'))!);
    expect(url.hostname).toBe('translate.google.com');
    expect(url.searchParams.get('text')).toBe(selectionTranslationFixture);
    expect(url.searchParams.get('tl')).toBe('zh-CN');
    expect(submitted).toHaveLength(1);
    await close.click();
  } finally {
    await page.unroute(endpoint, handleRoute);
  }
}
