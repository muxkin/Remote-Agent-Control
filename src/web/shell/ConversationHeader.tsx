import { tsxComponent } from '../tsx-component';
import { h, type VNodeChild } from 'vue';

import { Icon } from '../Icon';

/** IM and workspace share geometry; their content and actions remain independent. */
export const ConversationHeader = tsxComponent(function ConversationHeader(_props: {
  className: string;
  title: string;
  subtitle: VNodeChild;
  status?: VNodeChild;
  backLabel: string;
  onBack: () => void;
  level?: 1 | 2;
  children?: VNodeChild;
}) {
  return ({ className, title, subtitle, status, backLabel, onBack, level = 1, children }) => {
    const Heading = level === 1 ? 'h1' : 'h2';
    return (
      <header class={`conversation-header ${className}`}>
        <button class="icon-button conversation-back" aria-label={backLabel} onClick={onBack}>
          <Icon name="back" />
        </button>
        <div class="conversation-heading">
          {h(Heading, null, [
            <span class="conversation-title" title={title}>
              {title}
            </span>,
            status,
          ])}
          <div class="conversation-subtitle">{subtitle}</div>
        </div>
        <div class="conversation-header-actions">{children}</div>
      </header>
    );
  };
});
