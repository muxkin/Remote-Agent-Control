import type { Nodes, Parent, PhrasingContent, Root } from 'mdast';
import type { ElementContent } from 'hast';

/** Give existing Unicode chemical subscripts consistent typography without guessing ASCII formulas. */
export function remarkChemicalFormulas() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      const children: Nodes[] = [];
      for (const node of parent.children) {
        if (node.type !== 'text' || (node.data && 'hName' in node.data)) {
          if ('children' in node) visit(node);
          children.push(node);
          continue;
        }
        let offset = 0;
        for (const match of node.value.matchAll(/(?:[A-Z][a-z]?[₀-₉]*){2,}/gu)) {
          if (!/[₀-₉]/u.test(match[0])) continue;
          if (match.index > offset)
            children.push({ type: 'text', value: node.value.slice(offset, match.index) });
          const parts: ElementContent[] = match[0]
            .split(/([₀-₉]+)/u)
            .filter(Boolean)
            .map((part) =>
              /^[₀-₉]+$/u.test(part)
                ? {
                    type: 'element',
                    tagName: 'sub',
                    properties: {},
                    children: [
                      {
                        type: 'text',
                        value: [...part].map((c) => String(c.charCodeAt(0) - 0x2080)).join(''),
                      },
                    ],
                  }
                : { type: 'text', value: part },
            );
          children.push({
            type: 'text',
            value: match[0],
            data: { hName: 'span', hProperties: { className: ['chemical-formula'] }, hChildren: parts },
          });
          offset = match.index + match[0].length;
        }
        if (offset < node.value.length) children.push({ ...node, value: node.value.slice(offset) });
      }
      parent.children = children as PhrasingContent[];
    };
    visit(tree);
  };
}
