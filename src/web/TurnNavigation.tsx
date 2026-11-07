import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Message } from '../shared/types';
import './turn-navigation.css';

/** A quiet index of loaded user turns, used only by workbench conversations. */
export function TurnNavigation({
  messages,
  transcript,
  onNavigate,
}: {
  messages: Message[];
  transcript: RefObject<HTMLElement | null>;
  onNavigate: () => void;
}) {
  const turns = useMemo(() => messages.filter((m) => m.role === 'user'), [messages]);
  const [active, setActive] = useState('');
  const [preview, setPreview] = useState<{ id: string; top: number }>();
  const marks = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = transcript.current;
    if (!root || turns.length < 2) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top + 64;
      const nodes = [...root.querySelectorAll<HTMLElement>('[data-user-turn]')];
      let current: HTMLElement | undefined = nodes[0];
      for (const node of nodes) {
        if (node.getBoundingClientRect().top > top) break;
        current = node;
      }
      if (root.scrollHeight - root.scrollTop - root.clientHeight < 12) current = nodes.at(-1);
      setActive(current?.dataset.userTurn ?? '');
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root.querySelectorAll('.message, .activity-group').forEach((node) => observer.observe(node));
    root.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.removeEventListener('scroll', schedule);
    };
  }, [turns, transcript]);
  useEffect(() => {
    const root = marks.current;
    const selected = root?.querySelector<HTMLElement>('[aria-current="step"]');
    if (root && selected)
      root.scrollTop = selected.offsetTop - root.clientHeight / 2 + selected.offsetHeight / 2;
  }, [active]);
  if (turns.length < 2) return null;
  const selected = turns.find((m) => m.id === preview?.id);
  const label = (m: Message) =>
    m.text.trim().replace(/\s+/g, ' ').slice(0, 140) ||
    m.attachments?.map((f) => f.name).join('、') ||
    '附件消息';
  return (
    <nav className="turn-navigation" aria-label="会话提问导航" onMouseLeave={() => setPreview(undefined)}>
      <div className="turn-navigation-marks" ref={marks} onScroll={() => setPreview(undefined)}>
        {turns.map((turn, index) => (
          <button
            key={turn.id}
            type="button"
            aria-label={`第 ${index + 1} 条提问：${label(turn)}`}
            aria-current={active === turn.id ? 'step' : undefined}
            onMouseEnter={(e) =>
              setPreview({ id: turn.id, top: e.currentTarget.offsetTop - (marks.current?.scrollTop ?? 0) })
            }
            onFocus={(e) =>
              setPreview({ id: turn.id, top: e.currentTarget.offsetTop - (marks.current?.scrollTop ?? 0) })
            }
            onBlur={() => setPreview(undefined)}
            onClick={() => {
              const root = transcript.current;
              const node = [...(root?.querySelectorAll<HTMLElement>('[data-user-turn]') ?? [])].find(
                (el) => el.dataset.userTurn === turn.id,
              );
              if (!root || !node) return;
              onNavigate();
              // Native scrolling reveals content-visibility subtrees before positioning them.
              node.scrollIntoView({ block: 'start', behavior: 'instant' });
              setActive(turn.id);
              setPreview(undefined);
            }}
          >
            <span />
          </button>
        ))}
      </div>
      {selected && (
        <div className="turn-navigation-preview" style={{ top: preview!.top }} role="tooltip">
          <span>{label(selected)}</span>
          <small>
            用户提问 · {turns.indexOf(selected) + 1} / {turns.length}
          </small>
        </div>
      )}
    </nav>
  );
}
