import type { Message } from '../shared/types';
import { FileAttachment } from './FileAttachment';
import { Media } from './MediaAttachment';
import { attachmentInfo } from '../shared/attachments';

export default function UserAttachments({
  files,
  threadId,
  compact = false,
  onRemove,
}: {
  files: NonNullable<Message['attachments']>;
  threadId: string;
  compact?: boolean;
  onRemove?: (path: string) => void;
}) {
  return (
    <div className="user-attachments">
      {files.map((file) =>
        (compact ? attachmentInfo(file.path).media === 'image' : attachmentInfo(file.path).media) ? (
          <Media
            key={file.path}
            src={file.path}
            label={file.name}
            threadId={threadId}
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
}
