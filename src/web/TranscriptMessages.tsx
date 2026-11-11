import { writeRef } from './render-effects';
import { tsxComponent } from './tsx-component';
import { shallowRef, type VNodeChild } from 'vue';
import type { Message, ConversationRequest } from '../shared/types';
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
    const groups: { key: string; tools: boolean; messages: Message[] }[] = [];
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
      // Viewed images belong to their original tool activity, just like command output.
      const tools = message.role === 'tool';
      const last = groups.at(-1);
      if (tools && last?.tools && last.messages[0].turnId === message.turnId) last.messages.push(message);
      else groups.push({ key: message.id, tools, messages: [message] });
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
    return groups.map((group) =>
      group.tools ? (
        <ToolActivityGroup key={group.key} count={group.messages.length}>
          {() => <>{group.messages.map(render)}</>}
        </ToolActivityGroup>
      ) : (
        render(group.messages[0])
      ),
    );
  };
});

const ToolActivityGroup = tsxComponent(function ToolActivityGroup(_props: {
  count: number;
  children?: VNodeChild;
}) {
  const openedState = shallowRef(false);
  const setOpened = writeRef(openedState);
  return ({ count, children }) => {
    const opened = openedState.value;
    return (
      <details
        class="activity-group"
        onToggle={(event) => {
          if ((event.currentTarget as HTMLDetailsElement).open) setOpened(true);
        }}
      >
        <summary>
          <Icon name="stack" />
          <span>查看 {count} 项工具活动</span>
          <Icon name="chevron" size={18} />
        </summary>
        {opened && <div class="activity-body">{children}</div>}
      </details>
    );
  };
});
