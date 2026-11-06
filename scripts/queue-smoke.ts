import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { readConfig } from './legacy-config.js';
import { DesktopAdapter } from '../packages/adapter-codex/src/desktop.js';
const id = process.argv[2];
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '') ||
  !process.argv.includes('--allow-control')
)
  throw Error('Dedicated chat required');
const desktop = new DesktopAdapter(readConfig());
await desktop.start();
const release = await desktop.acquire(id);
const initial = await desktop.waitForView(id);
if (!initial?.canSend || initial.queuedMessages?.length)
  throw Error('Test chat must be idle with empty native queue');
const report: any = { checks: {}, date: new Date().toISOString() };
const queuedId = randomUUID(),
  removedId = randomUUID(),
  marker = `NATIVE_QUEUE_${queuedId.slice(0, 8)}`;
try {
  await desktop.control(
    id,
    'settings',
    JSON.stringify({
      model: 'gpt-6.1-sol',
      effort: 'low',
      expectedModel: initial.model,
      expectedEffort: initial.reasoningEffort,
    }),
    randomUUID(),
  );
  await desktop.control(
    id,
    'send',
    '请只执行 sleep 20，等待完成后回复 WAIT_DONE，不操作文件。',
    randomUUID(),
  );
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 15000 }).not.toBeNull();
  const firstTurn = desktop.view(id)!.activeTurnId;
  await desktop.control(
    id,
    'queue',
    JSON.stringify({
      text: `只回复 ${marker}，不要执行工具。`,
      expectedQueueFingerprint: desktop.view(id)!.queueFingerprint,
    }),
    queuedId,
  );
  report.checks.enqueuedNatively = desktop.view(id)!.queuedMessages!.some((m) => m.id === queuedId);
  report.checks.keepsCurrentTurn = desktop.view(id)!.activeTurnId === firstTurn;
  await desktop.control(
    id,
    'queue',
    JSON.stringify({
      text: '这条消息应在运行前被移除，不应执行。',
      expectedQueueFingerprint: desktop.view(id)!.queueFingerprint,
    }),
    removedId,
  );
  await desktop.control(
    id,
    'queue-remove',
    JSON.stringify({ messageId: removedId, expectedQueueFingerprint: desktop.view(id)!.queueFingerprint }),
    randomUUID(),
  );
  report.checks.removedNatively = !desktop.view(id)!.queuedMessages!.some((m) => m.id === removedId);
  await expect
    .poll(() => desktop.view(id)?.messages.some((m) => m.role === 'assistant' && m.text.includes(marker)), {
      timeout: 90000,
    })
    .toBe(true);
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 30000 }).toBeNull();
  report.checks.executesExactlyOnce =
    desktop.view(id)!.messages.filter((m) => m.role === 'assistant' && m.text.includes(marker)).length === 1;
  report.checks.queueDrained = desktop.view(id)!.queuedMessages!.length === 0;
} catch (e) {
  report.error = (e as Error).message;
  report.queue = desktop.view(id)?.queuedMessages;
  process.exitCode = 1;
} finally {
  const active = desktop.view(id)?.activeTurnId;
  if (active) await desktop.control(id, 'interrupt', active, randomUUID()).catch(() => {});
  await expect.poll(() => desktop.view(id)?.activeTurnId, { timeout: 15000 }).toBeNull();
  for (const messageId of [queuedId, removedId])
    if (desktop.view(id)?.queuedMessages?.some((m) => m.id === messageId))
      await desktop
        .control(
          id,
          'queue-remove',
          JSON.stringify({ messageId, expectedQueueFingerprint: desktop.view(id)!.queueFingerprint }),
          randomUUID(),
        )
        .catch(() => {});
  const v = desktop.view(id)!;
  await desktop.control(
    id,
    'settings',
    JSON.stringify({
      model: initial.model,
      effort: initial.reasoningEffort,
      expectedModel: v.model,
      expectedEffort: v.reasoningEffort,
    }),
    randomUUID(),
  );
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  release();
  desktop.stop();
  await writeFile('.test-output/queue-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
