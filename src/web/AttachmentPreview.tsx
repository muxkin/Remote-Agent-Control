import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { writeRef, watchRender } from './render-effects';

import { attachmentInfo } from '../shared/attachments';
import type { AttachmentResource } from './AttachmentAccess';
import { attachmentPreviewContent, type AttachmentPreviewContent } from './attachment-preview';
import { downloadFile } from './file-client';
import { Icon } from './Icon';
import { ImagePreview } from './ImagePreview';
import { Dialog } from './shell/Dialog';
import './file-preview.css';

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export const AttachmentPreview = tsxComponent(function AttachmentPreview(_props: {
  path: string;
  name: string;
  load: (signal: AbortSignal) => Promise<AttachmentResource>;
  trigger: HTMLElement | null;
  onClose: () => void;
  onCopyImage: () => Promise<void>;
}) {
  const fileState = shallowRef<AttachmentResource>();
  const setFile = writeRef(fileState);
  const contentState = shallowRef<AttachmentPreviewContent>();
  const setContent = writeRef(contentState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const retryState = shallowRef(0);
  const setRetry = writeRef(retryState);
  const sourceState = shallowRef(false);
  const setSource = writeRef(sourceState);
  const wrapState = shallowRef(true);
  const setWrap = writeRef(wrapState);
  const copyStatusState = shallowRef('');
  const setCopyStatus = writeRef(copyStatusState);
  const watchFile = watchRender();
  return ({ path, name, load, trigger, onClose, onCopyImage }) => {
    const file = fileState.value;
    const content = contentState.value;
    const error = errorState.value;
    const retry = retryState.value;
    const source = sourceState.value;
    const wrap = wrapState.value;
    const copyStatus = copyStatusState.value;

    watchFile(() => {
      const controller = new AbortController();
      void (async () => {
        try {
          const resource = await load(controller.signal);
          if (controller.signal.aborted) return;
          setFile(resource);
          const preview = await attachmentPreviewContent(resource, path, controller.signal);
          if (controller.signal.aborted) return;
          setContent(preview);
          setError('');
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '文件读取失败');
        }
      })();
      return () => controller.abort();
    }, [load, path, retry]);

    function reload() {
      setError('');
      setRetry((value) => value + 1);
    }

    const title = file?.name || name;
    const info = attachmentInfo(path, title);
    const download = file ? () => downloadFile({ ...file, url: file.downloadUrl ?? file.url }) : undefined;
    if (file && content?.kind === 'image') {
      return (
        <ImagePreview
          src={file.url}
          label={title}
          error={error}
          reload={retry}
          returnFocus={trigger}
          onClose={onClose}
          onCopy={onCopyImage}
          onDownload={download}
          onError={() => setError('图片加载失败，请重试')}
          onRetry={reload}
        />
      );
    }

    const text = content?.kind === 'text' ? content : undefined;
    const table = text?.table;
    const showTable = !!table?.rows.length && !source;
    const columns = showTable ? Math.max(...table.rows.map((row) => row.length)) : 0;
    return (
      <Dialog title={title} className="file-preview" onClose={onClose} returnFocus={trigger}>
        {() => (
          <>
            <div class="file-preview-toolbar">
              <span class="file-preview-type">
                {info.kind}
                {file && ` · ${fileSize(file.size)}`}
              </span>
              <div class="file-preview-actions">
                {!!table?.rows.length && (
                  <button type="button" onClick={() => setSource(!source)}>
                    {source ? '查看表格' : '查看原文'}
                  </button>
                )}
                {!!text?.text && !showTable && (
                  <button type="button" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                    自动换行
                  </button>
                )}
                {!!text?.text && !showTable && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(text.text);
                        setCopyStatus('已复制');
                      } catch {
                        setCopyStatus('复制失败，可选中文字手动复制');
                      }
                    }}
                  >
                    <Icon name="copy" size={16} />
                    {text.truncated ? '复制预览' : '复制文本'}
                  </button>
                )}
                {download && (
                  <button type="button" onClick={download}>
                    <Icon name="download" size={16} />
                    下载
                  </button>
                )}
              </div>
            </div>
            {copyStatus && (
              <p class="file-preview-note" role="status">
                {copyStatus}
              </p>
            )}
            {(text?.truncated || (showTable && table.clipped)) && (
              <p class="file-preview-note">仅显示部分内容，可下载完整文件。</p>
            )}
            <div
              class="file-preview-content"
              tabindex={text?.text ? 0 : undefined}
              role={text?.text ? 'region' : undefined}
              aria-label={text?.text ? '文件内容' : undefined}
            >
              {error ? (
                <div class="file-preview-state" role="alert">
                  <p>{error}</p>
                  <button type="button" onClick={reload}>
                    重试
                  </button>
                </div>
              ) : !file || !content ? (
                <p class="file-preview-state" role="status">
                  正在读取文件…
                </p>
              ) : showTable ? (
                <table class="file-preview-table" aria-label="表格预览">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      {Array.from({ length: columns }, (_, index) => (
                        <th scope="col" key={index}>
                          {index >= 26 && 'A'}
                          {String.fromCharCode(65 + (index % 26))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, index) => (
                      <tr key={index}>
                        <th scope="row">{index + 1}</th>
                        {Array.from({ length: columns }, (_, column) => (
                          <td key={column}>{row[column]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : text ? (
                text.text ? (
                  <pre class={wrap ? 'file-preview-wrap' : ''}>{text.text}</pre>
                ) : (
                  <p class="file-preview-state">文件为空。</p>
                )
              ) : content.kind === 'video' ? (
                <video
                  src={file.url}
                  controls
                  playsinline
                  preload="metadata"
                  onError={() => setError('视频无法播放，请重试')}
                />
              ) : content.kind === 'audio' ? (
                <audio
                  src={file.url}
                  controls
                  preload="metadata"
                  onError={() => setError('音频无法播放，请重试')}
                />
              ) : content.kind === 'pdf' ? (
                <div class="file-preview-state">
                  <a href={file.url} target="_blank" rel="noopener noreferrer">
                    打开 PDF
                  </a>
                </div>
              ) : content.kind === 'unsupported' ? (
                <p class="file-preview-state">{content.reason}</p>
              ) : null}
            </div>
          </>
        )}
      </Dialog>
    );
  };
});
