import type { MemoryCitationEntry } from '../shared/types';
import { Icon } from './Icon';
import './codex-transcript-metadata.css';

export function MemoryCitations({ entries }: { entries: MemoryCitationEntry[] }) {
  return (
    <details className="memory-citations">
      <summary>
        <Icon name="document" size={16} />
        <span>记忆引用</span>
        <small>{entries.length} 条</small>
        <Icon name="chevron" size={14} />
      </summary>
      <ul>
        {entries.map(({ source, lineStart, lineEnd, note }, index) => (
          <li key={index}>
            <small>
              {source} · {lineStart === lineEnd ? `第 ${lineStart} 行` : `第 ${lineStart}–${lineEnd} 行`}
            </small>
            {note && <p>{note}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}
