import type { ReactNode } from 'react';
import { Icon } from '../Icon';
export function PageHeader({
  title,
  back,
  children,
}: {
  title: string;
  back?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <button className="icon-button" aria-label="返回" onClick={back}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}
