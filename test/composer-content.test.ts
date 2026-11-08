import { expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { clipboardFiles } from '../src/web/clipboard-files';
import { remarkUserBreaks } from '../src/shared/remark-user-breaks';

it('pastes all file types and multiple files without duplicating FileList and items', () => {
  const files = [
    new File(['pdf'], '研究.pdf', { type: 'application/pdf' }),
    new File(['zip'], 'archive.zip'),
    new File(['image'], 'image.png', { type: 'image/png' }),
  ];
  const items = files.map((file) => ({ kind: 'file', getAsFile: () => file }));
  expect(clipboardFiles({ files, items } as unknown as DataTransfer)).toEqual(files);
  expect(
    clipboardFiles({
      files: [],
      items: [...items, { kind: 'string' }, { kind: 'file', getAsFile: () => null }],
    } as unknown as DataTransfer),
  ).toEqual(files);
  expect(clipboardFiles({ files: [], items: [{ kind: 'string' }] } as unknown as DataTransfer)).toEqual([]);
});

it('keeps user line breaks and markdown structure while leaving fenced code unchanged', () => {
  const processor = unified().use(remarkParse).use(remarkUserBreaks);
  const tree = processor.runSync(
    processor.parse('第一行\n**第二行**\n第三行\n\n- 列表\n  续行\n\n```sh\necho one\necho two\n```'),
  );
  const nodes: any[] = [];
  const walk = (node: any) => {
    nodes.push(node);
    node.children?.forEach(walk);
  };
  walk(tree);
  expect(nodes.filter((node) => node.type === 'break')).toHaveLength(3);
  expect(nodes.find((node) => node.type === 'code')?.value).toBe('echo one\necho two');
  expect(nodes.some((node) => node.type === 'strong')).toBe(true);
  expect(nodes.some((node) => node.type === 'list')).toBe(true);
});
