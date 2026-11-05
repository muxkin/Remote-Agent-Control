import { userContent } from './user-content.js';
import { asyncRequests, asyncQuestionRequest, userMessageText } from './async-questions.js';
import type { Message, ThreadView, ConversationRequest } from '../shared/types.js';
import { itemMedia, mediaReference } from './content-media.js';
import { normalizeRequest } from './approvals.js';

type Json = Record<string, any>;
/** Desktop canonical history consists of ordered islands referencing entities. */
export function orderedEntities(value: any): Json[] {
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === 'object');
  if (!value || typeof value !== 'object') return [];
  if (value.kind === 'canonical') return orderedEntities(value.history);
  const entities = value.entitiesByKey;
  if (!entities || !Array.isArray(value.islands)) return [];
  const seen = new Set<string>();
  const result: Json[] = [];
  for (const island of value.islands)
    for (const entry of island.entries ?? []) {
      const key = entry.value;
      if (typeof key === 'string' && !seen.has(key) && entities[key]) {
        seen.add(key);
        result.push(entities[key]);
      }
    }
  return result;
}
export function turnsOf(state: Json): Json[] {
  return state.turnHistory?.kind === 'canonical'
    ? orderedEntities(state.turnHistory)
    : orderedEntities(state.turns);
}
export function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((x) => ['text', 'input_text', 'output_text'].includes(x?.type) && typeof x.text === 'string')
    .map((x) => x.text)
    .join('\n');
}
export function skillsOf(content: any): string[] {
  return Array.isArray(content)
    ? content.filter((i) => i?.type === 'skill' && typeof i.name === 'string').map((i) => i.name)
    : [];
}
export function pluginsOf(content: any): string[] {
  return Array.isArray(content)
    ? content
        .filter((i) => i?.type === 'mention' && typeof i.name === 'string' && i.path?.startsWith('plugin://'))
        .map((i) => i.name)
    : [];
}
export function requestsOf(state: Json): ConversationRequest[] {
  const rows = Array.isArray(state.requests) ? state.requests : Object.values(state.requests ?? {});
  const items = turnsOf(state).flatMap((turn) => orderedEntities(turn.items));
  return [
    ...rows
      .filter((request: any) => !request.completed)
      .map((request: any) => normalizeRequest(request, items)),
    ...asyncRequests(
      turnsOf(state).map((turn) => ({
        id: turn.turnId ?? turn.id,
        input: textOf(turn.params?.input),
        items: orderedEntities(turn.items),
      })),
      textOf,
    ),
  ];
}
export function messagesOf(state: Json, full = false): Message[] {
  const messages: Message[] = [];
  for (const turn of turnsOf(state)) {
    const turnId = turn.turnId ?? turn.id;
    const items = orderedEntities(turn.items);
    // The opening input belongs before the assistant, including partial snapshots.
    if (!items.some((x) => x.type === 'userMessage') && textOf(turn.params?.input)) {
      messages.push({
        id: `${turnId}:input`,
        role: 'user',
        ...userContent(textOf(turn.params.input)),
        text: userMessageText(textOf(turn.params.input)),
        turnId,
        clientMessageId: turn.params?.clientUserMessageId,
        skills: skillsOf(turn.params?.input),
        plugins: pluginsOf(turn.params?.input),
      });
    }
    for (const [index, item] of items.entries()) {
      const type = item.type;
      if (type === 'reasoning') continue;
      const media = itemMedia(item);
      for (const [number, source] of media.entries())
        messages.push({
          id: `${item.id ?? `${turnId}:${index}`}:media:${number}`,
          role: ['userMessage', 'steeringUserMessage'].includes(type)
            ? 'user'
            : type === 'imageView'
              ? 'tool'
              : 'assistant',
          text: `![${type === 'imageView' ? '查看的图片' : '会话附件'}](<${mediaReference(source).replace(/</g, '%3C').replace(/>/g, '%3E')}>)`,
          turnId,
        });
      let role: Message['role'];
      let text = '';
      let attachments: Message['attachments'];
      if (type === 'userMessage' || type === 'steeringUserMessage') {
        role = 'user';
        const raw = textOf(item.content ?? item.input ?? item.text);
        text = userMessageText(raw);
        attachments = userContent(raw).attachments?.filter((file) => !media.includes(file.path));
      } else if (type === 'agentMessage') {
        role = 'assistant';
        text = textOf(item.text ?? item.content);
        const question = asyncQuestionRequest(item, turnId);
        if (question)
          text += `${text ? '\n\n' : ''}${question.questions!.map((q) => q.question).join('\n\n')}`;
      } else if (
        ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(type)
      ) {
        role = 'tool';
        text =
          type === 'commandExecution'
            ? `命令 · ${String(item.command ?? '').slice(0, 240)}`
            : `工具 · ${item.tool ?? type}`;
        text += ` · ${item.status ?? '执行中'}`;
      } else if (type === 'imageGeneration' || (type === 'imageView' && media.length)) continue;
      else if (type === 'userInputResponse') {
        role = 'tool';
        text = '问题回答';
      } else {
        role = 'tool';
        text = `${type ?? '活动'} · ${item.status ?? '已记录'}`;
      }
      if (text || attachments?.length)
        messages.push({
          id: String(item.id ?? `${turnId}:${index}`),
          role,
          text,
          attachments,
          skills: role === 'user' ? skillsOf(item.content ?? item.input ?? turn.params?.input) : undefined,
          plugins: role === 'user' ? pluginsOf(item.content ?? item.input ?? turn.params?.input) : undefined,
          turnId,
          clientMessageId:
            item.clientId ??
            item.clientUserMessageId ??
            (type === 'userMessage' ? turn.params?.clientUserMessageId : undefined),
          phase: item.phase,
          changes:
            type === 'fileChange' && Array.isArray(item.changes)
              ? item.changes.map((c: any) => ({
                  path: String(c.path ?? ''),
                  kind: String(c.kind?.type ?? c.kind ?? 'update'),
                  diff: String(c.diff ?? '').slice(0, full ? undefined : 100000),
                }))
              : undefined,
          output:
            type === 'commandExecution'
              ? String(item.aggregatedOutput ?? item.output ?? '').slice(0, full ? undefined : 100000)
              : undefined,
          details:
            role === 'tool'
              ? JSON.stringify(
                  item,
                  (key, value) =>
                    [
                      'encrypted_content',
                      'reasoning',
                      'reasoningText',
                      'summary',
                      'token',
                      'accessToken',
                    ].includes(key)
                      ? undefined
                      : key === 'data' && typeof value === 'string' && value.length > 4096
                        ? '[附件单独展示]'
                        : value,
                  2,
                )
              : undefined,
        });
    }
  }
  return messages.slice(-500).map((message) => {
    if (full || (message.text.length <= 100000 && (message.details?.length ?? 0) <= 100000)) return message;
    return {
      ...message,
      text: message.text.slice(0, 100000),
      details: message.details?.slice(0, 100000),
      truncated: true,
    };
  });
}
export function normalizedView(state: Json, revision: number, writable: boolean): ThreadView {
  const turns = turnsOf(state);
  const active = turns.findLast((t) => t.status === 'inProgress');
  const runtimeStatus = state.threadRuntimeStatus?.type ?? (active ? 'active' : 'idle');
  const activeTurnId = active?.turnId ?? active?.id ?? null;
  const pendingRequests = Array.isArray(state.requests)
    ? state.requests.length
    : Object.keys(state.requests ?? {}).length;
  const canSend = writable && runtimeStatus === 'idle' && !active && pendingRequests === 0;
  return {
    id: state.id,
    title: state.title ?? '未命名会话',
    cwd: state.cwd ?? '',
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : Date.parse(state.updatedAt) || 0,
    revision,
    owner: true,
    synchronized: true,
    messages: messagesOf(state),
    activeTurnId,
    runtimeStatus,
    model: state.latestModel ?? null,
    reasoningEffort: state.latestReasoningEffort ?? null,
    serviceTier: state.latestThreadSettings?.serviceTier ?? null,
    pendingRequests,
    requests: requestsOf(state),
    mode: state.latestCollaborationMode?.mode ?? 'default',
    canSend,
    canInterrupt: writable && !!activeTurnId,
    reason: !writable
      ? '当前连接仅允许查看'
      : pendingRequests
        ? '任务正在等待回答或审批；可用操作见会话卡片'
        : runtimeStatus === 'active' || active
          ? '任务运行中；追加指令会进入当前任务，也可以中断'
          : runtimeStatus !== 'idle'
            ? '桌面会话尚未就绪'
            : null,
  };
}
