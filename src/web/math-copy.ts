import type { ElementContent, Root } from 'hast';
import { toText } from 'hast-util-to-text';

const marker = 'data-math-copy';
const selector = `[${marker}]`;
const hint = '点击复制 LaTeX';
const annotation = '.katex-mathml annotation[encoding="application/x-tex"]';
const text = (value: string): ElementContent => ({ type: 'text', value });
const element = (tagName: string, children: ElementContent[]): ElementContent => ({
  type: 'element',
  tagName,
  children,
  properties: {},
});

/** Decorate only the outer rendered formula so an equation has one hit area and focus stop. */
export function rehypeMathCopy() {
  return (tree: Root) => {
    function decorate(node: Root | ElementContent) {
      if (node.type === 'element') {
        const classes = node.properties.className;
        if (Array.isArray(classes) && (classes.includes('katex-display') || classes.includes('katex'))) {
          node.properties[marker] = '';
          node.properties.tabIndex = 0;
          node.properties.title = hint;
          return;
        }
      }
      if ('children' in node) {
        for (const child of node.children) if (child.type !== 'doctype') decorate(child);
      }
    }
    decorate(tree);
  };
}

function formulaAt(node: Node | null) {
  return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(selector);
}

const feedback = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
async function copyFormula(formula: HTMLElement, latex: string) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(latex);
    copied = true;
  } catch {
    // The copy event still handles manual selections if direct clipboard access is blocked.
  }
  if (!formula.isConnected) return;
  clearTimeout(feedback.get(formula));
  formula.dataset.mathCopyState = copied ? 'copied' : 'failed';
  formula.title = copied ? '已复制 LaTeX' : '无法直接复制，请选中公式后复制';
  feedback.set(
    formula,
    setTimeout(() => {
      delete formula.dataset.mathCopyState;
      formula.title = hint;
      feedback.delete(formula);
    }, 1600),
  );
}

export function copyFormulaFromEvent(event: MouseEvent | KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (
    event instanceof MouseEvent
      ? event.button !== 0 || event.detail > 1
      : event.key !== 'Enter' && event.key !== ' '
  )
    return;
  if (window.getSelection()?.isCollapsed === false) return;
  const formula = formulaAt(event.target instanceof Node ? event.target : null);
  const latex = formula?.querySelector(annotation)?.textContent;
  if (formula && latex) {
    event.preventDefault();
    void copyFormula(formula, latex);
  }
}

/** Project only selected content. Formulae are atomic; the browser's visible range stays intact. */
function selectedContent(node: Node, range: Range, output: ElementContent[]): boolean {
  if (!range.intersectsNode(node)) return false;
  if (node instanceof Text) {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (start < end) output.push(text(node.data.slice(start, end)));
    return false;
  }
  if (!(node instanceof HTMLElement) || node.matches('[hidden], .sr-only')) return false;
  if (node.hasAttribute(marker)) {
    const latex = node.querySelector(annotation)?.textContent;
    if (latex) {
      // Preserve TeX whitespace, and keep display delimiters on separate lines for Markdown paste.
      output.push(
        node.classList.contains('katex-display')
          ? element('p', [element('pre', [text(`$$\n${latex}\n$$`)])])
          : element('nobr', [text(`$${latex}$`)]),
      );
      return true;
    }
  }
  const children: ElementContent[] = [];
  let containsMath = false;
  for (const child of node.childNodes) {
    if (
      node instanceof HTMLDetailsElement &&
      !node.open &&
      !(child instanceof HTMLElement && child.localName === 'summary')
    )
      continue;
    if (selectedContent(child, range, children)) containsMath = true;
  }
  if (children.length || node.localName === 'br') {
    output.push(element(node.classList.contains('markdown-paragraph') ? 'p' : node.localName, children));
  }
  return containsMath;
}

export function copyMathSelection(event: ClipboardEvent) {
  const selection = window.getSelection();
  if (event.defaultPrevented || !event.clipboardData || !selection || selection.isCollapsed) return;
  if (
    event.target instanceof HTMLElement &&
    (event.target.matches('input, textarea, select') || event.target.isContentEditable)
  )
    return;
  let containsMath = false;
  const parts: Root[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const root = formulaAt(range.commonAncestorContainer) ?? range.commonAncestorContainer;
    const children: ElementContent[] = [];
    if (selectedContent(root, range, children)) containsMath = true;
    parts.push({ type: 'root', children });
  }
  if (!containsMath) return;
  event.clipboardData.setData('text/plain', parts.map((part) => toText(part)).join('\n'));
  event.preventDefault();
}
