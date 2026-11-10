import { tsxComponent } from './tsx-component';
import { type VNodeChild } from 'vue';

import { Icon } from './Icon';

export const OutgoingContent = tsxComponent(function OutgoingContent(_props: {
  text: string;
  files: { id: string; name: string }[];
  children?: VNodeChild;
}) {
  return ({ text, files, children }) => {
    return (
      <div class="outgoing-content">
        {children}
        {text && <div class="outgoing-text">{text}</div>}
        {!!files.length && (
          <ul class="outgoing-files">
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
  };
});

export const OutgoingStatus = tsxComponent(function OutgoingStatus(_props: {
  activity?: string;
  children?: VNodeChild;
}) {
  return ({ activity, children }) => {
    return (
      <div class="outgoing-status">
        {activity ? (
          <span role="status">
            <span class="sending-spinner" aria-hidden="true" />
            {activity}
          </span>
        ) : (
          children
        )}
      </div>
    );
  };
});
