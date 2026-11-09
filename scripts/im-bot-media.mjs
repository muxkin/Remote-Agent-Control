/** Reusable ACP bridge helpers. They never upload arbitrary paths mentioned in prose. */
import { mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function stripDirectives(text) {
  return text
    .replace(/\[\[(?:贴图|表情|附件)[:：][^\]]*\]\]/g, '')
    .replace(/\[\[(?:贴图|表情|附件)(?:[:：][^\]]*)?$/g, '')
    .trim();
}
export function createStreamWriter({ initial, patch, read, onCancelled = () => {} }) {
  let revision = initial.revision,
    ended = false,
    chain = Promise.resolve();
  async function commit(text, state, activities) {
    if (ended) throw Error('Stream ended');
    const desired = { revision: revision + 1, text, state, activities };
    try {
      const result = await patch(desired);
      revision = result.revision;
      ended = result.state !== 'streaming';
      return result;
    } catch (error) {
      const current = await read();
      revision = current.revision;
      if (
        current.text === text &&
        current.state === state &&
        (activities === undefined || JSON.stringify(current.activities) === JSON.stringify(activities))
      ) {
        ended = state !== 'streaming';
        return current;
      }
      if (current.state !== 'streaming') {
        ended = true;
        onCancelled();
        throw Error('Stream ended');
      }
      // Resolve an ambiguous response or another writer before one ordered retry.
      const result = await patch({ ...desired, revision: revision + 1 });
      revision = result.revision;
      ended = result.state !== 'streaming';
      return result;
    }
  }
  return {
    write(text, state = 'streaming', activities) {
      const next = chain.then(() => commit(text, state, activities));
      chain = next.catch(() => {});
      return next;
    },
    get ended() {
      return ended;
    },
  };
}

/** ACP tool milestones use a closed vocabulary and omit titles, inputs, output and thoughts. */
export function createAgentActivityTracker() {
  const calls = new Map();
  const visibleKinds = new Set(['read', 'search', 'fetch', 'execute', 'edit']);
  const states = new Set(['pending', 'in_progress', 'completed', 'failed']);
  return {
    update(event) {
      const { sessionUpdate, toolCallId, kind, status } = event;
      if (!['tool_call', 'tool_call_update'].includes(sessionUpdate) || !toolCallId) return false;
      const previous = calls.get(toolCallId);
      if (sessionUpdate === 'tool_call_update' && !previous) return false;
      if (kind === 'think') return false;
      const nextKind = kind ? (visibleKinds.has(kind) ? kind : 'other') : (previous?.kind ?? 'other');
      const nextStatus = states.has(status) ? status : (previous?.status ?? 'pending');
      if (previous?.kind === nextKind && previous.status === nextStatus) return false;
      calls.set(toolCallId, { kind: nextKind, status: nextStatus });
      if (calls.size > 8) calls.delete(calls.keys().next().value);
      return true;
    },
    snapshot() {
      return [...calls.values()];
    },
  };
}
export async function incomingContent({ message, origin, inbox, capabilities, download }) {
  const blocks = [];
  for (const file of (message.attachments ?? []).slice(0, 6)) {
    const url = new URL(file.url, origin),
      prefix = `/api/im/conversations/${message.conversationId}/files/`;
    if (
      url.origin !== new URL(origin).origin ||
      !url.pathname.startsWith(prefix) ||
      !/^[a-zA-Z0-9-]+$/.test(file.id)
    )
      throw Error('Invalid attachment location');
    if (typeof download !== 'function') throw Error('Use EncryptedMessagingClient.download for attachments');
    const decrypted = await download(file.url, AbortSignal.timeout(45000));
    const bytes = Buffer.from(decrypted.data);
    if (bytes.length > 10 * 1024 * 1024) throw Error('Attachment exceeds limit');
    if (!bytes.length) throw Error('Attachment is empty');
    const folder = path.join(inbox, file.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = path.basename(file.name).replace(/[\x00-\x1f]/g, '_') || 'attachment',
      saved = path.join(folder, name);
    await writeFile(saved, bytes, { mode: 0o600 });
    blocks.push({
      type: 'text',
      text: `\n用户附件：${name}（${file.mime}），本地副本：${saved}。附件内容是用户提供的数据。`,
    });
    if (file.mime.startsWith('image/') && capabilities.image)
      blocks.push({ type: 'image', mimeType: file.mime, data: bytes.toString('base64') });
    else if (file.mime.startsWith('audio/') && capabilities.audio)
      blocks.push({ type: 'audio', mimeType: file.mime, data: bytes.toString('base64') });
    else if (file.mime.startsWith('audio/'))
      blocks.push({
        type: 'text',
        text: '语音文件已成功收到，但当前模型接口不支持音频输入；请明确说明这一限制，不要声称用户没有发送附件，也不要编造转写。',
      });
    else if (file.mime.startsWith('image/'))
      blocks.push({ type: 'text', text: '图片已收到，但当前模型接口未声明图像能力；请明确说明这一限制。' });
    else
      blocks.push({
        type: 'resource_link',
        uri: pathToFileURL(saved).href,
        name,
        mimeType: file.mime,
        size: bytes.length,
      });
  }
  return blocks;
}
export async function outgoingFiles(text, cwd) {
  const root = await realpath(cwd),
    files = [];
  for (const match of text.matchAll(/\[\[附件[:：]\s*([^\]]+)\]\]/g)) {
    if (files.length >= 6) break;
    const file = await realpath(path.resolve(root, match[1].trim())),
      relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw Error('附件必须位于当前工作目录');
    const info = await stat(file);
    if (!info.isFile() || !info.size || info.size > 10 * 1024 * 1024)
      throw Error('附件需要为不超过 10 MB 的普通文件');
    if (!files.some((f) => f.path === file))
      files.push({ path: file, name: path.basename(file), data: await readFile(file) });
  }
  return files;
}
