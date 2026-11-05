import type { Message } from '../shared/types';
import { LocalLink, Media } from './RichMessage';

export default function UserAttachments({
  files,
  threadId,
}: {
  files: NonNullable<Message['attachments']>;
  threadId: string;
}) {
  return (
    <div className="user-attachments">
      {files.map((file) =>
        /\.(png|jpe?g|gif|webp|mp4|webm|mov|mp3|wav|ogg|m4a)$/i.test(file.path) ? (
          <Media key={file.path} src={file.path} label={file.name} threadId={threadId} />
        ) : (
          <LocalLink key={file.path} href={file.path} threadId={threadId}>
            {file.name}
          </LocalLink>
        ),
      )}
    </div>
  );
}
