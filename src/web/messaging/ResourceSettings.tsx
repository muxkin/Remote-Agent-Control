import { useEffect, useRef, useState } from 'react';
import type { ResourceFile, ResourceStatus } from '../../shared/resources';
import { messaging, useMessaging } from './context';
import { Confirm, errorText, Notice } from './ui';

const bytes = (n: number | null) =>
  n === null
    ? '不限额'
    : n >= 1e9
      ? `${(n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`
      : n >= 1e6
        ? `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`
        : `${n.toLocaleString()} B`;

export default function ResourceSettings() {
  const { user, refresh } = useMessaging();
  const [status, setStatus] = useState<ResourceStatus>();
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState('');
  const [selection, setSelection] = useState<ResourceFile[]>();
  const active = useRef<AbortController | undefined>(undefined);
  const load = async (signal?: AbortSignal) => {
    const result = await messaging.raw<ResourceStatus>('/resources', 'GET', undefined, signal);
    if (!signal?.aborted) setStatus(result);
  };
  useEffect(() => {
    const abort = new AbortController();
    setStatus(undefined);
    setError('');
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(errorText(e));
    });
    return () => {
      abort.abort();
      active.current?.abort();
    };
  }, [user?.id]);
  const inventory = async (signal: AbortSignal) => {
    const files: ResourceFile[] = [];
    let cursor: string | undefined;
    do {
      const page: { files: ResourceFile[]; cursor?: string } = await messaging.raw(
        `/resources/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      );
      files.push(...page.files);
      cursor = page.cursor;
    } while (cursor);
    return files;
  };
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const abort = new AbortController();
    active.current = abort;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action(abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) setError(errorText(e));
    } finally {
      if (active.current === abort) {
        setBusy(false);
        setProgress('');
        active.current = undefined;
      }
    }
  };
  const download = async (signal: AbortSignal) => {
    if (!messaging.account.secrets) throw Error('请先解锁账号，再下载解密后的文件');
    const files = await inventory(signal);
    if (!files.length) {
      setNotice('没有可下载的文件');
      return;
    }
    // Load ZIP support only when exporting; each part is released before generating the next.
    const { exportResources } = await import('../../client/resource-export');
    const result = await exportResources(
      files,
      (f) => messaging.download(f.url, signal),
      async (chunks, name) => {
        signal.throwIfAborted();
        const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        // Give the browser time to take the download before releasing this bounded part.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        URL.revokeObjectURL(url);
      },
      (n) => setProgress(`正在解密下载 ${n} / ${files.length}`),
      signal,
    );
    setNotice(
      result.failed.length
        ? `已导出 ${result.downloaded} 个文件；${result.failed.length} 个未能解密或读取，详情在下载包内。请在浏览器确认保存，云端文件未删除。`
        : `已生成 ${result.downloaded} 个文件的下载包，请在浏览器下载列表确认保存。云端文件未删除。`,
    );
  };
  return (
    <section className="im-settings-section im-resources" aria-label="空间与中转流量">
      <div className="im-resource-title">
        <h3>空间与中转流量</h3>
        <button className="secondary" disabled={busy} onClick={() => void run((signal) => load(signal))}>
          刷新
        </button>
      </div>
      {status ? (
        <>
          <p className="im-help">{status.label}</p>
          <div className="im-resource-meter">
            <span>附件空间</span>
            <strong>
              {bytes(status.storage.used)} / {bytes(status.storage.limit)}
            </strong>
            {status.storage.limit !== null && (
              <progress
                max={Math.max(1, status.storage.limit)}
                value={Math.min(status.storage.used, status.storage.limit)}
              />
            )}
          </div>
          {status.managed && (
            <div className="im-resource-meter">
              <span>本月中转流量</span>
              <strong>
                {bytes(status.relay.used)} / {bytes(status.relay.limit)}
              </strong>
              <progress
                max={Math.max(1, status.relay.limit!)}
                value={Math.min(status.relay.used, status.relay.limit!)}
              />
              <small>
                {new Date(status.relay.resetsAt).toLocaleString('zh-CN', {
                  timeZone: status.relay.timeZone,
                })}{' '}
                恢复额度（{status.relay.timeZone}）
              </small>
            </div>
          )}
          <p className="im-help">
            空间包含附件、收藏表情和头像，以及所属 Agent
            的文件。空间不足时拒绝新增文件；清理不影响已消耗的中转流量。 当前中转统计 WSS
            双向传输，不计直连和附件下载。
          </p>
        </>
      ) : (
        <p>{error ? '暂时无法读取额度' : '正在读取额度…'}</p>
      )}
      <div className="im-resource-actions">
        <button className="secondary" disabled={busy} onClick={() => void run(download)}>
          一键下载（解密）
        </button>
        <button
          className="secondary danger"
          disabled={busy}
          onClick={() =>
            void run(async (signal) => {
              const files = await inventory(signal);
              if (!files.length) setNotice('没有可清理的文件');
              else setSelection(files);
            })
          }
        >
          一键清理
        </button>
        {busy && (
          <button
            className="secondary"
            onClick={() => {
              active.current?.abort();
              setBusy(false);
              setProgress('');
            }}
          >
            取消
          </button>
        )}
      </div>
      <p className="im-help">
        下载在本机解密，不会删除云端文件；文件较多时分包下载，请允许浏览器下载多个文件。Agent
        的私有文件需要对应解密密钥。
      </p>
      <Notice text={error} />
      {(progress || notice) && <p role="status">{progress || notice}</p>}
      {selection && (
        <Confirm
          title="清理云端文件"
          onCancel={() => setSelection(undefined)}
          onConfirm={async () => {
            let removed = 0;
            try {
              for (let i = 0; i < selection.length; i += 100) {
                const result = await messaging.raw<{ removed: number }>('/resources/cleanup', 'POST', {
                  files: selection.slice(i, i + 100).map(({ kind, id }) => ({ kind, id })),
                });
                removed += result.removed;
              }
              setNotice(`已清理 ${removed} 个文件。消息文字和账户密钥已保留。`);
            } catch (e) {
              setError(`已清理 ${removed} 个文件，其余尚未完成：${errorText(e)}`);
            } finally {
              setSelection(undefined);
              await load().catch(() => {});
              await refresh();
            }
          }}
        >
          将永久清理当前列出的 {selection.length} 个附件、表情和头像（包含所属 Agent
          的文件）。已发送的附件也会失效。请先下载并确认文件可以打开；本次操作不会清理之后上传的新文件。
        </Confirm>
      )}
    </section>
  );
}
