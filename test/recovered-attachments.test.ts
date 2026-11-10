import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { CodexBackend } from '../packages/adapter-codex/src/backend.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
import { HistoryIndex } from '../packages/adapter-codex/src/history.js';
import { normalizedView } from '../packages/adapter-codex/src/timeline.js';
import { fixtureConfig, historyFixture, state, THREAD } from './helpers.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const config = fixtureConfig(),
    file = historyFixture(config);
  const history = new HistoryIndex(config.codexHome, join(config.stateDir, 'recovered-images'));
  cleanup.push(
    () => rmSync(config.desktopRoot, { recursive: true, force: true }),
    () => history.close(),
  );
  const image = join(config.desktopRoot, 'removed screenshot.png');
  const bytes = Buffer.from('the original viewed image bytes');
  const data = `data:image/png;base64,${bytes.toString('base64')}`;
  const records: any[] = [
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'view', name: 'exec' } },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: THREAD,
        item: { type: 'ImageView', path: pathToFileURL(image).href },
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'view',
        output: [{ type: 'input_image', image_url: data }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `![screenshot](<${image}>)` }],
      },
    },
  ];
  const save = () => writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { config, file, history, image, bytes, records, save };
}
it.each([false, true])(
  'recovers a deleted viewed image from its own %s compressed history without rewriting history or the old path',
  async (compressed) => {
    const f = fixture();
    f.save();
    if (compressed) {
      writeFileSync(f.file + '.zst', zstdCompressSync(readFileSync(f.file)));
      rmSync(f.file);
    }
    const original = readFileSync(f.file + (compressed ? '.zst' : ''));
    const files = await Promise.all([
      f.history.attachment(THREAD, f.image),
      f.history.attachment(THREAD, f.image),
    ]);
    expect(files[0]).toBe(files[1]);
    expect(readFileSync(files[0])).toEqual(f.bytes);
    expect(existsSync(f.image)).toBe(false);
    expect(readFileSync(f.file + (compressed ? '.zst' : ''))).toEqual(original);
  },
);
it.each([
  'different-thread',
  'different-path',
  'unrelated-result',
  'multiple-images',
  'parallel-calls',
  'no-view-event',
])('refuses ambiguous or unrelated recovery: %s', async (variant) => {
  const f = fixture();
  if (variant === 'different-thread') f.records[1].payload.thread_id = 'other-thread';
  if (variant === 'different-path') f.records[1].payload.item.path = pathToFileURL(f.image + '.other').href;
  if (variant === 'unrelated-result') f.records[2].payload.call_id = 'unrelated';
  if (variant === 'multiple-images')
    f.records[2].payload.output.push({ type: 'input_image', image_url: 'data:image/png;base64,b3RoZXI=' });
  if (variant === 'parallel-calls')
    f.records.splice(1, 0, {
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'parallel' },
    });
  if (variant === 'no-view-event') f.records.splice(1, 1);
  f.save();
  await expect(f.history.attachment(THREAD, f.image)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not expose tool paths that were never shared as attachment links', async () => {
  const f = fixture();
  f.records.pop();
  f.save();
  await expect(f.history.attachment(THREAD, f.image)).rejects.toThrow('附件未在此会话中找到');
});

it('recovers both missing images from one live tool call in event order', async () => {
  const f = fixture();
  f.records.pop();
  const other = f.image + '.second.png';
  const otherBytes = Buffer.from('second original image');
  f.records[2].payload.output.push({
    type: 'input_image',
    image_url: 'data:image/png;base64,' + otherBytes.toString('base64'),
  });
  f.records.splice(2, 0, {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: THREAD,
      item: { type: 'ImageView', path: pathToFileURL(other).href },
    },
  });
  f.save();
  const desktop = new DesktopAdapter(f.config);
  const snapshot = state();
  snapshot.turnHistory.history.entitiesByKey.one.items = [
    { type: 'imageView', id: 'view-image', path: pathToFileURL(f.image).href },
    { type: 'imageView', id: 'second-view-image', path: pathToFileURL(other).href },
  ];
  desktop.view = () => normalizedView(snapshot, 1, true);
  const backend = new CodexBackend(f.config, desktop, f.history);
  expect(readFileSync(await backend.attachment(THREAD, f.image))).toEqual(f.bytes);
  expect(readFileSync(await backend.attachment(THREAD, other))).toEqual(otherBytes);
  await expect(backend.attachment(THREAD, f.image + '.unrelated')).rejects.toThrow('附件未在此会话中找到');
});
