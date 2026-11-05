import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { itemMedia } from '../src/server/content-media.js';
import { messagesOf } from '../src/server/timeline.js';
import { authorizeFile } from '../src/server/media.js';
import { state } from './helpers.js';

it('extracts native imageView paths without inferring images from unrelated tool paths', () => {
  const path = '/outside/project/viewed photo (1).png';
  expect(itemMedia({ type: 'imageView', path })).toEqual([path]);
  expect(itemMedia({ type: 'imageView', path, content: [{ type: 'localImage', path }] })).toEqual([path]);
  expect(itemMedia({ type: 'commandExecution', path })).toEqual([]);
  expect(itemMedia({ type: 'imageView', path: '' })).toEqual([]);
  expect(itemMedia({ type: 'imageView', path: { value: path } })).toEqual([]);
});

it('keeps imageView media in its tool activity with conversation attachment authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-image-view-'));
  try {
    const path = join(dir, 'viewed photo (1).png');
    await writeFile(path, 'fixture');
    const snapshot = state();
    snapshot.turnHistory.history.entitiesByKey.one.params.input = [];
    snapshot.turnHistory.history.entitiesByKey.one.items = [
      { type: 'imageView', id: 'view-image', path, startedAtMs: 100, completedAtMs: 101 },
    ];
    const messages = messagesOf(snapshot);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'view-image:media:0',
      role: 'tool',
      text: `![查看的图片](<${path}>)`,
    });
    expect(messages[0].details).toBeUndefined();
    expect(await authorizeFile(path, '/different-project', messages)).toBe(path);
    await expect(authorizeFile(path, '/different-project', [])).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps diagnostic information for an imageView without an image path', () => {
  const snapshot = state();
  snapshot.turnHistory.history.entitiesByKey.one.params.input = [];
  snapshot.turnHistory.history.entitiesByKey.one.items = [
    { type: 'imageView', id: 'failed-view', status: 'failed', error: 'File not found' },
  ];
  const messages = messagesOf(snapshot);
  expect(messages).toHaveLength(1);
  expect(messages[0].deferred).toBe(true);
  expect(messages[0].details).toBeUndefined();
  expect(messagesOf(snapshot, true)[0].details).toContain('File not found');
  expect(messages[0].id).toBe('failed-view');
});
