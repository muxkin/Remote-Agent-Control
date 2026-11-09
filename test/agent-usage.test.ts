import { it, expect, vi, afterEach } from 'vitest';
import { codexUsage } from '../packages/adapter-codex/src/usage.js';
import { DesktopAppTools } from '../packages/adapter-codex/src/app-tools.js';
import { UsageFeed } from '../src/server/usage-feed.js';
import type { AgentBackend } from '../src/server/backends/types.js';
import { fixtureConfig, THREAD } from './helpers.js';
import { rmSync } from 'node:fs';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('normalizes all native quota buckets without exposing account or credit identifiers', () => {
  const value = codexUsage(
    {
      accountId: 'private',
      rateLimitResetCredits: { credits: [{ id: 'private-credit' }] },
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          planType: 'pro',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1700000000 },
          secondary: { usedPercent: null },
        },
        dot: { limitName: 'Dot', primary: { usedPercent: 110, windowDurationMins: 10080 } },
      },
    },
    100,
  );
  expect(value.buckets).toHaveLength(2);
  expect(value.buckets[0].windows[0]).toMatchObject({ usedPercent: 25, resetsAt: 1700000000000 });
  expect(value.buckets[1].windows[0].usedPercent).toBe(100);
  expect(JSON.stringify(value)).not.toContain('private');
  expect(
    codexUsage({ rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: NaN } } }).available,
  ).toBe(false);
  expect(codexUsage({ rateLimits: { primary: { usedPercent: 0 } } }).available).toBe(true);
});
it('uses a valid native conversation anchor for account usage reads', async () => {
  const config = fixtureConfig(),
    app = new DesktopAppTools(config);
  try {
    const request = vi.fn(async () => ({
      success: true,
      contentItems: [
        { type: 'inputText', text: JSON.stringify({ rateLimits: { primary: { usedPercent: 40 } } }) },
      ],
    }));
    vi.spyOn(app as any, 'connect').mockResolvedValue({ request });
    vi.spyOn(app, 'has').mockReturnValue(true);
    const readings = await Promise.all([app.usage(THREAD), app.usage(THREAD, true)]);
    expect(readings.every((value) => value.available)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'tools/call',
      expect.objectContaining({ threadId: THREAD, tool: 'get_usage_limits', arguments: {} }),
      8000,
      false,
    );
    await app.usage(THREAD);
    expect(request).toHaveBeenCalledTimes(1);
    await app.usage(THREAD, true);
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    app.close();
    rmSync(config.desktopRoot, { recursive: true, force: true });
  }
});

it('coalesces turn-triggered quota reads, marks old data on failure, and pauses without subscribers', async () => {
  vi.useFakeTimers();
  const usage = vi.fn(async () => codexUsage({ rateLimits: { primary: { usedPercent: 30 } } }));
  const publish = vi.fn();
  const feed = new UsageFeed({ usage } as unknown as AgentBackend, publish);
  feed.setConnected(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(usage).not.toHaveBeenCalled();
  feed.setActive(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(usage).toHaveBeenCalledTimes(1);
  const original = feed.snapshot.value;
  usage.mockRejectedValueOnce(new Error('quota temporarily unavailable'));
  feed.turnFinished();
  feed.turnFinished();
  await vi.advanceTimersByTimeAsync(4999);
  expect(usage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(publish).toHaveBeenLastCalledWith({ state: 'stale', value: original });
  await vi.advanceTimersByTimeAsync(5000);
  expect(usage).toHaveBeenCalledTimes(3);
  expect(feed.snapshot.state).toBe('current');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(usage).toHaveBeenCalledTimes(4);
  feed.setConnected(false);
  expect(feed.snapshot.state).toBe('stale');
  feed.setActive(false);
  feed.setConnected(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(usage).toHaveBeenCalledTimes(4);
});
