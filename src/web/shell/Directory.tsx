import { useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../Icon';
import { PageHeader } from './PageHeader';

/** Shared search/filter controls for the message and contact directories. */
export function DirectoryControls({
  title,
  action,
  searchLabel,
  query,
  onQuery,
  filterLabel,
  filter,
  onFilter,
  options,
}: {
  title: string;
  action: ReactNode;
  searchLabel: string;
  query: string;
  onQuery: (value: string) => void;
  filterLabel: string;
  filter: string;
  onFilter: (value: string) => void;
  options: readonly (readonly [string, string])[];
}) {
  const [searching, setSearching] = useState(false);
  const searchId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    onQuery('');
    setSearching(false);
    trigger.current?.focus();
  };
  return (
    <>
      <PageHeader title={title}>
        <button
          ref={trigger}
          className="icon-button directory-search-toggle"
          aria-label="搜索"
          title={searchLabel}
          aria-expanded={searching}
          aria-controls={searchId}
          onClick={() => (searching ? closeSearch() : setSearching(true))}
        >
          <Icon name={searching ? 'close' : 'search'} size={21} />
        </button>
        {action}
      </PageHeader>
      <div className="directory-tools">
        {searching && (
          <label className="directory-search" id={searchId}>
            <Icon name="search" size={19} />
            <input
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSearch();
                }
              }}
              onChange={(e) => onQuery(e.target.value)}
            />
          </label>
        )}
        <div className="directory-filters" role="group" aria-label={filterLabel}>
          {options.map(([value, label]) => (
            <button key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** A single row anatomy keeps avatars, names and secondary copy aligned across directories. */
export function DirectoryRow({
  className = '',
  selected,
  avatar,
  title,
  preview,
  meta,
  badge,
  trailing,
  onClick,
}: {
  className?: string;
  selected?: boolean;
  avatar: ReactNode;
  title: string;
  preview: ReactNode;
  meta?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={`directory-row ${className} ${selected ? 'selected' : ''}`} onClick={onClick}>
      {avatar}
      <span className="directory-row-copy">
        <span className="directory-row-title">
          <strong>{title}</strong>
          {meta}
        </span>
        <span className="directory-row-preview">
          <small>{preview}</small>
          {badge}
        </span>
      </span>
      {trailing}
    </button>
  );
}
