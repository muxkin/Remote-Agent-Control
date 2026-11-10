import { tsxComponent } from './tsx-component';
import { shallowRef, type VNodeChild } from 'vue';
import { memoizeRender, writeRef } from './render-effects';

import { attachmentInfo, attachmentPath } from '../shared/attachments';
import { useAttachmentAccess, type AttachmentResource } from './AttachmentAccess';
import { mediaContent, downloadFile } from './file-client';
import { AttachmentActions } from './AttachmentActions';
import { AttachmentPreview } from './AttachmentPreview';
import { Icon } from './Icon';
import { AttachmentIdentity } from './AttachmentIdentity';
import { copyImage, imageBlob } from './image-clipboard';

export const FileAttachment = tsxComponent(function FileAttachment(_props: {
  href: string;
  threadId: string;
  children?: VNodeChild;
  card?: boolean;
  compact?: boolean;
  name?: string;
  onRemove?: () => void;
}) {
  const attachmentAccess = useAttachmentAccess();
  const trigger = shallowRef<HTMLButtonElement | null>(null);
  const previewState = shallowRef(false);
  const setPreview = writeRef(previewState);
  const readLoad = memoizeRender();
  return ({ href, threadId, children, card = false, compact = false, name: displayName, onRemove }) => {
    const access = attachmentAccess.value;

    const preview = previewState.value;
    const info = attachmentInfo(href, displayName);
    const name = info.name;
    const load = readLoad(
      () =>
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
      <span class={card ? 'file-attachment-card' : 'file-attachment-inline'}>
        <AttachmentActions
          path={href}
          name={name}
          onDownload={download}
          onCopyImage={info.media === 'image' ? copyOriginal : undefined}
          onPreview={open}
          onRemove={onRemove}
          surface={compact ? 'compact' : card ? 'card' : 'inline'}
        >
          {() => (
            <>
              <button
                ref={trigger}
                type="button"
                class={`file-link ${card ? 'file-card-link' : ''}`}
                title={attachmentPath(href)}
                aria-haspopup="dialog"
                onClick={open}
              >
                {card ? (
                  <AttachmentIdentity
                    path={href}
                    name={name}
                    action={!compact && <span class="attachment-primary-hint">预览</span>}
                  />
                ) : (
                  <>
                    <Icon name={info.media === 'image' ? 'image' : 'document'} size={15} />
                    <span>{children ?? name}</span>
                  </>
                )}
              </button>
            </>
          )}
        </AttachmentActions>
        {preview && (
          <AttachmentPreview
            key={`${threadId}:${href}`}
            path={href}
            name={name}
            load={load}
            trigger={trigger.value}
            onClose={() => setPreview(false)}
            onCopyImage={copyOriginal}
          />
        )}
      </span>
    );
  };
});
