import type { FileDiff } from '../shared/types';
export function DiffView({ changes }: { changes: FileDiff[] }) {
  return (
    <div className="diff-files">
      {changes.map((change, index) => (
        <details className="diff-file" key={`${change.path}:${index}`}>
          <summary>
            <span>{change.kind === 'add' ? '新增' : change.kind === 'delete' ? '删除' : '修改'}</span>{' '}
            {change.path}
          </summary>
          <pre aria-label={`Diff ${change.path}`}>
            {change.diff.split('\n').map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith('@@')
                    ? 'diff-hunk'
                    : line.startsWith('+')
                      ? 'diff-add'
                      : line.startsWith('-')
                        ? 'diff-remove'
                        : ''
                }
              >
                {line || ' '}
              </span>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
