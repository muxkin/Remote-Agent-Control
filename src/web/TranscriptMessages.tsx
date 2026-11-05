import type { Message, ConversationRequest } from '../shared/types';
import { useState, type ReactNode } from 'react';
import { MessageContent } from './MessageContent';
import { Icon } from './Icon';
import codexAvatar from './assets/codex-avatar.webp';
export function TranscriptMessages({
  messages,
  threadId,
  activeTurnId,
  requests = [],
}: {
  messages: Message[];
  threadId: string;
  activeTurnId?: string | null;
  requests?: ConversationRequest[];
}) {
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
      if (!message.text && !message.attachments?.length) continue;
    }
    // Viewed images belong to their original tool activity, just like command output.
    const tools = message.role === 'tool';
    const last = groups.at(-1);
    if (tools && last?.tools && last.messages[0].turnId === message.turnId) last.messages.push(message);
    else groups.push({ key: message.id, tools, messages: [message] });
  }
  const render = (m: Message) => (
    <article key={m.id} className={`message ${m.role}`}>
      <div className="message-role">
        {m.role === 'assistant' && (
          <img className="codex-avatar" src={codexAvatar} alt="" width={32} height={32} />
        )}
        {m.role === 'user' ? '你' : m.role === 'assistant' ? 'Codex' : '工具活动'}
      </div>
      <MessageContent message={m} threadId={threadId} streaming={m.turnId === activeTurnId} />
    </article>
  );
  return groups.map((group) =>
    group.tools ? (
      <ToolActivityGroup key={group.key} count={group.messages.length}>
        {group.messages.map(render)}
      </ToolActivityGroup>
    ) : (
      render(group.messages[0])
    ),
  );
}

function ToolActivityGroup({ count, children }: { count: number; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      className="activity-group"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>
        <Icon name="stack" />
        <span>查看 {count} 项工具活动</span>
        <Icon name="chevron" size={18} />
      </summary>
      {opened && <div className="activity-body">{children}</div>}
    </details>
  );
}
