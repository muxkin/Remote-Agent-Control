import type { ReactNode } from 'react';
import { Icon } from '../Icon';

/** IM and workspace share geometry; their content and actions remain independent. */
export function ConversationHeader({
  className,
  title,
  subtitle,
  status,
  backLabel,
  onBack,
  level = 1,
  children,
}: {
  className: string;
  title: string;
  subtitle: ReactNode;
  status?: ReactNode;
  backLabel: string;
  onBack: () => void;
  level?: 1 | 2;
  children?: ReactNode;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header className={`conversation-header ${className}`}>
      <button className="icon-button conversation-back" aria-label={backLabel} onClick={onBack}>
        <Icon name="back" />
      </button>
      <div className="conversation-heading">
        <Heading>
          <span className="conversation-title" title={title}>
            {title}
          </span>
          {status}
        </Heading>
        <div className="conversation-subtitle">{subtitle}</div>
      </div>
      <div className="conversation-header-actions">{children}</div>
    </header>
  );
}
