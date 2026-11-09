import { attachmentInfo } from '../shared/attachments';
import { attachmentMime } from '../shared/attachment-mime';
import type { AttachmentResource } from './AttachmentAccess';

const TEXT_LIMIT = 256 * 1024;
const ROW_LIMIT = 120;
const COLUMN_LIMIT = 32;

async function readPrefix(file: AttachmentResource, limit: number, signal: AbortSignal) {
  if (file.blob) {
    const bytes = new Uint8Array(await file.blob.slice(0, limit).arrayBuffer());
    signal.throwIfAborted();
    return { bytes, truncated: file.blob.size > limit };
  }
  if (file.size === 0) return { bytes: new Uint8Array(), truncated: false };
  // Private storage downloads can be on a separate origin. Read through the existing authorized endpoint.
  const url = file.url.startsWith('/') ? file.url : (file.downloadUrl ?? file.url);
  const response = await fetch(url, {
    signal,
    referrerPolicy: 'no-referrer',
    ...(url.startsWith('/local-files/') && { headers: { Range: `bytes=0-${limit}` } }),
  });
  if (!response.ok || !response.body) throw Error('文件读取失败，请重试');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit + 1);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, bytes.length - length);
      bytes.set(part, length);
      length += part.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return {
    bytes: bytes.subarray(0, Math.min(length, limit)),
    truncated: length > limit || file.size > limit,
  };
}

function decodeText(bytes: Uint8Array, truncated: boolean) {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

function parseTable(text: string, separator: string, truncated: boolean) {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    clipped = false;
  const cell = () => {
    if (row.length < COLUMN_LIMIT) row.push(value);
    else clipped = true;
    value = '';
  };
  const line = () => {
    cell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    if (rows.length === ROW_LIMIT) {
      clipped = true;
      break;
    }
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && !value) quoted = true;
    else if (char === separator) cell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      line();
    } else value += char;
  }
  if (!truncated && rows.length < ROW_LIMIT && text && (quoted || !/[\r\n]$/.test(text))) line();
  return { rows, clipped: clipped || truncated };
}

export type AttachmentPreviewContent =
  | { kind: 'image' | 'video' | 'audio' | 'pdf' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'text'; text: string; truncated: boolean; table?: ReturnType<typeof parseTable> };

/** The transport only supplies authorized file bytes. Each viewer dispatches on this contract. */
export async function attachmentPreviewContent(
  file: AttachmentResource,
  path: string,
  signal: AbortSignal,
): Promise<AttachmentPreviewContent> {
  const mime = file.mime.split(';')[0].toLowerCase();
  for (const kind of ['image', 'video', 'audio'] as const) if (mime.startsWith(`${kind}/`)) return { kind };
  if (mime === 'application/pdf') return { kind: 'pdf' };
  const info = attachmentInfo(path, file.name);
  if (info.media === 'image') return { kind: 'image' };
  if (
    (info.previewable && info.extension !== 'pdf') ||
    mime.startsWith('text/') ||
    mime === 'application/json'
  ) {
    const { bytes, truncated } = await readPrefix(file, TEXT_LIMIT, signal);
    if (attachmentMime('', bytes.subarray(0, 32)).startsWith('image/')) return { kind: 'image' };
    const text = decodeText(bytes, truncated);
    if (text === undefined) return { kind: 'unsupported', reason: '文件编码无法识别，或内容不是文本。' };
    const delimiter =
      info.extension === 'tsv' || mime === 'text/tab-separated-values'
        ? '\t'
        : info.extension === 'csv' || mime === 'text/csv'
          ? ','
          : undefined;
    return {
      kind: 'text',
      text,
      truncated,
      table: delimiter ? parseTable(text, delimiter, truncated) : undefined,
    };
  }
  if (mime === 'application/octet-stream') {
    const { bytes } = await readPrefix(file, 32, signal);
    if (attachmentMime('', bytes).startsWith('image/')) return { kind: 'image' };
  }
  return { kind: 'unsupported', reason: '这种文件暂时无法在这里预览。' };
}
