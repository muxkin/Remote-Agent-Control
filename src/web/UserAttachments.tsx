import { tsxComponent } from './tsx-component';
import type { Message } from '../shared/types';
import { FileAttachment } from './FileAttachment';
import { Media } from './MediaAttachment';
import { attachmentInfo } from '../shared/attachments';

export default tsxComponent(function UserAttachments(_props: {
  files: NonNullable<Message['attachments']>;
  threadId: string;
  compact?: boolean;
  onRemove?: (path: string) => void;
}) {
  return ({ files, threadId, compact = false, onRemove }) => {
    const attachments = files.map((file) => ({
      ...file,
      media: file.media ?? attachmentInfo(file.path).media ?? attachmentInfo(file.path, file.name).media,
    }));
    const gallery = !compact && attachments.filter((file) => file.media === 'image').length > 1;
    return (
      <div class={`user-attachments${gallery ? ' attachment-gallery' : ''}`}>
        {attachments.map((file) =>
          (compact ? file.media === 'image' : file.media) ? (
            <Media
              key={file.path}
              src={file.path}
              label={file.name}
              threadId={threadId}
              mediaType={file.media ?? undefined}
              compact={compact}
              onRemove={onRemove ? () => onRemove(file.path) : undefined}
            />
          ) : (
            <FileAttachment
              key={file.path}
              href={file.path}
              threadId={threadId}
              card
              compact={compact}
              name={file.name}
              onRemove={onRemove ? () => onRemove(file.path) : undefined}
            />
          ),
        )}
      </div>
    );
  };
});
