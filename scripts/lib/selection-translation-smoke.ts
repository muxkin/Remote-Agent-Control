import { expect, type Locator, type Page, type Route } from '@playwright/test';

const endpoint = '**/api/im/translation';
const selected = 'The lattice parameter increases with temperature.';
export const selectionTranslationFixture = `实验结果如下。 ${selected} 后续将比较热膨胀系数。`;
const translated = '晶格参数随温度升高而增大。';

async function selectPhrase(paragraph: Locator) {
  await paragraph.evaluate((el, selection) => {
    const text = el.firstChild as Text;
    const offset = text.data.indexOf(selection);
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + selection.length);
    const active = getSelection()!;
    active.removeAllRanges();
    active.addRange(range);
  }, selected);
}

async function expectBottomSheet(dialog: Locator) {
  await expect
    .poll(() =>
      dialog.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft ?? 0;
        const width = viewport?.width ?? innerWidth;
        const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight);
        return (
          el.matches(':modal') &&
          Math.abs(rect.left - left) <= 2 &&
          Math.abs(rect.width - width) <= 2 &&
          Math.abs(rect.bottom - bottom) <= 2 &&
          el.scrollWidth <= el.clientWidth
        );
      }),
    )
    .toBe(true);
}

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
    { selected, translated },
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
    const selection = await page.evaluate(() =>
      getSelection()!.getRangeAt(0).getBoundingClientRect().toJSON(),
    );
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-trigger.png') });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: '划词翻译' });
    await expect(dialog.getByLabel('目标语言')).toHaveValue('zh');
    await expect(dialog.getByText(translated, { exact: true })).toBeVisible();
    await expect(dialog.getByText('设备内翻译', { exact: true })).toBeVisible();
    expect(
      await dialog.evaluate((el, range) => {
        const rect = el.getBoundingClientRect();
        return (
          !el.matches(':modal') &&
          rect.left <= range.right &&
          rect.right >= range.left &&
          Math.min(Math.abs(rect.bottom - range.top), Math.abs(rect.top - range.bottom)) <= 18 &&
          rect.top >= 0 &&
          rect.bottom <= innerHeight &&
          rect.left >= 0 &&
          rect.right <= innerWidth
        );
      }, selection),
    ).toBe(true);
    expect(await page.evaluate(() => CSS.highlights?.has('selection-translation') ?? true)).toBe(true);
    expect(
      await dialog
        .locator('.selection-translation-body')
        .evaluate((el) => el.scrollHeight <= el.clientHeight),
    ).toBe(true);
    await page.screenshot({ path: screenshot });
    await dialog.getByRole('button', { name: '复制译文', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(translated);
    await expect(dialog.getByRole('status').filter({ hasText: /^已复制$/ })).toBeAttached();
    expect(requests).toEqual([]);
    await page.screenshot({ path: screenshot.replace(/\.png$/, '-copied.png') });
    const otherDialog = await page.evaluateHandle(() => {
      const dialog = document.createElement('dialog');
      document.body.append(dialog);
      dialog.showModal();
      return dialog;
    });
    try {
      await page.keyboard.press('Escape');
      await expect.poll(() => otherDialog.evaluate((el) => el.open)).toBe(false);
      await expect(dialog).toBeVisible();
    } finally {
      await otherDialog.evaluate((el) => el.remove());
      await otherDialog.dispose();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => CSS.highlights?.has('selection-translation') ?? false)).toBe(false);

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
    return route.fulfill({ json: { translatedText: translated } });
  };
  const trigger = page.getByRole('button', { name: '翻译', exact: true });
  const dialog = page.getByRole('dialog', { name: '划词翻译' });
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  const readingPosition = () => paragraph.evaluate((el) => el.closest('.im-transcript')!.scrollTop);
  await page.route(endpoint, handleRoute);
  try {
    await paragraph.scrollIntoViewIfNeeded();
    await paragraph.tap();
    await selectPhrase(paragraph);
    await expect(trigger).toBeVisible();
    expect(
      await trigger.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
      }),
    ).toBe(true);
    expect(submitted).toEqual([]);
    const previousScrollTop = await readingPosition();
    await trigger.tap();
    const language = dialog.getByLabel('目标语言');
    const site = dialog.getByRole('button', { name: '使用站点翻译', exact: true });
    await expect(site).toBeEnabled();
    await expectBottomSheet(dialog);
    await expect(language).toHaveValue('zh');
    await language.selectOption('en');
    await expect(language).toHaveValue('en');
    await expect(site).toBeEnabled();
    await language.selectOption('zh');
    await expect(site).toBeEnabled();
    expect(submitted).toEqual([]);
    await site.click();
    await expect(dialog.getByText(translated, { exact: true })).toBeVisible();
    await expect(dialog.getByText('站点翻译', { exact: true })).toBeVisible();
    expect(submitted).toEqual([{ text: selected, targetLanguage: 'zh' }]);
    await expect
      .poll(() =>
        dialog.evaluate((el) => {
          const highlights = CSS.highlights;
          if (!highlights) return true;
          const range = [...(highlights.get('selection-translation') ?? [])][0];
          if (!(range instanceof Range)) return false;
          const rect = range.getBoundingClientRect();
          const scroll = range.startContainer.parentElement!.closest('.im-transcript')!;
          return (
            rect.height > 0 &&
            rect.top >= scroll.getBoundingClientRect().top &&
            rect.bottom <= el.getBoundingClientRect().top
          );
        }),
      )
      .toBe(true);
    await page.screenshot({ path: screenshot });
    const viewport = page.viewportSize()!;
    try {
      await page.setViewportSize({ ...viewport, width: 320 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
      await expectBottomSheet(dialog);
      await expect(dialog.getByText(translated, { exact: true })).toBeVisible();
      await page.screenshot({ path: screenshot.replace(/\.png$/, '-dark.png') });
    } finally {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: null });
    }
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(readingPosition).toBe(previousScrollTop);

    available = false;
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await expect(trigger).toHaveCount(0);
    await selectPhrase(paragraph);
    await trigger.tap();
    const external = dialog.getByRole('link', { name: '在 Google 翻译中打开', exact: true });
    const url = new URL((await external.getAttribute('href'))!);
    expect(url.hostname).toBe('translate.google.com');
    expect(url.searchParams.get('text')).toBe(selected);
    expect(url.searchParams.get('tl')).toBe('zh-CN');
    expect(submitted).toHaveLength(1);
    await close.click();
  } finally {
    await page.unroute(endpoint, handleRoute);
  }
}
