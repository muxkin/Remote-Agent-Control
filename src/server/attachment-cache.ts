import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, copyFile, chmod, rename, rm, utimes } from 'node:fs/promises';
import { join, basename } from 'node:path';
/** Copies only successfully authorized downloads. Scoped to one backend and conversation. */
export class AttachmentCache {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private key(thread: string, reference: string) {
    return (
      createHash('sha256')
        .update(JSON.stringify([thread, reference]))
        .digest('hex') + '-'
    );
  }
  async lookup(thread: string, reference: string): Promise<string | null> {
    const key = this.key(thread, reference);
    const names = await readdir(this.directory).catch(() => []);
    const name = names.find((name) => name.startsWith(key) && !name.endsWith('.tmp'));
    if (!name) return null;
    const file = join(this.directory, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    await utimes(file, new Date(), new Date()).catch(() => {});
    return file;
  }
  async remember(thread: string, reference: string, file: string) {
    const task = async () => {
      const info = await stat(file);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const name = this.key(thread, reference) + basename(file).slice(-180),
        dest = join(this.directory, name),
        temp = join(this.directory, randomUUID() + '.tmp');
      try {
        await copyFile(file, temp);
        await chmod(temp, 0o600);
        await rename(temp, dest);
      } finally {
        await rm(temp, { force: true });
      }
      const entries = await Promise.all(
        (await readdir(this.directory))
          .filter((n) => !n.endsWith('.tmp'))
          .map(async (name) => ({ name, ...(await stat(join(this.directory, name))) })),
      );
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      let bytes = 0;
      for (let i = 0; i < entries.length; i++) {
        bytes += entries[i].size;
        if (i >= 128 || bytes > 256 * 1024 * 1024)
          await rm(join(this.directory, entries[i].name), { force: true });
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    await next;
  }
}
