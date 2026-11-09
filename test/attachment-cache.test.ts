import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentCache } from '../src/server/attachment-cache.js';
it('retains previously authorized attachments after temporary files disappear and isolates conversations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'attachment-cache-'));
  try {
    const cache = new AttachmentCache(join(dir, 'cache')),
      file = join(dir, 'picture.png');
    await writeFile(file, 'image');
    expect(await cache.lookup('chat', '/unseen.png')).toBeNull();
    await cache.remember('chat', file, file);
    await rm(file);
    const cached = await cache.lookup('chat', file);
    expect(await readFile(cached!, 'utf8')).toBe('image');
    expect(await cache.lookup('different-chat', file)).toBeNull();
    expect(await cache.lookup('chat', file + '/different')).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
