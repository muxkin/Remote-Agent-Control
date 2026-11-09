import { useEffect, useState } from 'react';
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

export function AttachmentPreview({
  path,
  name,
  load,
  trigger,
  onClose,
  onCopyImage,
}: {
  path: string;
  name: string;
  load: (signal: AbortSignal) => Promise<AttachmentResource>;
  trigger: HTMLElement | null;
  onClose: () => void;
  onCopyImage: () => Promise<void>;
}) {
  const [file, setFile] = useState<AttachmentResource>();
  const [content, setContent] = useState<AttachmentPreviewContent>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
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
      <div className="file-preview-toolbar">
        <span className="file-preview-type">
          {info.kind}
          {file && ` · ${fileSize(file.size)}`}
        </span>
        <div className="file-preview-actions">
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
        <p className="file-preview-note" role="status">
          {copyStatus}
        </p>
      )}
      {(text?.truncated || (showTable && table.clipped)) && (
        <p className="file-preview-note">仅显示部分内容，可下载完整文件。</p>
      )}
      <div
        className="file-preview-content"
        tabIndex={text?.text ? 0 : undefined}
        role={text?.text ? 'region' : undefined}
        aria-label={text?.text ? '文件内容' : undefined}
      >
        {error ? (
          <div className="file-preview-state" role="alert">
            <p>{error}</p>
            <button type="button" onClick={reload}>
              重试
            </button>
          </div>
        ) : !file || !content ? (
          <p className="file-preview-state" role="status">
            正在读取文件…
          </p>
        ) : showTable ? (
          <table className="file-preview-table" aria-label="表格预览">
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
            <pre className={wrap ? 'file-preview-wrap' : ''}>{text.text}</pre>
          ) : (
            <p className="file-preview-state">文件为空。</p>
          )
        ) : content.kind === 'video' ? (
          <video
            src={file.url}
            controls
            playsInline
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
          <div className="file-preview-state">
            <a href={file.url} target="_blank" rel="noopener noreferrer">
              打开 PDF
            </a>
          </div>
        ) : content.kind === 'unsupported' ? (
          <p className="file-preview-state">{content.reason}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
