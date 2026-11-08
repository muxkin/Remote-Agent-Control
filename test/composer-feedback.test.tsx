import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationFeedback, operationActivity } from '../src/web/OperationFeedback';
import { UploadProgress, type UploadItem } from '../src/web/UploadProgress';
import type { Operation } from '../src/shared/types';

const operation: Operation = {
  id: 'fixture',
  threadId: 'thread',
  kind: 'send',
  state: 'received',
  turnId: null,
  error: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
it('keeps ordinary sending and successful delivery out of the composer banner', () => {
  for (const state of ['received', 'dispatching', 'accepted', 'completed', 'interrupted'] as const)
    expect(renderToStaticMarkup(<OperationFeedback operation={{ ...operation, state }} />)).toBe('');
  expect(operationActivity(operation)).toBe('正在发送…');
});
it('keeps uncertain delivery and rejection actionable without an automatic resend', () => {
  const uncertain = renderToStaticMarkup(
    <OperationFeedback operation={{ ...operation, state: 'uncertain' }} onCheck={async () => {}} />,
  );
  expect(uncertain).toContain('核对状态');
  expect(uncertain).not.toContain('发送草稿');
  const failed = renderToStaticMarkup(
    <OperationFeedback operation={{ ...operation, state: 'rejected', error: '未发送' }} onRetry={() => {}} />,
  );
  expect(failed).toContain('发送草稿');
  expect(failed).toContain('role="alert"');
});
const file: UploadItem = {
  id: 'file',
  name: 'note.txt',
  state: 'done',
  phase: 'finalizing',
  total: 20,
  loaded: 20,
};
it('removes completed upload progress immediately and preserves unfinished files and errors', () => {
  expect(renderToStaticMarkup(<UploadProgress items={[file]} />)).toBe('');
  const active = renderToStaticMarkup(
    <UploadProgress
      items={[
        file,
        { ...file, id: 'next', name: 'next.txt', state: 'active', phase: 'uploading', loaded: 10 },
      ]}
    />,
  );
  expect(active).toContain('next.txt');
  expect(active).toContain('50%');
  expect(active).not.toContain('note.txt');
  expect(active).not.toContain('附件已就绪');
  const failed = renderToStaticMarkup(
    <UploadProgress items={[{ ...file, state: 'failed', error: '空间不足' }]} onDismiss={() => {}} />,
  );
  expect(failed).toContain('空间不足');
  expect(failed).toContain('清除上传错误');
});
