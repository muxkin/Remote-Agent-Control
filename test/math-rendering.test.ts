import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
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
  return renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkMath, remarkChemicalFormulas],
      rehypePlugins: [[rehypeKatex, { trust: false }]],
      children: markdownSource(source),
    }),
  );
}
it('renders both scripts, fractions and equation tags with the current KaTeX classes', () => {
  const html = render(String.raw`\[ E_D^{\mathrm{sc}} = \frac{a_1}{b_2} \tag{1} \]`);
  expect(html).toContain('katex-sizing reset-size6 size3');
  expect(html).toContain('katex-tag');
  expect(html).toContain('<msubsup>');
  expect(html).toContain('<mfrac>');
  expect(html).not.toContain('class="sizing ');
});
it('typesets existing chemical subscripts but preserves code, ASCII prose and TeX', () => {
  const html = render('Al₇Cu₅Sc–Al₂Cu–Al₃Sc and Al7Cu5Sc. `Al₇Cu₅Sc`\n\n```\nAl₇Cu₅Sc\n```\n\n$Al_7Cu_5Sc$');
  expect(html.match(/class="chemical-formula"/g)).toHaveLength(3);
  expect(html).toContain('Al<sub>7</sub>Cu<sub>5</sub>Sc');
  expect(html).toContain('and Al7Cu5Sc.');
  expect(html).toContain('<code>Al₇Cu₅Sc</code>');
  expect(html).toContain('<pre><code>Al₇Cu₅Sc\n</code></pre>');
});
