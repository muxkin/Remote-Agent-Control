import { writeRef } from '../render-effects';
import { tsxComponent } from '../tsx-component';
import { shallowRef, useId, type VNodeChild } from 'vue';

import { Icon } from '../Icon';
import { PageHeader } from './PageHeader';

/** Shared search/filter controls for the message and contact directories. */
export const DirectoryControls = tsxComponent(function DirectoryControls(_props: {
  title: string;
  action: VNodeChild;
  searchLabel: string;
  query: string;
  onQuery: (value: string) => void;
  filterLabel: string;
  filter: string;
  onFilter: (value: string) => void;
  options: readonly (readonly [string, string])[];
}) {
  const searchingState = shallowRef(false);
  const setSearching = writeRef(searchingState);
  const searchId = useId();
  const trigger = shallowRef<HTMLButtonElement | null>(null);
  return ({ title, action, searchLabel, query, onQuery, filterLabel, filter, onFilter, options }) => {
    const searching = searchingState.value;

    const closeSearch = () => {
      onQuery('');
      setSearching(false);
      trigger.value?.focus();
    };
    return (
      <>
        <PageHeader title={title}>
          {() => (
            <>
              <button
                ref={trigger}
                class="icon-button directory-search-toggle"
                aria-label="搜索"
                title={searchLabel}
                aria-expanded={searching}
                aria-controls={searchId}
                onClick={() => (searching ? closeSearch() : setSearching(true))}
              >
                <Icon name={searching ? 'close' : 'search'} size={21} />
              </button>
              {action}
            </>
          )}
        </PageHeader>
        <div class="directory-tools">
          {searching && (
            <label class="directory-search" id={searchId}>
              <Icon name="search" size={19} />
              <input
                aria-label={searchLabel}
                placeholder={searchLabel}
                value={query}
                autofocus
                onVnodeMounted={(vnode) => (vnode.el as HTMLElement).focus()}
                onKeydown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
                onInput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
          )}
          <div class="directory-filters" role="group" aria-label={filterLabel}>
            {options.map(([value, label]) => (
              <button key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </>
    );
  };
});

/** A single row anatomy keeps avatars, names and secondary copy aligned across directories. */
export const DirectoryRow = tsxComponent(function DirectoryRow(_props: {
  className?: string;
  selected?: boolean;
  avatar: VNodeChild;
  title: string;
  preview: VNodeChild;
  meta?: VNodeChild;
  badge?: VNodeChild;
  trailing?: VNodeChild;
  onClick: () => void;
}) {
  return ({ className = '', selected, avatar, title, preview, meta, badge, trailing, onClick }) => {
    return (
      <button class={`directory-row ${className} ${selected ? 'selected' : ''}`} onClick={onClick}>
        {avatar}
        <span class="directory-row-copy">
          <span class="directory-row-title">
            <strong>{title}</strong>
            {meta}
          </span>
          <span class="directory-row-preview">
            <small>{preview}</small>
            {badge}
          </span>
        </span>
        {trailing}
      </button>
    );
  };
});
