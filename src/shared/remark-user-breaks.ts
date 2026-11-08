type Node = { type: string; value?: string; children?: Node[] };
/** Treat user-entered soft line endings as breaks, without touching code/math nodes. */
export function remarkUserBreaks() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      if (!node.children || node.type === 'code' || node.type === 'inlineCode') return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value?.includes('\n')) {
          return child.value
            .split(/\r?\n/)
            .flatMap((value, index) =>
              index ? [{ type: 'break' }, { type: 'text', value }] : [{ type: 'text', value }],
            );
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}
