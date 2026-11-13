import { watchRender, writeRef } from './render-effects';
import { tsxComponent } from './tsx-component';
import { shallowRef, type VNodeChild } from 'vue';
import type { Message, ConversationRequest, CodexActivity } from '../shared/types';
import { MessageContent } from './MessageContent';
import { Icon } from './Icon';
export const TranscriptMessages = tsxComponent(function TranscriptMessages(_props: {
  messages: Message[];
  threadId: string;
  activeTurnId?: string | null;
  requests?: ConversationRequest[];
  agent: { name: string; avatar?: string };
  codex: boolean;
  onFork?: (turnId: string) => void;
  forkDisabled?: boolean;
}) {
  return ({ messages, threadId, activeTurnId, requests = [], agent, codex, onFork, forkDisabled }) => {
    const agentVariants = new Map<string, number>();
    const groups: { key: string; kind: 'tools' | 'started' | 'message'; messages: Message[] }[] = [];
    for (const original of messages) {
      let message = original;
      const question = requests.find(
        (request) => request.kind === 'async-question' && request.id === `async:${message.id}`,
      );
      if (question) {
        const suffix = question.questions!.map((q) => q.question).join('\n\n');
        if (message.text.endsWith(suffix))
          message = { ...message, text: message.text.slice(0, -suffix.length).trimEnd() };
        if (!message.text && !message.attachments?.length && !message.codex) continue;
      }
      const metadata = message.codex;
      if (metadata?.kind === 'subagent' && !agentVariants.has(metadata.agentId))
        agentVariants.set(metadata.agentId, agentVariants.size % agentIcons.length);
      const kind =
        metadata?.kind === 'subagent' && metadata.state === 'started'
          ? 'started'
          : message.role === 'tool' && (!metadata || metadata.kind === 'memory')
            ? 'tools'
            : 'message';
      const last = groups.at(-1);
      if (kind !== 'message' && last?.kind === kind && last.messages[0].turnId === message.turnId)
        last.messages.push(message);
      else groups.push({ key: message.id, kind, messages: [message] });
    }
    const render = (m: Message) => (
      <article key={m.id} class={`message ${m.role}`} data-user-turn={m.role === 'user' ? m.id : undefined}>
        <div class="message-role">
          {m.role === 'assistant' && agent.avatar && (
            <img class="codex-avatar" src={agent.avatar} alt="" width={32} height={32} />
          )}
          {m.role === 'user' ? '你' : m.role === 'assistant' ? agent.name : '工具活动'}
        </div>
        <MessageContent
          message={m}
          threadId={threadId}
          streaming={!!activeTurnId && m.turnId === activeTurnId}
          codex={codex}
          onFork={onFork && m.turnBoundary && m.turnId ? () => onFork(m.turnId!) : undefined}
          forkDisabled={forkDisabled}
        />
      </article>
    );
    return groups.map((group) => {
      if (group.kind === 'tools')
        return (
          <ToolActivityGroup key={group.key} count={group.messages.length} inline={codex}>
            {() => <>{group.messages.map(render)}</>}
          </ToolActivityGroup>
        );
      const first = group.messages[0];
      if (first.codex?.kind === 'turn-timing') return <TurnTiming key={group.key} timing={first.codex} />;
      if (first.codex?.kind === 'compaction')
        return <CompactionNotice key={group.key} activity={first.codex} />;
      if (first.codex?.kind === 'subagent') {
        const agents = group.messages.flatMap((message) =>
          message.codex?.kind === 'subagent' ? [message.codex] : [],
        );
        return (
          <SubagentNotice
            key={group.key}
            agents={agents}
            state={first.codex.state}
            variants={agentVariants}
          />
        );
      }
      return render(first);
    });
  };
});

const TurnTiming = tsxComponent(function TurnTiming(_props: {
  timing: Extract<CodexActivity, { kind: 'turn-timing' }>;
}) {
  const now = shallowRef(Date.now());
  const watchClock = watchRender();
  return ({ timing }) => {
    const startedAt = timing.state === 'running' ? timing.startedAt : undefined;
    watchClock(() => {
      if (startedAt === undefined) return;
      now.value = Date.now();
      const timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
      return () => clearInterval(timer);
    }, [startedAt]);
    const ms = timing.state === 'completed' ? timing.durationMs : now.value - timing.startedAt;
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const elapsed = [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', `${seconds % 60} 秒`]
      .filter(Boolean)
      .join(' ');
    return (
      <div class="transcript-notice turn-timing">
        {timing.state === 'running' ? '已工作' : '本轮用时'} {elapsed}
      </div>
    );
  };
});

function CompactionNotice({ activity }: { activity: Extract<CodexActivity, { kind: 'compaction' }> }) {
  const label = {
    running: '正在压缩上下文',
    completed: activity.automatic ? '已自动压缩上下文' : '已压缩上下文',
    failed: '上下文压缩失败',
  }[activity.state];
  return (
    <div class="transcript-notice" role="status">
      <Icon name="compaction" size={19} />
      <span>{label}</span>
    </div>
  );
}

const agentIcons = ['grid', 'target', 'branch', 'bot'] as const;
type SubagentActivity = Extract<CodexActivity, { kind: 'subagent' }>;
function subagentName(name: string) {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)
    ? name[0].toUpperCase() + name.slice(1).replaceAll('_', ' ')
    : name;
}

function SubagentNotice({
  agents,
  state,
  variants,
}: {
  agents: SubagentActivity[];
  state: SubagentActivity['state'];
  variants: Map<string, number>;
}) {
  const unique = [...new Map(agents.map((agent) => [agent.agentId, agent])).values()];
  const action = { started: '开始工作', completed: '已完成', interrupted: '已中断', failed: '执行失败' }[
    state
  ];
  return (
    <div class="transcript-notice">
      <span class="subagent-icons" aria-hidden="true">
        {unique.slice(0, 4).map((agent) => {
          const variant = variants.get(agent.agentId) ?? 0;
          return (
            <span key={agent.agentId} class={`subagent-icon subagent-icon-${variant}`}>
              <Icon name={agentIcons[variant]} size={14} />
            </span>
          );
        })}
      </span>
      <span>
        {unique.map((agent) => subagentName(agent.name)).join('、')} {action}
      </span>
    </div>
  );
}

const ToolActivityGroup = tsxComponent(function ToolActivityGroup(_props: {
  count: number;
  inline?: boolean;
  children?: VNodeChild;
}) {
  const openedState = shallowRef(false);
  const setOpened = writeRef(openedState);
  return ({ count, inline, children }) => {
    const opened = openedState.value;
    return (
      <details
        class={inline ? 'activity-group activity-group-inline' : 'activity-group'}
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) setOpened(true);
        }}
      >
        <summary>
          <Icon name="stack" size={inline ? 19 : 22} />
          <span>查看 {count} 项工具活动</span>
          <Icon name="chevron" size={18} />
        </summary>
        {opened && <div class="activity-body">{children}</div>}
      </details>
    );
  };
});
