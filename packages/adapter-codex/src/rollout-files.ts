import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

const MAX_BYTES = 512 * 1024 * 1024;
type Entry = { path: string; bytes: number; refs: number };

/** Private, bounded disk cache so compressed history uses the same byte pagination as JSONL. */
export class RolloutFiles {
  private directory?: string;
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Entry>>();
  private stopped = false;
  private sequence = 0;

  async open(file: string) {
    if (this.stopped) throw new Error('History reader closed');
    if (!file.endsWith('.zst')) {
      const handle = await open(file, 'r');
      const info = await handle.stat();
      return { handle, identity: `${info.dev}:${info.ino}`, close: () => handle.close() };
    }
    const info = await stat(file);
    const identity = `zstd:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    const key = `${file}:${identity}`;
    let entry = this.entries.get(key);
    if (!entry) {
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.expand(file, key).finally(() => {
          this.pending.delete(key);
          if (this.stopped) this.prune();
        });
        this.pending.set(key, pending);
      }
      entry = await pending;
    }
    if (this.stopped) throw new Error('History reader closed');
    entry.refs++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    try {
      const handle = await open(entry.path, 'r');
      return {
        handle,
        identity,
        close: async () => {
          await handle.close();
          entry.refs--;
          this.prune();
        },
      };
    } catch (error) {
      entry.refs--;
      this.prune();
      throw error;
    }
  }

  private async expand(file: string, key: string): Promise<Entry> {
    this.directory ??= mkdtempSync(join(tmpdir(), 'codex-history-'));
    const path = join(this.directory, `${++this.sequence}.jsonl`);
    let bytes = 0;
    try {
      await pipeline(
        createReadStream(file),
        createZstdDecompress(),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > MAX_BYTES ? new Error('历史记录解压后超过 512 MiB，请在桌面查看') : null, chunk);
          },
        }),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      );
      if (this.stopped) throw new Error('History reader closed');
      const info = await stat(file);
      if (key !== `${file}:zstd:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`)
        throw new Error('历史记录已更新，请重新加载');
      const entry = { path, bytes, refs: 0 };
      this.entries.set(key, entry);
      return entry;
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  }

  private prune() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of this.entries) {
      if (!this.stopped && this.entries.size <= 4 && bytes <= MAX_BYTES) break;
      if (entry.refs || this.pending.has(key)) continue;
      rmSync(entry.path, { force: true });
      this.entries.delete(key);
      bytes -= entry.bytes;
    }
    if (this.stopped && !this.entries.size && !this.pending.size && this.directory) {
      rmSync(this.directory, { recursive: true, force: true });
      this.directory = undefined;
    }
  }

  close() {
    this.stopped = true;
    this.prune();
  }
}
