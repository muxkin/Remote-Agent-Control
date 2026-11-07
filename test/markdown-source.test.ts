import { expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import { markdownSource } from '../src/shared/markdown-source';

function mathNodes(source: string) {
  const tree = unified().use(remarkParse).use(remarkMath).parse(markdownSource(source));
  const math: { value: string; parent: string }[] = [];
  const walk = (node: any, parent = '') => {
    if (node.type === 'math' || node.type === 'inlineMath') math.push({ value: node.value, parent });
    for (const child of node.children ?? []) walk(child, node.type);
  };
  walk(tree);
  return math;
}
it('keeps quoted display formulas in the quote without leaking quote markers into TeX', () => {
  const source = String.raw`> Conventional-cell defect formation energy:
>
> \[
> E_{\mathrm d}^{\mathrm{uc}}
> = E_D^{\mathrm{uc}} - E_0^{\mathrm{uc}}
> - \sum_i \Delta N_i \mu_i.
> \]
>
> Here, \(E_D\) is the defective-cell energy.`;
  expect(mathNodes(source)).toEqual([
    {
      value: String.raw`E_{\mathrm d}^{\mathrm{uc}}
= E_D^{\mathrm{uc}} - E_0^{\mathrm{uc}}
- \sum_i \Delta N_i \mu_i.`,
      parent: 'blockquote',
    },
    { value: 'E_D', parent: 'paragraph' },
  ]);
});
it('preserves greater-than operators and nested quotes, including single-line display math', () => {
  expect(mathNodes(String.raw`> > \[x > 0\]`)).toEqual([{ value: 'x > 0', parent: 'blockquote' }]);
  expect(mathNodes(String.raw`Before \[x > 0\] after`)).toEqual([{ value: 'x > 0', parent: 'root' }]);
  expect(mathNodes('> $$\n> x > 0\n> $$')).toEqual([{ value: 'x > 0', parent: 'blockquote' }]);
});
it('does not interpret LaTeX examples in inline, fenced or still-streaming code', () => {
  for (const code of [String.raw`\[x > 0\]`, String.raw`\(x > 0\)`]) {
    for (const source of [
      '`' + code + '`',
      '`` a ` ' + code + ' ``',
      '```tex\n' + code + '\n```',
      '~~~tex\n' + code + '\n~~~',
      '> ```tex\n> ' + code + '\n> ```',
      '```tex\n' + code,
    ]) {
      expect(markdownSource(source)).toBe(source);
      expect(mathNodes(source)).toEqual([]);
    }
  }
});
