import { expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { attachmentName, attachmentPath, remarkFileCitations } from '../src/shared/attachments';
import { attachmentLinks } from '../src/server/media';

it.each(
  [':', '::'].flatMap((prefix) =>
    ['docx', 'xlsx', 'pdf', 'tar.gz', 'txt', 'custom'].map((extension) => [prefix, extension]),
  ),
)('recognizes %s native citations for %s files, including Chinese names and spaces', (prefix, extension) => {
  const name = `结果 修正版.${extension}`;
  const path = `/home/user/${name}`;
  const source = `下载：${prefix}codex-file-citation{path="${path}" purpose="output"}。`;
  const markdown = unified().use(remarkParse).use(remarkFileCitations);
  const tree = markdown.runSync(markdown.parse(source)) as any;
  expect(tree.children[0].children).toEqual([
    { type: 'text', value: '下载：' },
    {
      type: 'link',
      url: path,
      children: [{ type: 'text', value: name }],
      data: { hProperties: { 'data-file-citation': 'true' } },
    },
    { type: 'text', value: '。' },
  ]);
  expect(attachmentLinks(source)).toEqual([path]);
  expect(attachmentName('C:\\研究\\结果.docx')).toBe('结果.docx');
  expect(attachmentPath(encodeURI(path))).toBe(path);
  expect(attachmentPath(`file://${encodeURI(path)}`)).toBe(path);
});

it('leaves code, HTML, unsafe schemes and incomplete file citations inert', () => {
  const directive = ':codex-file-citation{path="/private/document.docx" purpose="output"}';
  for (const source of [
    `\`${directive}\``,
    `\`\`\`text\n${directive}\n\`\`\``,
    `<div>\n${directive}\n</div>`,
    ':codex-file-citation{path="javascript:alert(1)"}',
    ':codex-file-citation{path="https://example.com/file.docx"}',
    ':codex-file-citation{path="/private/document.docx"',
    ':codex-file-citation{path="/one.docx" path="/two.docx"}',
  ])
    expect(attachmentLinks(source)).toEqual([]);
  expect(attachmentLinks(`[${directive}](https://example.com)`)).toEqual(['https://example.com']);
});
