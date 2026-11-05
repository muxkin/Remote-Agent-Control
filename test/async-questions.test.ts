import { describe, it, expect } from 'vitest';
import { asyncReply, questionReplies, userMessageText } from '../src/server/async-questions.js';
import { normalizedView, requestsOf, messagesOf } from '../src/server/timeline.js';
import { state, TURN } from './helpers.js';
function snapshot(status = 'completed') {
  const s = state();
  Object.assign(s.turnHistory.history.entitiesByKey.one, {
    status,
    items: [
      {
        id: 'q',
        type: 'agentMessage',
        text: '',
        questions: [{ title: '选颜色', options: ['蓝色', '红色'] }, { title: '输入备注' }],
      },
    ],
  });
  return s;
}
function answer(s: any) {
  const request = requestsOf(s)[0];
  return {
    targetRequestId: request.id,
    expectedTurnId: TURN,
    expectedFingerprint: request.fingerprint,
    answers: Object.fromEntries(request.questions!.map((q, i) => [q.id, [i ? '自定义备注' : '蓝色']])),
  };
}
describe('Desktop asynchronous questions', () => {
  it('finds choice/freeform questions outside requests even after the turn finishes without blocking normal send', () => {
    const s = snapshot();
    const view = normalizedView(s, 1, true);
    expect(view.canSend).toBe(true);
    expect(view.pendingRequests).toBe(0);
    expect(view.requests?.[0]).toMatchObject({
      kind: 'async-question',
      questions: [{ options: [{ label: '蓝色' }, { label: '红色' }] }, { options: [] }],
    });
    expect(messagesOf(s)[0].text).toBe('你好');
    expect(messagesOf(s).at(-1)?.text).toBe('选颜色\n\n输入备注');
  });
  it('uses the desktop question IDs and displays replies without transport markup', () => {
    const s = snapshot();
    const text = asyncReply(requestsOf(s)[0], answer(s));
    expect(questionReplies(text)?.[0].questionItemId).toBe(
      JSON.stringify(['request_user_input_async', 'q', 0]),
    );
    expect(userMessageText(text)).toBe('选颜色\n蓝色\n\n输入备注\n自定义备注');
    expect(
      questionReplies('<send_user_message_question_reply>\ninvalid\n</send_user_message_question_reply>'),
    ).toBeNull();
  });
  it('removes answered cards after accepted steering or later turns and survives a full reconnect snapshot', () => {
    for (const type of ['userMessage', 'steeringUserMessage']) {
      const s = snapshot();
      const reply = asyncReply(requestsOf(s)[0], answer(s));
      s.turnHistory.history.entitiesByKey.one.items.push({
        type,
        id: 'reply',
        input: [{ type: 'text', text: reply }],
        status: 'accepted',
      });
      expect(requestsOf(structuredClone(s))).toEqual([]);
    }
    const s = snapshot();
    const text = asyncReply(requestsOf(s)[0], answer(s));
    s.turnHistory.history.islands[0].entries.push({ value: 'two' });
    (s.turnHistory.history.entitiesByKey as any).two = {
      turnId: 'later',
      params: { input: [{ type: 'text', text }] },
      items: [],
    };
    expect(requestsOf(s)).toEqual([]);
  });
  it('preserves a steering reply identity independently of the opening user message', () => {
    const s = snapshot();
    s.turnHistory.history.entitiesByKey.one.items.push({
      type: 'steeringUserMessage',
      id: 'steer',
      clientUserMessageId: 'reply-client',
      input: [{ type: 'text', text: '回复' }],
      status: 'accepted',
    });
    expect(messagesOf(s).find((message) => message.id === 'steer')?.clientMessageId).toBe('reply-client');
  });
  it('expires older optional cards after a new ordinary user turn, without deleting question history', () => {
    const s = snapshot();
    s.turnHistory.history.islands[0].entries.push({ value: 'two' });
    (s.turnHistory.history.entitiesByKey as any).two = {
      turnId: 'new-topic',
      params: { input: [{ type: 'text', text: '已经恢复正常，继续' }] },
      items: [],
    };
    expect(requestsOf(s)).toEqual([]);
    expect(messagesOf(s).some((message) => message.text.includes('选颜色'))).toBe(true);
  });
  it('does not mark rejected steering as answered and rejects stale or incomplete answers', () => {
    const s = snapshot('inProgress');
    const request = requestsOf(s)[0];
    const a = answer(s);
    const reply = asyncReply(request, a);
    s.turnHistory.history.entitiesByKey.one.items.push({
      type: 'steeringUserMessage',
      input: [{ type: 'text', text: reply }],
      status: 'rejected',
    });
    expect(requestsOf(s)).toHaveLength(1);
    expect(() => asyncReply(request, { ...a, expectedFingerprint: 'stale' })).toThrow();
    expect(() => asyncReply(request, { ...a, expectedTurnId: 'different' })).toThrow();
    expect(() => asyncReply(request, { ...a, answers: {} })).toThrow();
  });
});
