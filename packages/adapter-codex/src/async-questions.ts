import { createHash } from 'node:crypto';
import type { ConversationRequest, RequestResponse } from '../../../src/shared/types.js';
import { DeliveryError } from './transport.js';
import { userContent } from './user-content.js';

const prefix = '<send_user_message_question_reply>\n';
const suffix = '\n</send_user_message_question_reply>';
type Reply = { questionItemId: string; question: string; answer: string };
export function questionReplies(raw: string): Reply[] | null {
  const text = userContent(raw).text.trim();
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  try {
    const parsed = JSON.parse(text.slice(prefix.length, -suffix.length));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.length &&
      rows.every(
        (row) => row && ['questionItemId', 'question', 'answer'].every((key) => typeof row[key] === 'string'),
      )
      ? rows
      : null;
  } catch {
    return null;
  }
}
export function userMessageText(raw: string): string {
  return (
    questionReplies(raw)
      ?.map((reply) => `${reply.question}\n${reply.answer}`)
      .join('\n\n') ?? userContent(raw).text
  );
}
export function asyncQuestionRequest(item: any, turnId: string): ConversationRequest | null {
  if (
    item.type !== 'agentMessage' ||
    typeof item.id !== 'string' ||
    !Array.isArray(item.questions) ||
    !item.questions.length
  )
    return null;
  if (
    !item.questions.every(
      (q: any) =>
        typeof q.title === 'string' &&
        (!q.options || (Array.isArray(q.options) && q.options.every((o: any) => typeof o === 'string'))),
    )
  )
    return null;
  const questions = item.questions.map((q: any, index: number) => ({
    id: JSON.stringify(['request_user_input_async', item.id, index]),
    header: `问题 ${index + 1}`,
    question: q.title,
    options: (q.options ?? []).map((label: string) => ({ label, description: '' })),
  }));
  return {
    id: `async:${item.id}`,
    kind: 'async-question',
    turnId,
    questions,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([turnId, item.id, questions]))
      .digest('hex'),
    title: 'Codex 需要你的回答',
    description: '',
    actionable: true,
  };
}
/** Native async prompts live on assistant items, not the blocking requests collection. */
export function asyncRequests(
  turns: { id: string; input: string; items: any[] }[],
  textOf: (content: any) => string,
): ConversationRequest[] {
  const pending = new Map<string, ConversationRequest>();
  const answered = new Set<string>();
  const readReply = (text: string) => {
    for (const row of questionReplies(text) ?? []) answered.add(row.questionItemId);
  };
  for (const turn of turns) {
    const opening = turn.input || textOf(turn.items.find((item) => item.type === 'userMessage')?.content);
    // A new ordinary user turn supersedes older optional questions. Keep their text in
    // history, but don't revive prompts already addressed conversationally on another device.
    if (opening.trim() && !questionReplies(opening)) pending.clear();
    readReply(opening);
    for (const item of turn.items) {
      const request = asyncQuestionRequest(item, turn.id);
      if (request) pending.set(request.id, request);
      if (item.type === 'userMessage' || (item.type === 'steeringUserMessage' && item.status === 'accepted'))
        readReply(textOf(item.content ?? item.input ?? item.text));
    }
  }
  return [...pending.values()].flatMap((request) => {
    const questions = request.questions!.filter((q) => !answered.has(q.id));
    return questions.length
      ? [
          {
            ...request,
            questions,
            fingerprint: createHash('sha256')
              .update(JSON.stringify([request.fingerprint, questions]))
              .digest('hex'),
          },
        ]
      : [];
  });
}
export function asyncReply(request: ConversationRequest, answer: RequestResponse): string {
  if (
    request.id !== answer.targetRequestId ||
    request.turnId !== answer.expectedTurnId ||
    request.fingerprint !== answer.expectedFingerprint
  )
    throw new DeliveryError('此问题已变化或过期，请重新核对', true);
  const questions = request.questions ?? [];
  if (
    !answer.answers ||
    Object.keys(answer.answers).length !== questions.length ||
    questions.some((q) => answer.answers?.[q.id]?.length !== 1 || !answer.answers[q.id][0].trim())
  )
    throw new DeliveryError('请回答所有当前问题', true);
  return (
    prefix +
    JSON.stringify(
      questions.map((q) => ({
        questionItemId: q.id,
        question: q.question,
        answer: answer.answers![q.id][0],
      })),
    ) +
    suffix
  );
}
