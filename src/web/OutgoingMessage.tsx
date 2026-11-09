import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function OutgoingContent({
  text,
  files,
  children,
}: {
  text: string;
  files: { id: string; name: string }[];
  children?: ReactNode;
}) {
  return (
    <div className="outgoing-content">
      {children}
      {text && <div className="outgoing-text">{text}</div>}
      {!!files.length && (
        <ul className="outgoing-files">
          {files.map((file) => (
            <li key={file.id}>
              <Icon name="attach" size={15} />
              <span>{file.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OutgoingStatus({ activity, children }: { activity?: string; children?: ReactNode }) {
  return (
    <div className="outgoing-status">
      {activity ? (
        <span role="status">
          <span className="sending-spinner" aria-hidden="true" />
          {activity}
        </span>
      ) : (
        children
      )}
    </div>
  );
}
