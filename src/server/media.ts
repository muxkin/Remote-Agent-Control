import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Nodes, Root } from 'mdast';
import type { Config } from './config.js';
import type { Message } from '../shared/types.js';
import { inlineExtensions } from './content-media.js';
import { loadStorage, signedDownload } from './object-storage.js';
import { remarkFileCitations } from '../shared/attachments.js';

export const mediaTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
};
const textTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.md': 'text/plain',
  '.markdown': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.toml': 'text/plain',
  '.ini': 'text/plain',
  '.py': 'text/plain',
  '.js': 'text/plain',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
  '.sh': 'text/plain',
  '.sql': 'text/plain',
  '.tex': 'text/plain',
};
/** Validate bytes before declaring UTF-8; other encodings remain unchanged downloads. */
async function textContentType(file: string): Promise<string | undefined> {
  const type = textTypes[extname(file).toLowerCase()];
  if (!type) return undefined;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const bytes of createReadStream(file)) {
    if (bytes.includes(0)) return 'application/octet-stream';
    try {
      decoder.decode(bytes, { stream: true });
    } catch {
      return 'application/octet-stream';
    }
  }
  try {
    decoder.decode();
    return `${type}; charset=utf-8`;
  } catch {
    return 'application/octet-stream';
  }
}
export async function fileContentType(file: string): Promise<string> {
  return (
    (await textContentType(file)) ?? mediaTypes[extname(file).toLowerCase()] ?? 'application/octet-stream'
  );
}
function referencePath(reference: string): string {
  let raw = reference.replace(/^sandbox:/, '').replace(/:\d+(?::\d+)?$/, '');
  if (raw.startsWith('file:')) {
    const url = new URL(raw);
    if (url.hostname && url.hostname !== 'localhost') throw Error('Remote file authority is unsupported');
    return fileURLToPath(url);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw))
    throw Error('Not a local file reference');
  return decodeURIComponent(raw);
}
/** The conversation's exact attachment links are the capability, not its working directory. */
const markdown = unified().use(remarkParse).use(remarkFileCitations);
export function resolveAttachmentPath(reference: string, cwd: string): string {
  return resolve(cwd, referencePath(reference));
}
export function attachmentLinks(text: string): string[] {
  const tree = markdown.runSync(markdown.parse(text)) as Root;
  const definitions = new Map<string, string>();
  const links: string[] = [],
    references: string[] = [];
  function visit(node: Nodes) {
    if (node.type === 'link' || node.type === 'image') links.push(node.url);
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
    if (node.type === 'linkReference' || node.type === 'imageReference') references.push(node.identifier);
    if ('children' in node) for (const child of node.children) visit(child);
  }
  visit(tree);
  for (const id of references) if (definitions.has(id)) links.push(definitions.get(id)!);
  return links;
}
export async function authorizeFile(reference: string, cwd: string, messages: Message[]): Promise<string> {
  const requested = resolveAttachmentPath(reference, cwd);
  const matches = (value: string) => {
    try {
      return resolveAttachmentPath(value, cwd) === requested;
    } catch {
      return false;
    }
  };
  const mentioned = messages.some(
    (message) =>
      ((message.role === 'assistant' || message.id.includes(':media:')) &&
        attachmentLinks(message.text).some(matches)) ||
      message.attachments?.some((attachment) => matches(attachment.path)),
  );
  if (!mentioned) throw Error('文件未作为附件出现在当前会话中');
  const file = await realpath(requested);
  if (!(await stat(file)).isFile()) throw Error('Not a file');
  return file;
}
interface Grant {
  file: string;
  device: string;
  expires: number;
  size: number;
  mtime: number;
  mimeType?: string;
}
export class MediaService {
  private grants = new Map<string, Grant>();
  private uploaded = new Map<string, Promise<string>>();
  constructor(private config: Config) {}
  async inline(data: string, device: string) {
    const match = /^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!match || !Object.hasOwn(inlineExtensions, match[1]) || data.length > 24 * 1024 * 1024)
      throw new Error('Unsupported inline media');
    const bytes = Buffer.from(match[2], 'base64');
    const directory = resolve(this.config.stateDir, 'media');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = resolve(
      directory,
      `${createHash('sha256').update(bytes).digest('hex')}.${inlineExtensions[match[1]]}`,
    );
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return this.resolve(file, device);
  }
  async resolve(
    file: string,
    device: string,
  ): Promise<{ url: string; source: 'gateway' | 'object-storage'; expiresAt: number; name: string }> {
    const info = await stat(file);
    if (this.config.media) {
      const fingerprint = createHash('sha256').update(`${file}:${info.size}:${info.mtimeMs}`).digest('hex');
      let upload = this.uploaded.get(fingerprint);
      if (!upload) {
        upload = this.upload(file);
        this.uploaded.set(fingerprint, upload);
        upload.catch(() => this.uploaded.delete(fingerprint));
        if (this.uploaded.size > 256) this.uploaded.delete(this.uploaded.keys().next().value!);
      }
      const key = await upload;
      // A slow upload must not consume the signed download's lifetime.
      const expiresAt = Date.now() + 5 * 60000;
      const storage = await loadStorage(this.config.media, 'media', this.config.origin);
      return {
        url: await signedDownload(storage, key, expiresAt),
        source: 'object-storage',
        expiresAt,
        name: basename(file),
      };
    }
    const expiresAt = Date.now() + 5 * 60000;
    for (const [token, value] of this.grants) if (value.expires < Date.now()) this.grants.delete(token);
    const token = randomBytes(24).toString('base64url');
    this.grants.set(token, {
      file,
      device,
      expires: expiresAt,
      size: info.size,
      mtime: info.mtimeMs,
      mimeType: await textContentType(file),
    });
    return { url: `/api/media/${token}`, source: 'gateway', expiresAt, name: basename(file) };
  }
  async grant(token: string, device: string): Promise<Grant | null> {
    const grant = this.grants.get(token);
    if (!grant || grant.device !== device || grant.expires < Date.now()) return null;
    const info = await stat(grant.file).catch(() => null);
    return info?.size === grant.size && info.mtimeMs === grant.mtime ? grant : null;
  }
  private async upload(file: string): Promise<string> {
    const settings = this.config.media!;
    const mimeType = await textContentType(file);
    const hash = createHash('sha256');
    for await (const part of createReadStream(file)) hash.update(part);
    // Text response metadata changed. A new key avoids stale CDN headers on
    // already-uploaded objects without reuploading images, audio or video.
    const key = `${settings.prefix ?? 'codex-pocket'}/private-media/${mimeType ? 'text-v1/' : ''}${hash.digest('hex')}${extname(file).toLowerCase()}`;
    const storage = await loadStorage(settings, 'media', this.config.origin);
    await storage.putFile({ key, file, contentType: mimeType });
    return key;
  }
}
