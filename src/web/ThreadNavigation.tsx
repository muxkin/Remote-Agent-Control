import { remoteFetch } from './device-session';
import { useEffect, useRef, useState } from 'react';
import type { ProjectSummary, ThreadSummary } from '../shared/types';
import { Icon } from './Icon';
import type { BackendInfo } from '../shared/backends';
import { backendAppearanceDefaults } from '../shared/backend-appearance';
import { BackendIcon } from './BackendIcon';
type Page = { threads: ThreadSummary[]; nextCursor: string | null };
export function ThreadNavigation({
  projects,
  threads,
  cursor,
  selected,
  connected,
  loading,
  onSelect,
  onRefresh,
  onMore,
  onCreate,
  pendingQuestions,
  agentName = 'Codex',
  backend,
  onWorkbench,
  canCreate,
}: {
  projects: { projects: ProjectSummary[]; total: number; ungrouped: number };
  threads: ThreadSummary[];
  cursor: string | null;
  selected: ThreadSummary | null;
  connected: boolean;
  loading: boolean;
  onSelect: (t: ThreadSummary) => void;
  onRefresh: () => void;
  onMore: () => void;
  onCreate: (projectId?: string) => void;
  pendingQuestions: number;
  agentName?: string;
  backend?: BackendInfo;
  onWorkbench?: () => void;
  canCreate?: boolean;
}) {
  const [tab, setTab] = useState<'recent' | 'projects'>('recent'),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>()),
    [pages, setPages] = useState<Record<string, Page>>({});
  const [searchPage, setSearchPage] = useState<Page>(),
    [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(new Set<string>()),
    [error, setError] = useState('');
  const generation = useRef(0);
  const searchGeneration = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    searchGeneration.current++;
    if (!search) {
      setSearchPage(undefined);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    remoteFetch(`/api/threads?q=${encodeURIComponent(search)}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw Error('搜索失败，请重试');
        return r.json();
      })
      .then(setSearchPage)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [search]);
  // New server catalog invalidates group pages only on explicit refresh, not on every render.
  useEffect(() => {
    generation.current++;
    setPages({});
    setBusy(new Set());
  }, [projects]);
  async function loadGroup(id: string, next?: string) {
    if (busy.has(id)) return;
    const epoch = generation.current;
    setBusy((old) => new Set(old).add(id));
    setError('');
    try {
      const q = new URLSearchParams({ project: id });
      if (next) q.set('cursor', next);
      const r = await remoteFetch(`/api/threads?${q}`);
      if (!r.ok) throw Error('项目会话加载失败');
      const data: Page = await r.json();
      if (epoch === generation.current)
        setPages((old) => ({
          ...old,
          [id]: { ...data, threads: next ? [...(old[id]?.threads ?? []), ...data.threads] : data.threads },
        }));
    } catch (e) {
      if (epoch === generation.current) setError((e as Error).message);
    } finally {
      if (epoch === generation.current)
        setBusy((old) => {
          const next = new Set(old);
          next.delete(id);
          return next;
        });
    }
  }
  useEffect(() => {
    for (const id of expanded) if (!pages[id] && !busy.has(id)) void loadGroup(id);
  }, [expanded, pages, projects]);
  function toggle(id: string) {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function moreSearch() {
    if (!searchPage?.nextCursor) return;
    const epoch = searchGeneration.current;
    const current = search;
    setSearching(true);
    try {
      const r = await remoteFetch(
        `/api/threads?${new URLSearchParams({ q: current, cursor: searchPage.nextCursor })}`,
      );
      if (!r.ok) throw Error('搜索失败，请重试');
      const data: Page = await r.json();
      if (epoch !== searchGeneration.current) return;
      setSearchPage((old) => ({ ...data, threads: [...(old?.threads ?? []), ...data.threads] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (epoch === searchGeneration.current) setSearching(false);
    }
  }
  const rows = (items: ThreadSummary[], grouped = false) =>
    items.map((t) => (
      <button
        key={t.id}
        className={`thread-button ${selected?.id === t.id ? 'selected' : ''}`}
        onClick={() => onSelect(t)}
      >
        {grouped && <span className="thread-node" />}
        <span className="thread-label">
          <strong>{t.title || '未命名会话'}</strong>
          <small>
            {grouped
              ? t.cwd.split(/[\\/]/).filter(Boolean).at(-1) || '本地会话'
              : (t.projectName ?? '未分类')}
          </small>
        </span>
        <span className="thread-meta">
          <time>{relativeTime(t.updatedAt)}</time>
          {t.id === selected?.id && pendingQuestions > 0 && <small className="awaiting">待回答</small>}
        </span>
      </button>
    ));
  const groups = [...projects.projects, { id: 'none', name: '未分类', count: projects.ungrouped }];
  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <h1>
          {onWorkbench ? (
            <button className="text-button" onClick={onWorkbench}>
              ← 工作台
            </button>
          ) : (
            '工作台'
          )}
        </h1>
        <button
          className="new-thread-button"
          disabled={canCreate === undefined ? !threads.length && !selected : !canCreate}
          onClick={() => onCreate([...expanded].find((id) => id !== 'none'))}
        >
          <Icon name="plusCircle" size={20} />
          新会话
        </button>
      </header>
      <div className="workspace-tool">
        <BackendIcon
          icon={
            backend
              ? (backend.appearance ?? backendAppearanceDefaults(backend)).icon
              : { kind: 'builtin', value: 'puzzle' }
          }
          product={backend?.product}
        />
        <div>
          <strong>{agentName}</strong>
          <span>项目与任务</span>
        </div>
      </div>
      <label className="search-field nav-search">
        <Icon name="search" size={20} />
        <input
          type="search"
          aria-label="搜索项目或会话"
          placeholder="搜索项目或会话"
          maxLength={120}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="nav-tabs">
        <div role="tablist" aria-label="会话视图">
          <button role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>
            最近
          </button>
          <button role="tab" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}>
            项目
          </button>
        </div>
        <button
          type="button"
          className="icon-button refresh-list"
          aria-label="刷新会话列表"
          aria-busy={loading}
          title="刷新会话列表"
          disabled={loading}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <nav aria-label="会话列表">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {search ? (
          <>
            {searching && (
              <p className="list-label" role="status">
                正在搜索…
              </p>
            )}
            {!searching && !searchPage?.threads.length && <p className="list-label">没有匹配的项目或会话</p>}
            {rows(searchPage?.threads ?? [])}
            {searchPage?.nextCursor && (
              <button className="secondary more" disabled={searching} onClick={() => void moreSearch()}>
                更多搜索结果
              </button>
            )}
          </>
        ) : tab === 'recent' ? (
          <>
            {loading && (
              <p className="list-label" role="status">
                正在加载…
              </p>
            )}
            {rows(threads)}
            {!loading && !threads.length && <p className="list-label">暂无会话</p>}
            {cursor && (
              <button className="secondary more" disabled={loading} onClick={onMore}>
                加载更多会话
              </button>
            )}
          </>
        ) : (
          groups.map((p) => (
            <section className="project-group" key={p.id}>
              <button
                className="project-heading"
                aria-expanded={expanded.has(p.id)}
                onClick={() => toggle(p.id)}
              >
                <Icon name={expanded.has(p.id) ? 'down' : 'chevron'} size={17} />
                <Icon name={p.id === 'none' ? 'stack' : 'folder'} size={23} />
                <strong>{p.name}</strong>
                <span>{p.count}</span>
              </button>
              {expanded.has(p.id) && (
                <div className="project-threads">
                  {rows(pages[p.id]?.threads ?? [], true)}
                  {busy.has(p.id) && (
                    <p className="list-label" role="status">
                      正在加载…
                    </p>
                  )}
                  {!busy.has(p.id) && pages[p.id]?.threads.length === 0 && (
                    <p className="list-label">此项目暂无会话</p>
                  )}
                  {pages[p.id]?.nextCursor && (
                    <button
                      className="secondary more"
                      onClick={() => void loadGroup(p.id, pages[p.id].nextCursor!)}
                      disabled={busy.has(p.id)}
                    >
                      加载更多会话
                    </button>
                  )}
                </div>
              )}
            </section>
          ))
        )}
      </nav>
    </aside>
  );
}
function relativeTime(ms: number) {
  const day = Math.floor((Date.now() - ms) / 86400000);
  return day < 1
    ? '今天'
    : day === 1
      ? '昨天'
      : new Date(ms).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
