import { tsxComponent } from './tsx-component';
import { type VNodeChild } from 'vue';

import { attachmentInfo } from '../shared/attachments';
import { Icon } from './Icon';

/** One file identity across message cards, draft chips and the details surface. */
export const AttachmentIdentity = tsxComponent(function AttachmentIdentity(_props: {
  path: string;
  name: string;
  leading?: VNodeChild;
  action?: VNodeChild;
}) {
  return ({ path, name, leading, action }) => {
    const info = attachmentInfo(path, name);
    return (
      <>
        {leading ?? (
          <span class="attachment-file-icon" aria-hidden="true">
            <Icon name="document" size={24} />
            <span>{info.extension.toUpperCase() || 'FILE'}</span>
          </span>
        )}
        <span class="attachment-identity">
          <span class="attachment-filename" title={name}>
            {name}
          </span>
          <span class="attachment-meta">
            {info.kind}
            {action && <> · {action}</>}
          </span>
        </span>
      </>
    );
  };
});
