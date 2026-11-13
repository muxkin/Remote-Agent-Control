import type { CodexActivity, Message } from '../../../src/shared/types.js';

export function timelineEvent(item: any, fallbackId: string, turnId?: string): Message | null {
  let codex: CodexActivity;
  let text: string;
  switch (item?.type) {
    case 'contextCompaction':
    case 'ContextCompaction': {
      const state = ['inProgress', 'in_progress', 'running'].includes(item.status)
        ? 'running'
        : item.status === 'failed'
          ? 'failed'
          : 'completed';
      codex = { kind: 'compaction', state };
      if (item.trigger === 'auto' || item.trigger === 'automatic') codex.automatic = true;
      text = { running: '正在压缩上下文', completed: '已压缩上下文', failed: '上下文压缩失败' }[state];
      break;
    }
    case 'subAgentActivity':
    case 'SubAgentActivity': {
      const state: unknown = item.kind;
      if (state !== 'started' && state !== 'completed' && state !== 'interrupted' && state !== 'failed')
        return null;
      const path = item.agentPath ?? item.agent_path;
      const id = item.agentThreadId ?? item.agent_thread_id ?? path;
      if (typeof id !== 'string') return null;
      const nickname = item.agentNickname ?? item.agent_nickname;
      const name =
        typeof nickname === 'string'
          ? nickname
          : typeof path === 'string'
            ? path.split('/').filter(Boolean).at(-1)
            : '';
      codex = {
        kind: 'subagent',
        state,
        agentId: id.slice(0, 160),
        name: name?.trim().slice(0, 160) || '子 Agent',
      };
      text = {
        started: '子 Agent 开始工作',
        completed: '子 Agent 已完成',
        interrupted: '子 Agent 已中断',
        failed: '子 Agent 执行失败',
      }[state];
      break;
    }
    default:
      return null;
  }
  return { id: typeof item.id === 'string' ? item.id : fallbackId, role: 'tool', text, turnId, codex };
}

export function turnTiming(turnId: string, startedAt?: number, durationMs?: number): Message | null {
  let codex: CodexActivity;
  let text: string;
  if (typeof durationMs === 'number' && Number.isSafeInteger(durationMs) && durationMs >= 0) {
    codex = { kind: 'turn-timing', state: 'completed', durationMs };
    text = '本轮用时';
  } else if (typeof startedAt === 'number' && Number.isSafeInteger(startedAt) && startedAt >= 1_000_000_000) {
    codex = {
      kind: 'turn-timing',
      state: 'running',
      startedAt: startedAt < 100_000_000_000 ? startedAt * 1000 : startedAt,
    };
    text = '正在工作';
  } else return null;
  return { id: `${turnId}:timing`, role: 'tool', text, turnId, codex };
}
