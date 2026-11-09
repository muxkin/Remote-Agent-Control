import { useCallback, useRef, useState, type ReactNode } from 'react';
import { attachmentInfo, attachmentPath } from '../shared/attachments';
import { useAttachmentAccess, type AttachmentResource } from './AttachmentAccess';
import { mediaContent, downloadFile } from './file-client';
import { AttachmentActions } from './AttachmentActions';
import { AttachmentPreview } from './AttachmentPreview';
import { Icon } from './Icon';
import { AttachmentIdentity } from './AttachmentIdentity';
import { copyImage, imageBlob } from './image-clipboard';

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
  const access = useAttachmentAccess();
  const trigger = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState(false);
  const info = attachmentInfo(href, displayName);
  const name = info.name;
  const load = useCallback(
    (signal?: AbortSignal): Promise<AttachmentResource> =>
      access ? access.load(threadId, href, signal) : mediaContent(threadId, href),
    [access, href, threadId],
  );
  const copyOriginal = () =>
    copyImage(async () => {
      const file = access ? await access.load(threadId, href, undefined, true) : await load();
      return imageBlob(file.url);
    });
  async function download() {
    const file = await load();
    downloadFile({ ...file, url: file.downloadUrl ?? file.url });
  }
  const open = () => setPreview(true);
  return (
    <span className={card ? 'file-attachment-card' : 'file-attachment-inline'}>
      <AttachmentActions
        path={href}
        name={name}
        onDownload={download}
        onCopyImage={info.media === 'image' ? copyOriginal : undefined}
        onPreview={open}
        onRemove={onRemove}
        surface={compact ? 'compact' : card ? 'card' : 'inline'}
      >
        <button
          ref={trigger}
          type="button"
          className={`file-link ${card ? 'file-card-link' : ''}`}
          title={attachmentPath(href)}
          aria-haspopup="dialog"
          onClick={open}
        >
          {card ? (
            <AttachmentIdentity
              path={href}
              name={name}
              action={!compact && <span className="attachment-primary-hint">预览</span>}
            />
          ) : (
            <>
              <Icon name={info.media === 'image' ? 'image' : 'document'} size={15} />
              <span>{children ?? name}</span>
            </>
          )}
        </button>
      </AttachmentActions>
      {preview && (
        <AttachmentPreview
          key={`${threadId}:${href}`}
          path={href}
          name={name}
          load={load}
          trigger={trigger.current}
          onClose={() => setPreview(false)}
          onCopyImage={copyOriginal}
        />
      )}
    </span>
  );
}
