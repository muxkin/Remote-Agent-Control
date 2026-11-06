import { useState, type ReactNode } from 'react';
import { attachmentInfo, attachmentPath } from '../shared/attachments';
import { mediaContent, downloadFile } from './file-client';
import { AttachmentActions } from './AttachmentActions';
import { ImagePreview } from './ImagePreview';
import { Icon } from './Icon';
import { AttachmentIdentity } from './AttachmentIdentity';

export function FileAttachment({
  href,
  threadId,
  children,
  card = false,
  compact = false,
  name: displayName,
  onRemove,
}: {
  href: string;
  threadId: string;
  children?: ReactNode;
  card?: boolean;
  compact?: boolean;
  name?: string;
  onRemove?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof mediaContent>> | null>(null);
  const [reload, setReload] = useState(0);
  const info = attachmentInfo(href);
  const name = displayName || info.name;
  async function download() {
    downloadFile(await mediaContent(threadId, href));
  }
  async function open() {
    if (busy) return;
    // Open browser previews within the user gesture; binary files use a named download directly.
    const textOrPdf = info.previewable && info.media !== 'image';
    const tab = textOrPdf ? window.open('about:blank', '_blank') : null;
    if (tab) tab.opener = null;
    setBusy(true);
    setError('');
    try {
      const file = await mediaContent(threadId, href);
      if (file.mime.startsWith('image/')) {
        tab?.close();
        setPreview(file);
      } else if (tab && /^(text\/plain|application\/(pdf|json))(;|$)/.test(file.mime))
        tab.location.href = file.url;
      else {
        tab?.close();
        downloadFile(file);
      }
    } catch (error) {
      tab?.close();
      setError(error instanceof Error ? error.message : '文件不可用');
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className={card ? 'file-attachment-card' : 'file-attachment-inline'}>
      <AttachmentActions
        path={href}
        name={name}
        onDownload={download}
        onPreview={info.previewable ? open : undefined}
        onRemove={onRemove}
        surface={compact ? 'compact' : card ? 'card' : 'inline'}
      >
        {(showDetails) => (
          <button
            type="button"
            className={`file-link ${card ? 'file-card-link' : ''}`}
            title={attachmentPath(href)}
            disabled={busy}
            aria-haspopup={!card ? 'dialog' : undefined}
            onClick={(event) => (card ? void open() : showDetails(event.currentTarget))}
          >
            {card ? (
              <AttachmentIdentity
                path={href}
                name={name}
                action={
                  !compact && (
                    <span className="attachment-primary-hint">
                      {busy ? '正在读取…' : info.previewable ? '预览' : '下载'}
                    </span>
                  )
                }
              />
            ) : (
              <>
                <Icon name="document" size={15} />
                <span>{children ?? name}</span>
              </>
            )}
          </button>
        )}
      </AttachmentActions>
      {error && (
        <small className="attachment-error" role="alert">
          {error}
        </small>
      )}
      {preview && (
        <ImagePreview
          src={preview.url}
          label={name}
          error={error}
          reload={reload}
          onClose={() => setPreview(null)}
          onError={() => setError('图片加载失败，请重试')}
          onRetry={() => {
            setReload((value) => value + 1);
            void open();
          }}
        />
      )}
    </span>
  );
}
