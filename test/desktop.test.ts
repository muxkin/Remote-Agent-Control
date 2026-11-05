import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopAdapter } from '../src/server/desktop.js';
import { platformRuntime } from '../src/server/platform.js';
import { requestFingerprint } from '../src/server/approvals.js';
import { messagesOf } from '../src/server/timeline.js';
import { fixtureConfig, FakeTransport, THREAD, TURN, state } from './helpers.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((x) => x());
});
async function setup(version?: string) {
  const c = fixtureConfig();
  if (version)
    writeFileSync(join(c.desktopRoot, 'resources/linux-package-metadata.json'), JSON.stringify({ version }));
  const t = new FakeTransport();
  const d = new DesktopAdapter(c, () => t);
  cleanups.push(() => {
    d.stop();
    rmSync(c.desktopRoot, { recursive: true, force: true });
  });
  await d.start();
  const release = await d.acquire(THREAD);
  return { c, t, d, release };
}
describe('Desktop follower', () => {
  it('steers only the pinned running turn through the native follower', async () => {
    const { t, d } = await setup();
    t.current = state({ threadRuntimeStatus: { type: 'active' } });
    t.current.turnHistory.history.entitiesByKey.one.status = 'inProgress';
    t.revision = 2;
    t.snapshot();
    await expect(
      d.control(THREAD, 'steer', JSON.stringify({ expectedTurnId: 'wrong', text: '追加' }), 'id'),
    ).rejects.toThrow();
    await d.control(THREAD, 'steer', JSON.stringify({ expectedTurnId: TURN, text: '追加' }), 'id');
    expect(t.calls.at(-1)).toMatchObject({
      method: 'thread-follower-steer-turn',
      version: 1,
      params: {
        conversationId: THREAD,
        clientUserMessageId: 'id',
        input: [{ type: 'text', text: '追加' }],
        restoreMessage: { id: 'id', text: '追加' },
      },
    });
  });
  it('reuses native image and file input when adding attachments to a running turn', async () => {
    const { t, d } = await setup();
    t.current = state({ threadRuntimeStatus: { type: 'active' } });
    t.current.turnHistory.history.entitiesByKey.one.status = 'inProgress';
    t.revision++;
    t.snapshot();
    const attachments = [
      { name: 'paste.png', path: '/private/paste.png' },
      { name: 'notes.txt', path: '/private/notes.txt' },
    ];
    await d.control(
      THREAD,
      'steer',
      JSON.stringify({ expectedTurnId: TURN, text: '', attachments }),
      'image-only',
    );
    expect(t.calls.at(-1)).toMatchObject({
      method: 'thread-follower-steer-turn',
      params: {
        clientUserMessageId: 'image-only',
        input: [
          { type: 'text', text: expect.stringContaining('/private/notes.txt') },
          { type: 'localImage', path: '/private/paste.png' },
        ],
        attachments: [
          { path: '/private/paste.png', isImageAttachment: true },
          { path: '/private/notes.txt' },
        ],
        restoreMessage: {
          context: { fileAttachments: [{ path: '/private/paste.png' }, { path: '/private/notes.txt' }] },
        },
      },
    });
    const count = t.calls.length;
    await expect(
      d.control(
        THREAD,
        'steer',
        JSON.stringify({ expectedTurnId: 'stale', text: '', attachments }),
        'stale-image',
      ),
    ).rejects.toThrow();
    expect(t.calls).toHaveLength(count);
  });
  it.each(['commandExecution', 'fileChange'])(
    'binds %s approval to the original request and turn',
    async (type) => {
      const { t, d } = await setup();
      t.current = state({
        requests: [{ id: 42, method: `item/${type}/requestApproval`, params: { turnId: TURN } }],
      });
      t.revision = 2;
      t.snapshot();
      await d.control(
        THREAD,
        'respond',
        JSON.stringify({ targetRequestId: '42', expectedTurnId: TURN, decision: 'decline' }),
        'id',
      );
      expect(t.calls.at(-1)).toMatchObject({
        method: `thread-follower-${type === 'fileChange' ? 'file' : 'command'}-approval-decision`,
        params: { conversationId: THREAD, requestId: 42, decision: 'decline' },
      });
    },
  );
  it.each(['implement', 'revise'] as const)(
    'handles plan %s through the native follow-up turn',
    async (planDecision) => {
      const { t, d } = await setup();
      const request = {
        id: `implement-plan:${TURN}`,
        method: 'item/plan/requestImplementation',
        params: { threadId: THREAD, turnId: TURN, planContent: '# Plan\nKeep the existing composer.' },
      };
      t.current = state({ requests: [request], latestCollaborationMode: { mode: 'plan' } });
      t.revision = 2;
      t.snapshot();
      expect(d.view(THREAD)?.requests?.[0]).toMatchObject({ kind: 'plan', actionable: true });
      const answer = {
        targetRequestId: request.id,
        expectedTurnId: TURN,
        expectedFingerprint: requestFingerprint(request),
        planDecision,
        ...(planDecision === 'revise' ? { feedback: 'Preserve drafts too.' } : {}),
      };
      await d.control(THREAD, 'respond', JSON.stringify(answer), 'stable-operation-id');
      expect(t.calls.at(-1)).toMatchObject({
        method: 'thread-follower-start-turn',
        version: 2,
        params: {
          conversationId: THREAD,
          turnStart: {
            request: {
              threadId: THREAD,
              clientUserMessageId: 'stable-operation-id',
              input: [
                {
                  type: 'text',
                  text:
                    planDecision === 'implement'
                      ? `PLEASE IMPLEMENT THIS PLAN:\n${request.params.planContent}`
                      : 'Preserve drafts too.',
                },
              ],
              collaborationMode: {
                mode: planDecision === 'implement' ? 'default' : 'plan',
                settings: { model: 'desktop-model' },
              },
            },
            context: { inheritThreadSettings: true },
          },
        },
      });
      // Approval is confirmed by a new native turn; the owner, not the phone, clears the pending request.
      expect(d.view(THREAD)?.requests).toHaveLength(1);
      t.current = state({ requests: [] });
      t.revision++;
      t.snapshot();
      const calls = t.calls.length;
      await expect(d.control(THREAD, 'respond', JSON.stringify(answer), 'other-id')).rejects.toThrow('过期');
      expect(t.calls.length).toBe(calls);
    },
  );
  it.each(['fingerprint', 'turn', 'running', 'other-request', 'content', 'missing-feedback'])(
    'rejects stale/unsafe plan response: %s',
    async (scenario) => {
      const { t, d } = await setup();
      const request = {
        id: `implement-plan:${TURN}`,
        method: 'item/plan/requestImplementation',
        params: { threadId: THREAD, turnId: TURN, planContent: 'Original plan' },
      };
      const answer = {
        targetRequestId: request.id,
        expectedTurnId: TURN,
        expectedFingerprint: requestFingerprint(request),
        planDecision: scenario === 'missing-feedback' ? 'revise' : 'implement',
      };
      if (scenario === 'fingerprint') answer.expectedFingerprint = '0'.repeat(64);
      if (scenario === 'turn') request.params.turnId = 'old-turn';
      if (scenario === 'content') request.params.planContent = 'Changed plan';
      t.current = state({
        requests: [
          request,
          ...(scenario === 'other-request'
            ? [{ id: 'another', method: 'item/tool/requestUserInput', params: {} }]
            : []),
        ],
        ...(scenario === 'running' ? { threadRuntimeStatus: { type: 'active' } } : {}),
      });
      t.revision = 2;
      t.snapshot();
      const count = t.calls.length;
      await expect(d.control(THREAD, 'respond', JSON.stringify(answer), 'id')).rejects.toThrow();
      expect(t.calls.length).toBe(count);
    },
  );
  it('confirms model changes using the native unwrapped settings response', async () => {
    const { t, d } = await setup();
    const original = t.request;
    t.request = async (...args) => {
      if (args[0] === 'thread-follower-update-thread-settings') {
        t.calls.push({ method: args[0], params: args[1] });
        return { result: { applied: true } };
      }
      if (args[0] === 'thread-follower-read-model-settings')
        return { result: { settings: { model: 'another', reasoningEffort: 'low' } } };
      return original(...args);
    };
    await expect(
      d.control(
        THREAD,
        'settings',
        JSON.stringify({
          model: 'another',
          effort: 'low',
          expectedModel: 'desktop-model',
          expectedEffort: null,
        }),
        'settings-id',
      ),
    ).resolves.toBeNull();
    expect(t.calls.at(-1).params.threadSettings).toEqual({ model: 'another', effort: 'low' });
  });
  it('targets a pending question by original native request ID and turn', async () => {
    const { t, d } = await setup();
    t.current = state({
      requests: [
        {
          id: 17,
          method: 'item/tool/requestUserInput',
          params: { turnId: TURN, questions: [{ id: 'color', question: '颜色?', options: [] }] },
        },
      ],
    });
    t.revision = 2;
    t.snapshot();
    await d.control(
      THREAD,
      'respond',
      JSON.stringify({ targetRequestId: '17', expectedTurnId: TURN, answers: { color: ['蓝色'] } }),
      'response-id',
    );
    expect(t.calls.at(-1)).toMatchObject({
      method: 'thread-follower-submit-user-input',
      params: { requestId: 17, response: { answers: { color: { answers: ['蓝色'] } } } },
    });
    await expect(
      d.control(
        THREAD,
        'respond',
        JSON.stringify({ targetRequestId: '17', expectedTurnId: 'other', answers: { color: ['蓝色'] } }),
        'response-id',
      ),
    ).rejects.toThrow();
  });
  it('normalizes current requests separately from old message items', async () => {
    const { t, d } = await setup();
    t.current = state({
      requests: [
        {
          id: 'q',
          method: 'item/tool/requestUserInput',
          params: {
            turnId: TURN,
            questions: [
              {
                id: 'x',
                header: '选择',
                question: '如何继续?',
                options: [{ label: '继续', description: '继续当前工作' }],
              },
            ],
          },
        },
      ],
    });
    t.revision = 2;
    t.snapshot();
    expect(d.view(THREAD)?.requests?.[0]).toMatchObject({
      kind: 'question',
      actionable: true,
      questions: [{ id: 'x' }],
    });
    expect(d.view(THREAD)?.canSend).toBe(false);
  });
  it.each(['completed', 'inProgress'])(
    'routes async answers through the native %s turn without changing settings',
    async (status) => {
      const { t, d } = await setup();
      const turn = t.current.turnHistory.history.entitiesByKey.one;
      turn.status = status;
      turn.items.push({
        type: 'agentMessage',
        id: 'async-call',
        questions: [{ title: '选择?', options: ['蓝'] }],
      });
      t.revision++;
      t.snapshot();
      const q = d.view(THREAD)!.requests!.find((q) => q.kind === 'async-question')!;
      const data = {
        targetRequestId: q.id,
        expectedTurnId: TURN,
        expectedFingerprint: q.fingerprint,
        answers: { [q.questions![0].id]: ['蓝'] },
      };
      await d.control(THREAD, 'respond', JSON.stringify(data), 'async-op');
      const call = t.calls.at(-1);
      expect(call.method).toBe(
        status === 'inProgress' ? 'thread-follower-steer-turn' : 'thread-follower-start-turn',
      );
      const request = call.params.turnStart?.request ?? call.params;
      expect(request.clientUserMessageId).toBe('async-op');
      expect(request.input[0].text).toContain('<send_user_message_question_reply>');
      turn.items.push({ type: 'steeringUserMessage', status: 'accepted', input: request.input });
      t.revision++;
      t.snapshot();
      await expect(d.control(THREAD, 'respond', JSON.stringify(data), 'duplicate')).rejects.toThrow(
        '此问题已回答或过期',
      );
    },
  );
  it('passes file metadata via native turn context and images via localImage', async () => {
    const { t, d } = await setup();
    await d.control(
      THREAD,
      'send',
      '\u001e' + JSON.stringify({ text: '看看', attachments: [{ name: 'a.jpg', path: '/tmp/a.jpg' }] }),
      'image-op',
    );
    expect(t.calls.at(-1).params.turnStart.context.attachments).toEqual([
      { label: 'a.jpg', path: '/tmp/a.jpg', fsPath: '/tmp/a.jpg', isImageAttachment: true },
    ]);
    expect(t.calls.at(-1).params.turnStart.request.input).toContainEqual({
      type: 'localImage',
      path: '/tmp/a.jpg',
    });
  });
  it('reads canonical histories with empty legacy turns', () => {
    expect(messagesOf(state()).map((x) => x.text)).toEqual(['你好', '世界']);
  });
  it('marks long previews while preserving the complete original for on-demand reads', async () => {
    const { t, d } = await setup();
    const text = '长'.repeat(100050) + '末尾';
    t.current.turnHistory.history.entitiesByKey.one.items = [{ id: 'long', type: 'agentMessage', text }];
    t.revision = 2;
    t.snapshot();
    expect(d.view(THREAD)?.messages.at(-1)).toMatchObject({ truncated: true });
    expect(d.fullMessage(THREAD, 'long')?.text).toBe(text);
  });
  it('keeps large tool payloads off the live stream and serves complete details on demand', async () => {
    const { t, d } = await setup();
    const output = '结果'.repeat(80000) + '末尾';
    const diff = '+更改\n'.repeat(30000);
    t.current.turnHistory.history.entitiesByKey.one.items.push(
      {
        id: 'command',
        type: 'commandExecution',
        command: 'fixture',
        status: 'completed',
        aggregatedOutput: output,
      },
      {
        id: 'change',
        type: 'fileChange',
        status: 'completed',
        changes: [{ path: 'a.txt', kind: 'update', diff }],
      },
    );
    t.revision++;
    t.snapshot();
    const view = d.view(THREAD)!;
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(3000);
    expect(view.messages.slice(-2).every((m) => m.deferred && !m.output && !m.changes && !m.details)).toBe(
      true,
    );
    expect(d.fullMessage(THREAD, 'command')?.output).toBe(output);
    expect(d.fullMessage(THREAD, 'change')?.changes?.[0].diff).toBe(diff);
  });
  it('places envelope input before assistant items in partial snapshots', () => {
    const snapshot = state();
    const turn = snapshot.turnHistory.history.entitiesByKey.one;
    turn.items = turn.items.filter((item: any) => item.type !== 'userMessage');
    turn.params.input = [{ type: 'text', text: 'opening' }];
    expect(messagesOf(snapshot).map((x) => x.role)).toEqual(['user', 'assistant']);
  });
  it('subscribes once per owner and unbinds only the final observer', async () => {
    const { t, d, release } = await setup();
    const r2 = await d.acquire(THREAD);
    expect(d.view(THREAD)?.canSend).toBe(true);
    release();
    expect(t.broadcasts.filter((x) => !x.params.following)).toHaveLength(0);
    r2();
    expect(t.broadcasts.at(-1).params.following).toBe(false);
  });
  it('applies matching patches and ignores duplicate/old revisions', async () => {
    const { t, d } = await setup();
    t.patches(1, 2, [{ op: 'replace', path: ['title'], value: '新标题' }]);
    t.patches(1, 2, [{ op: 'replace', path: ['title'], value: '错误' }]);
    expect(d.view(THREAD)?.title).toBe('新标题');
    expect(d.view(THREAD)?.revision).toBe(2);
  });
  it('requests a new snapshot on a revision gap and disables controls meanwhile', async () => {
    const { t, d } = await setup();
    t.autoSnapshot = false;
    t.patches(8, 9, []);
    expect(d.view(THREAD)?.synchronized).toBe(false);
    expect(d.view(THREAD)?.canSend).toBe(false);
    expect(t.broadcasts.at(-1).params.following).toBe(true);
    t.revision = 10;
    t.snapshot();
    expect(d.view(THREAD)?.synchronized).toBe(true);
  });
  it('rejects events from other owners and hosts', async () => {
    const { t, d } = await setup();
    t.owner = 'intruder';
    t.current = state({ title: 'wrong' });
    t.snapshot();
    expect(d.view(THREAD)?.title).toBe('测试会话');
  });
  it('fails closed on unknown event versions', async () => {
    const { t, d } = await setup();
    t.emit('broadcast', {
      method: 'thread-stream-state-changed',
      sourceClientId: t.owner,
      version: 12,
      params: { hostId: 'local', conversationId: THREAD, change: {} },
    });
    expect(d.view(THREAD)?.canSend).toBe(false);
  });
  it('disables writes on an unrecognized desktop version', async () => {
    const { d } = await setup('future');
    expect(d.status().writesEnabled).toBe(false);
    await expect(d.control(THREAD, 'send', 'text', 'id')).rejects.toThrow();
  });
  it('loses authority when the desktop owner disconnects', async () => {
    const { t, d } = await setup();
    t.emit('broadcast', {
      method: 'client-status-changed',
      params: { clientId: t.owner, status: 'disconnected' },
    });
    expect(d.view(THREAD)?.owner).toBe(false);
    await expect(d.control(THREAD, 'send', 'text', 'id')).rejects.toThrow();
  });
  it('sends through the native follower, inherits settings, and pins the owner', async () => {
    const { t, d } = await setup();
    await d.control(THREAD, 'send', '仅回复测试', 'request-id');
    const call = t.calls.at(-1);
    expect(call.method).toBe('thread-follower-start-turn');
    expect(call.target).toBe(t.owner);
    expect(call.params.turnStart.request.clientUserMessageId).toBe('request-id');
    expect(call.params.turnStart.context.inheritThreadSettings).toBe(true);
    expect(call.params.turnStart.request).not.toHaveProperty('model');
    expect(call.params.turnStart.request).not.toHaveProperty('approvalPolicy');
  });
  it('pins interruptions to the currently active turn', async () => {
    const { t, d } = await setup();
    t.current = state({ threadRuntimeStatus: { type: 'active' } });
    t.current.turnHistory.history.entitiesByKey.one.status = 'inProgress';
    t.revision = 2;
    t.snapshot();
    await expect(d.control(THREAD, 'interrupt', 'other', 'id')).rejects.toThrow();
    await d.control(THREAD, 'interrupt', TURN, 'id');
    expect(t.calls.at(-1)).toMatchObject({
      method: 'thread-follower-interrupt-turn',
      version: 4,
      params: { expectedTurnId: TURN, mode: 'user-stop' },
    });
  });
  it('does not overwrite a fresh snapshot with an old snapshot', async () => {
    const { t, d } = await setup();
    t.revision = 3;
    t.current = state({ title: 'new' });
    t.snapshot();
    t.revision = 2;
    t.current = state({ title: 'old' });
    t.snapshot();
    expect(d.view(THREAD)?.title).toBe('new');
  });
});

