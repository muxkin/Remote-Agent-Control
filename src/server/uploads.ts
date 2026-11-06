import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { join, basename, sep } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.js';
import { z } from 'zod';
import { loadStorage, signedDownload, validateUpload } from './object-storage.js';
export const uploadSpec = z
  .object({
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((n) => basename(n) === n && !/[\x00-\x1f\\/]/.test(n)),
    size: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export interface Upload {
  id: string;
  name: string;
  size: number;
  sha256: string;
  device: string;
  thread: string;
  expires: number;
  complete: boolean;
  offset: number;
  file: string;
  key: string;
}
/** Upload metadata and bytes are private to the desktop host. Cloud receives only grants or a configured fallback stream. */
export class Uploads {
  private locks = new Set<string>();
  constructor(private config: Config) {}
  private directory() {
    return join(this.config.stateDir, 'uploads');
  }
  private async save(u: Upload) {
    await writeFile(join(this.directory(), `${u.id}.json`), JSON.stringify(u), { mode: 0o600 });
  }
  async get(id: string, device: string, thread: string) {
    if (!z.string().uuid().safeParse(id).success) throw Error('Invalid upload');
    const u: Upload = JSON.parse(await readFile(join(this.directory(), `${id}.json`), 'utf8'));
    if (u.device !== device || u.thread !== thread || (!u.complete && u.expires < Date.now()))
      throw Error('Upload expired or belongs to another device');
    return u;
  }
  async begin(spec: z.infer<typeof uploadSpec>, device: string, thread: string) {
    uploadSpec.parse(spec);
    await mkdir(this.directory(), { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const dir = join(this.directory(), id);
    await mkdir(dir, { mode: 0o700 });
    const u: Upload = {
      ...spec,
      id,
      device,
      thread,
      expires: Date.now() + 86400000,
      complete: false,
      offset: 0,
      file: join(dir, spec.name),
      key: `${this.config.media?.prefix ?? 'codex-pocket'}/private-uploads/${id}`,
    };
    await this.save(u);
    if (this.config.media) {
      const storage = await loadStorage(this.config.media, 'media', this.config.origin);
      const upload = validateUpload(
        await storage.createUpload({ key: u.key, size: u.size, expiresAt: Date.now() + 900000 }),
        storage,
      );
      return { id, name: u.name, route: 'object-storage' as const, upload };
    }
    return { id, name: u.name, route: 'gateway' as const, chunkSize: 256 * 1024 };
  }
  async chunk(id: string, device: string, thread: string, offset: number, bytes: Buffer) {
    if (this.locks.has(id)) throw Error('Upload busy');
    this.locks.add(id);
    try {
      const u = await this.get(id, device, thread);
      if (
        u.complete ||
        this.config.media ||
        offset !== u.offset ||
        bytes.length < 1 ||
        bytes.length > 256 * 1024 ||
        offset + bytes.length > u.size
      )
        throw Error('Invalid upload offset');
      await writeFile(u.file + '.part', bytes, { flag: offset === 0 ? 'w' : 'a', mode: 0o600 });
      u.offset += bytes.length;
      await this.save(u);
      return { offset: u.offset };
    } finally {
      this.locks.delete(id);
    }
  }
  async finish(id: string, device: string, thread: string) {
    if (this.locks.has(id)) throw Error('Upload busy');
    this.locks.add(id);
    try {
      const u = await this.get(id, device, thread);
      if (u.complete) return { id: u.id, name: u.name };
      if (this.config.media) {
        const storage = await loadStorage(this.config.media, 'media', this.config.origin);
        const url = await signedDownload(storage, u.key, Date.now() + 300000);
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
        if (!response.ok || !response.body) throw Error('Object download failed');
        let count = 0;
        await pipeline(
          Readable.fromWeb(response.body as any),
          async function* (source) {
            for await (const bytes of source) {
              count += bytes.length;
              if (count > u.size) throw Error('Unexpected size');
              yield bytes;
            }
          },
          createWriteStream(u.file + '.part', { mode: 0o600 }),
        );
      }
      if ((await stat(u.file + '.part')).size !== u.size) throw Error('Upload incomplete');
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(u.file + '.part')) hash.update(bytes);
      if (hash.digest('hex') !== u.sha256) throw Error('Upload checksum mismatch');
      await rename(u.file + '.part', u.file);
      u.complete = true;
      await this.save(u);
      return { id: u.id, name: u.name };
    } finally {
      this.locks.delete(id);
    }
  }
  async reference(path: string, device: string, thread: string): Promise<string | null> {
    const prefix = this.directory() + sep;
    if (!path.startsWith(prefix)) return null;
    const id = path.slice(prefix.length).split(sep)[0];
    try {
      const u = await this.get(id, device, thread);
      return u.complete && u.file === path ? u.file : null;
    } catch {
      return null;
    }
  }
  async attachments(ids: string[], device: string, thread: string) {
    return Promise.all(
      ids.map(async (id) => {
        const u = await this.get(id, device, thread);
        if (!u.complete) throw Error('Upload incomplete');
        return { name: u.name, path: u.file };
      }),
    );
  }
}
