import type { Element } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { urlAttributes } from 'html-url-attributes';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified, type PluggableList } from 'unified';
import { visit } from 'unist-util-visit';
import { cloneVNode, Fragment, h, isVNode, type VNodeChild } from 'vue';

type MarkdownElement = {
  node?: Element;
  children?: VNodeChild;
  class?: string;
  checked?: boolean;
  src?: string;
  alt?: string;
  href?: string;
};
export type MarkdownComponents = Record<string, (props: MarkdownElement) => VNodeChild>;

export function defaultUrlTransform(url: string) {
  const colon = url.indexOf(':');
  const relative = ['/', '?', '#'].some((separator) => {
    const index = url.indexOf(separator);
    return index !== -1 && colon > index;
  });
  return colon === -1 || relative || /^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon)) ? url : '';
}

export function renderMarkdown(
  source: string,
  {
    remarkPlugins = [],
    rehypePlugins = [],
    components = {},
    urlTransform = defaultUrlTransform,
  }: {
    remarkPlugins?: PluggableList;
    rehypePlugins?: PluggableList;
    components?: MarkdownComponents;
    urlTransform?: (url: string) => string;
  } = {},
) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkPlugins)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins);
  const tree = processor.runSync(processor.parse(source));
  visit(tree, (node, index, parent) => {
    if (node.type === 'raw' && parent && index !== undefined) {
      // Render raw HTML as escaped text, including script or event-handler syntax.
      parent.children[index] = { type: 'text', value: node.value };
    }
    if (node.type !== 'element') return;
    for (const name of Object.keys(node.properties)) {
      if (!Object.hasOwn(urlAttributes, name)) continue;
      const tags = urlAttributes[name];
      if (!tags || tags.includes(node.tagName)) {
        node.properties[name] = urlTransform(String(node.properties[name] ?? ''));
      }
    }
  });
  const render = ((type, { children, ...props }, key) => {
    if (typeof type === 'function') {
      const child = type({ ...props, children }) as VNodeChild;
      if (isVNode(child)) return cloneVNode(child, { key });
      return h(Fragment, { key }, Array.isArray(child) ? child : [child]);
    }
    return h(type, { ...props, key }, children as VNodeChild[]);
  }) as NonNullable<Parameters<typeof toJsxRuntime>[1]['jsx']>;
  return toJsxRuntime(tree, {
    Fragment,
    jsx: render,
    jsxs: render,
    components: components as Parameters<typeof toJsxRuntime>[1]['components'],
    passNode: true,
    elementAttributeNameCase: 'html',
  });
}
