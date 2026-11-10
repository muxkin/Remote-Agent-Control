import { tsxComponent } from './tsx-component';
import type { FileDiff } from '../shared/types';
export const DiffView = tsxComponent(function DiffView(_props: { changes: FileDiff[] }) {
  return ({ changes }) => {
    return (
      <div class="diff-files">
        {changes.map((change, index) => (
          <details class="diff-file" key={`${change.path}:${index}`}>
            <summary>
              <span>{change.kind === 'add' ? '新增' : change.kind === 'delete' ? '删除' : '修改'}</span>{' '}
              {change.path}
            </summary>
            <pre aria-label={`Diff ${change.path}`}>
              {change.diff.split('\n').map((line, index) => (
                <span
                  key={index}
                  class={
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
  };
});
