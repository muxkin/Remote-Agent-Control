import type { ReactNode } from 'react';
import { attachmentInfo } from '../shared/attachments';
import { Icon } from './Icon';

/** One file identity across message cards, draft chips and the details surface. */
export function AttachmentIdentity({
  path,
  name,
  leading,
  action,
}: {
  path: string;
  name: string;
  leading?: ReactNode;
  action?: ReactNode;
}) {
  const info = attachmentInfo(path, name);
  return (
    <>
      {leading ?? (
        <span className="attachment-file-icon" aria-hidden="true">
          <Icon name="document" size={24} />
          <span>{info.extension.toUpperCase() || 'FILE'}</span>
        </span>
      )}
      <span className="attachment-identity">
        <span className="attachment-filename" title={name}>
          {name}
        </span>
        <span className="attachment-meta">
          {info.kind}
          {action && <> · {action}</>}
        </span>
      </span>
    </>
  );
}
