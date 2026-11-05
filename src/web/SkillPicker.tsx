import { useEffect, useState } from 'react';
import type { SkillChoice, PluginChoice } from '../shared/types';
import { Icon } from './Icon';
type Choice = SkillChoice | PluginChoice;
export function SkillPicker({
  threadId,
  selected,
  onApply,
  disabled,
  kind = 'skills',
  onDirtyChange,
}: {
  threadId: string;
  selected: Choice[];
  onApply: (value: Choice[]) => void;
  disabled: boolean;
  kind?: 'skills' | 'plugins';
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [items, setItems] = useState<Choice[]>([]),
    [chosen, setChosen] = useState(selected);
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [detail, setDetail] = useState<string>();
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const label = kind === 'skills' ? '技能' : '插件';
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/threads/${threadId}/${kind}`, { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw Error(data.error ?? `读取${label}失败`);
        setItems(data[kind]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [threadId, kind, label]);
  useEffect(() => {
    onDirtyChange?.(
      chosen.length !== selected.length || chosen.some((c) => !selected.some((s) => s.id === c.id)),
    );
    return () => onDirtyChange?.(false);
  }, [chosen, selected, onDirtyChange]);
  const name = (s: Choice) => ('displayName' in s && s.displayName) || s.name;
  const filtered = items.filter(
    (s) =>
      `${name(s)} ${s.name} ${s.description} ${'source' in s ? s.source : ''}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'all' ||
        ('sourceKind' in s &&
          (s.sourceKind === filter || (filter === 'personal' && s.sourceKind === 'system')))),
  );
  const toggle = (s: Choice) =>
    setChosen((old) =>
      old.some((v) => v.id === s.id) ? old.filter((v) => v.id !== s.id) : old.length < 10 ? [...old, s] : old,
    );
  return (
    <section className="skill-picker">
      <div className="picker-head">
        <label className="search-field">
          <Icon name="search" size={20} />
          <input
            type="search"
            aria-label={`搜索${label}`}
            placeholder={`搜索${label}或用途`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {kind === 'skills' && (
          <div className="source-tabs" role="tablist" aria-label="技能来源">
            {[
              ['all', '全部'],
              ['project', '项目'],
              ['personal', '个人'],
              ['plugin', '插件'],
            ].map(([id, title]) => (
              <button role="tab" aria-selected={filter === id} key={id} onClick={() => setFilter(id)}>
                {title}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="picker-scroll">
        <p className="picker-section-label" role="status">
          {loading
            ? `正在读取${label}…`
            : query
              ? `找到 ${filtered.length} 个${label}`
              : kind === 'plugins'
                ? '已安装的插件'
                : '可用技能'}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !filtered.length && <p className="hint">没有匹配的{label}</p>}
        <div className="skill-options">
          {filtered.map((item) => {
            const checked = chosen.some((s) => s.id === item.id);
            return (
              <div key={item.id} className={`picker-option ${checked ? 'selected' : ''}`}>
                <label>
                  <span className="picker-icon">
                    <Icon name={kind === 'plugins' ? 'puzzle' : 'book'} size={23} />
                  </span>
                  <span className="picker-copy">
                    <strong>{name(item)}</strong>
                    <small className="picker-description">{item.description}</small>
                    <small>
                      {'source' in item
                        ? `${item.sourceKind === 'plugin' ? '插件 · ' : ''}${item.source}`
                        : '电脑已安装'}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={name(item)}
                    checked={checked}
                    disabled={disabled || (!checked && chosen.length >= 10)}
                    onChange={() => toggle(item)}
                  />
                </label>
                <button
                  className="picker-info icon-button"
                  aria-label={`查看 ${name(item)} 详情`}
                  aria-expanded={detail === item.id}
                  onClick={() => setDetail(detail === item.id ? undefined : item.id)}
                >
                  <Icon name="info" size={18} />
                </button>
                {detail === item.id && (
                  <div className="picker-detail">
                    <strong>{item.name}</strong>
                    <p>{item.description}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <footer className="sheet-footer">
        <div className="picker-selected">
          <strong>已选 {chosen.length} 个</strong>
          <div>
            {chosen.map((s) => (
              <span className="skill-chip" key={s.id}>
                {name(s)}
                <button aria-label={`移除 ${name(s)}`} onClick={() => toggle(s)}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
          </div>
        </div>
        <button className="primary" disabled={disabled || loading} onClick={() => onApply(chosen)}>
          添加到消息
        </button>
        <small>只用于这条消息</small>
      </footer>
    </section>
  );
}
