import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { renderMarkdown } from '../src/web/markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { markdownSource } from '../src/shared/markdown-source';
import { remarkChemicalFormulas } from '../src/shared/chemical-formulas';

it('uses the same KaTeX renderer and stylesheet version, including diagram math', () => {
  const require = createRequire(import.meta.url);
  const expected = require('katex').version;
  for (const consumer of ['rehype-katex', 'mermaid', 'micromark-extension-math']) {
    expect(createRequire(require.resolve(consumer))('katex').version).toBe(expected);
  }
});
function render(source: string) {
  return renderToString(
    createSSRApp({
      render: () =>
        renderMarkdown(markdownSource(source), {
          remarkPlugins: [remarkMath, remarkChemicalFormulas],
          rehypePlugins: [[rehypeKatex, { trust: false }]],
        }),
    }),
  );
}
it('renders both scripts, fractions and equation tags with the current KaTeX classes', async () => {
  const html = await render(String.raw`\[ E_D^{\mathrm{sc}} = \frac{a_1}{b_2} \tag{1} \]`);
  expect(html).toContain('katex-sizing reset-size6 size3');
  expect(html).toContain('katex-tag');
  expect(html).toContain('<msubsup>');
  expect(html).toContain('<mfrac>');
  expect(html).not.toContain('class="sizing ');
});
it('typesets existing chemical subscripts but preserves code, ASCII prose and TeX', async () => {
  const html = await render(
    'Al₇Cu₅Sc–Al₂Cu–Al₃Sc and Al7Cu5Sc. `Al₇Cu₅Sc`\n\n```\nAl₇Cu₅Sc\n```\n\n$Al_7Cu_5Sc$',
  );
  expect(html.match(/class="chemical-formula"/g)).toHaveLength(3);
  expect(html).toContain('Al<sub>7</sub>Cu<sub>5</sub>Sc');
  expect(html).toContain('and Al7Cu5Sc.');
  expect(html).toContain('<code>Al₇Cu₅Sc</code>');
  expect(html).toContain('<pre><code>Al₇Cu₅Sc\n</code></pre>');
});

it('escapes raw HTML and filters unsafe Markdown URLs', async () => {
  const html = await render('<img src=x onerror="alert(1)">\n\n[example](javascript:alert%281%29)');
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img');
  expect(html).toMatch(/<a href(?:="")?>example<\/a>/);
  expect(html).not.toContain('href="javascript:');
});
