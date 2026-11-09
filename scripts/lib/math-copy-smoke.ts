import { expect, type Locator, type Page } from '@playwright/test';

const inline = String.raw`E=mc^2`;
const display = [
  String.raw`\begin{aligned}`,
  String.raw`  a &= b \\`,
  String.raw`  c &= d`,
  String.raw`\end{aligned}`,
].join('\n');
export const mathCopyFixture = [
  `起始 前文 **加粗** \\(${inline}\\) 后文。`,
  `\\[\n${display}\n\\]`,
  '末段 截止 余文',
].join('\n\n');

export async function verifyMathCopy(page: Page, message: Locator) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  const inlineFormula = message.locator('.katex[data-math-copy]');
  const displayFormula = message.locator('.katex-display[data-math-copy]');
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await expect(inlineFormula).toHaveCount(1);
  await expect(displayFormula).toHaveCount(1);
  await expect(message.locator('[data-math-copy] button')).toHaveCount(0);
  await expect(inlineFormula).toHaveCSS('cursor', 'copy');
  if (await page.evaluate(() => matchMedia('(hover: hover)').matches)) {
    await inlineFormula.hover();
    await expect(inlineFormula).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await inlineFormula.click();
  await expect.poll(clipboard).toBe(inline);
  await expect(inlineFormula).toHaveAttribute('data-math-copy-state', 'copied');

  // Click inside the display row, outside the centered equation glyphs.
  await displayFormula.click({ position: { x: 8, y: 8 } });
  await expect.poll(clipboard).toBe(display);
  await inlineFormula.focus();
  await page.keyboard.press('Enter');
  await expect.poll(clipboard).toBe(inline);

  const first = message.locator('.markdown-paragraph').filter({ hasText: '起始 前文' });
  await first.scrollIntoViewIfNeeded();
  const last = message.getByText('末段 截止 余文', { exact: true });
  await last.scrollIntoViewIfNeeded();
  const caret = (locator: Locator, offset: number) =>
    locator.evaluate((el, index) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, index);
      range.collapse(true);
      const box = range.getBoundingClientRect();
      return { x: box.x, y: box.y + box.height / 2 };
    }, offset);
  const from = await caret(first, 3);
  const to = await caret(last, 5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
  await expect.poll(clipboard).toBe(inline); // Dragging must not run click-to-copy.
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(clipboard).toBe(`前文 加粗 $${inline}$ 后文。\n\n$$\n${display}\n$$\n\n末段 截止`);

  // Reverse selection starting and ending within rendered glyphs still copies whole equations.
  const originalSelection = await message.evaluate((el) => {
    const inlineGlyph = el.querySelector('.katex[data-math-copy] .katex-html .mord')!.firstChild!;
    const displayGlyph = el.querySelector('.katex-display .katex-html .mord')!.firstChild!;
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(displayGlyph, 0, inlineGlyph, 0);
    return selection.toString();
  });
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(clipboard).toBe(`$${inline}$ 后文。\n\n$$\n${display}\n$$`);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(originalSelection);

  await last.evaluate((el) => window.getSelection()?.selectAllChildren(el));
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(clipboard).toBe('末段 截止 余文');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}
