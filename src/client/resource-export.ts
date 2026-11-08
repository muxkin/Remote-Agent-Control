import { Zip, ZipPassThrough, strToU8 } from 'fflate';
import type { ResourceFile } from '../shared/resources.js';

/** Sequential decryption with bounded ZIP parts. No keys or plaintext are sent to the server. */
export async function exportResources(
  files: ResourceFile[],
  download: (file: ResourceFile) => Promise<{ data: Uint8Array<ArrayBuffer>; name: string }>,
  save: (data: Uint8Array<ArrayBuffer>[], name: string) => Promise<void>,
  progress: (completed: number) => void,
  signal?: AbortSignal,
  partLimit = 128 * 1024 * 1024,
) {
  let chunks: Uint8Array<ArrayBuffer>[] = [],
    size = 0,
    count = 0,
    part = 1,
    exported = 0;
  const failed: { id: string; reason: string }[] = [];
  const createZip = () =>
    new Zip((error, data) => {
      if (error) throw error;
      chunks.push(data.slice());
    });
  let zip = createZip();
  const add = (name: string, data: Uint8Array) => {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(data, true);
  };
  const finish = async () => {
    zip.end();
    await save(chunks, `pocket-files-${new Date().toISOString().slice(0, 10)}-${part++}.zip`);
    chunks = [];
    size = 0;
    count = 0;
    zip = createZip();
  };
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      let decoded: Awaited<ReturnType<typeof download>>;
      try {
        decoded = await download(file);
      } catch (error) {
        signal?.throwIfAborted();
        failed.push({
          id: `${file.kind}:${file.id}`,
          reason: error instanceof Error ? error.message : '无法解密或读取',
        });
        progress(++exported);
        continue;
      }
      signal?.throwIfAborted();
      if (count && size + decoded.data.byteLength > partLimit) await finish();
      const name =
        decoded.name
          .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
          .replace(/^\.+/, '_')
          .slice(0, 180) || 'file';
      add(`${file.kind}/${file.id}/${name}`, decoded.data);
      size += decoded.data.byteLength;
      count++;
      progress(++exported);
    }
    if (failed.length)
      add(
        'export-errors.json',
        strToU8(JSON.stringify({ failed, note: '这些文件未导出；云端文件未被删除。' }, null, 2)),
      );
    if (count || failed.length) await finish();
    return { downloaded: files.length - failed.length, failed };
  } finally {
    zip.terminate();
    chunks = [];
  }
}
