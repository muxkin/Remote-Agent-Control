import type { Nodes, Parent, Root, PhrasingContent } from 'mdast';

export const localReference = (url: string) =>
  (url.startsWith('/') && !url.startsWith('//')) ||
  /^[a-z]:[\\/]/i.test(url) ||
  ['dsh-image:', 'dsh-file:', 'file:', 'sandbox:', './', '../', 'pocket-inline:'].some((prefix) =>
    url.startsWith(prefix),
  );

export function attachmentPath(reference: string) {
  let path = reference.replace(/^sandbox:/, '');
  if (path.startsWith('file:')) {
    try {
      path = new URL(path).pathname.replace(/^\/([a-z]:\/)/i, '$1');
    } catch {
      /* Keep the reference. */
    }
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
export function attachmentName(path: string) {
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* Keep malformed references readable. */
    }
  }
  return (
    attachmentPath(path)
      .replace(/:\d+(?::\d+)?$/, '')
      .split(/[\\/]/)
      .at(-1) || '附件'
  );
}
type FileFormat = {
  extensions: string;
  kind: string;
  media?: 'image' | 'video' | 'audio';
  previewable?: boolean;
};
const imageFormat: FileFormat = {
  extensions: 'png jpg jpeg gif webp avif svg bmp ico',
  kind: '图片',
  media: 'image',
  previewable: true,
};
const fileFormats: FileFormat[] = [
  imageFormat,
  { extensions: 'mp4 webm mov m4v', kind: '视频', media: 'video' },
  { extensions: 'mp3 wav ogg m4a flac', kind: '音频', media: 'audio' },
  { extensions: 'doc docx', kind: 'Word 文档' },
  { extensions: 'xls xlsx ods', kind: '电子表格' },
  { extensions: 'csv tsv', kind: '电子表格', previewable: true },
  { extensions: 'ppt pptx odp', kind: '演示文稿' },
  { extensions: 'pdf', kind: 'PDF 文档', previewable: true },
  { extensions: 'odt', kind: '文档' },
  { extensions: 'zip gz tgz tar 7z rar xz bz2 tar.gz tar.xz tar.bz2', kind: '压缩包' },
  {
    extensions:
      'txt text md markdown log json jsonl yaml yml toml ini py js jsx ts tsx sh sql tex rs c cpp h',
    kind: '文本文件',
    previewable: true,
  },
];
const formatsByExtension = new Map(
  fileFormats.flatMap((format) =>
    format.extensions.split(' ').map((extension) => [extension, format] as const),
  ),
);

// File formats are data, not separate renderers. Messages, drafts and details use this same model.
export function attachmentInfo(path: string, displayName?: string) {
  // Encrypted transport URLs intentionally hide the filename; use the decrypted name for presentation.
  const name = displayName || attachmentName(path);
  const extensionOf = (value: string) =>
    /(?:\.)(tar\.(?:gz|xz|bz2)|[a-z0-9]{1,10})$/i.exec(value)?.[1].toLowerCase();
  const extension = extensionOf(name) ?? extensionOf(attachmentName(path)) ?? '';
  const format = path.startsWith('dsh-image:') ? imageFormat : formatsByExtension.get(extension);
  return {
    name,
    extension,
    kind: format?.kind ?? '文件',
    media: format?.media ?? null,
    previewable: !!format?.previewable,
  };
}

/** Interpret native file citations only in prose, never in code, HTML, or existing links.
 * The server and Markdown UI share this transform so rendered files and authorized paths agree. */
export function remarkFileCitations() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      const children: Nodes[] = [];
      for (const node of parent.children) {
        if (node.type === 'text') {
          const pattern = /:{1,2}codex-file-citation\{([^\n}]*?)\}/g;
          let offset = 0;
          for (const match of node.value.matchAll(pattern)) {
            const attributes = [
              ...match[1].matchAll(/([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g),
            ];
            const paths = attributes.filter((attribute) => attribute[1] === 'path');
            if (paths.length !== 1) continue;
            const path = paths[0][2].slice(1, -1).replace(/\\(["'])/g, '$1');
            if (!localReference(path) || /[\r\n\x00]/.test(path)) continue;
            if (match.index! > offset)
              children.push({ type: 'text', value: node.value.slice(offset, match.index) });
            children.push({
              type: 'link',
              url: path,
              children: [{ type: 'text', value: attachmentName(path) }],
              data: { hProperties: { 'data-file-citation': 'true' } },
            });
            offset = match.index! + match[0].length;
          }
          if (offset) {
            if (offset < node.value.length) children.push({ type: 'text', value: node.value.slice(offset) });
          } else children.push(node);
        } else {
          if ('children' in node && !['link', 'linkReference'].includes(node.type)) visit(node);
          children.push(node);
        }
      }
      parent.children = children as PhrasingContent[];
    };
    visit(tree);
  };
}