it('confirms Fast and plan from the native revision stream and rejects stale settings', async () => {
  const { t, d } = await setup();
  const original = t.request;
  t.request = async (...args) => {
    if (args[0] === 'thread-follower-update-thread-settings') {
      t.calls.push({ method: args[0], params: args[1] });
      const settings = args[1].threadSettings;
      t.current.latestModel = settings.model;
      t.current.latestReasoningEffort = settings.effort;
      t.current.latestThreadSettings = settings;
      t.current.latestCollaborationMode = settings.collaborationMode;
      t.revision++;
      t.snapshot();
      return { result: { applied: true } };
    }
    if (args[0] === 'thread-follower-read-model-settings')
      return { result: { settings: { model: 'another', reasoningEffort: 'low' } } };
    return original(...args);
  };
  const value = {
    model: 'another',
    effort: 'low',
    mode: 'plan',
    serviceTier: 'priority',
    expectedMode: 'default',
    expectedServiceTier: null,
    expectedModel: 'desktop-model',
    expectedEffort: null,
  };
  await d.control(THREAD, 'settings', JSON.stringify(value), 'change');
  expect(d.view(THREAD)).toMatchObject({ model: 'another', mode: 'plan', serviceTier: 'priority' });
  const calls = t.calls.length;
  await expect(d.control(THREAD, 'settings', JSON.stringify(value), 'stale')).rejects.toThrow('已变化');
  expect(t.calls).toHaveLength(calls);
});
it('includes selected skills as native input while preserving attachment context and inherited settings', async () => {
  const { t, d } = await setup();
  await d.control(
    THREAD,
    'send',
    '\x1e' +
      JSON.stringify({
        text: 'inspect',
        skills: [{ name: 'inspect', path: '/skills/inspect/SKILL.md' }],
        attachments: [],
      }),
    'skill-send',
  );
  expect(t.calls.at(-1).params.turnStart).toMatchObject({
    request: {
      input: [
        { type: 'text', text: 'inspect' },
        { type: 'skill', name: 'inspect', path: '/skills/inspect/SKILL.md' },
      ],
    },
    context: { inheritThreadSettings: true },
  });
});

it('resumes an owned but unloaded desktop instead of treating ownership as readiness', async () => {
  const { c, t, d } = await setup();
  t.current = state({ threadRuntimeStatus: { type: 'notLoaded' }, resumeState: 'needs_resume' });
  t.revision++;
  t.snapshot();
  const runtime = platformRuntime();
  const open = vi.fn(async () => {
    setTimeout(() => {
      t.current = state({ threadRuntimeStatus: { type: 'idle' }, resumeState: 'resumed' });
      t.revision++;
      t.snapshot();
    }, 50);
  });
  runtime.openThread = open;
  c.platform = runtime;
  expect(d.view(THREAD)?.owner).toBe(true);
  expect(d.view(THREAD)?.canSend).toBe(false);
  await d.openThread(THREAD);
  expect(open).toHaveBeenCalledWith(THREAD);
  expect(d.view(THREAD)?.canSend).toBe(true);
  await d.openThread(THREAD);
  expect(open).toHaveBeenCalledTimes(1);
});
