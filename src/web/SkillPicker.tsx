import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { writeRef, watchRender } from './render-effects';
import { remoteFetch } from './device-session';
import type { SkillChoice, PluginChoice } from '../shared/types';
import { Icon } from './Icon';
type Choice = SkillChoice | PluginChoice;
export const SkillPicker = tsxComponent(function SkillPicker(initialProps: {
  threadId: string;
  selected: Choice[];
  onApply: (value: Choice[]) => void;
  disabled: boolean;
  kind?: 'skills' | 'plugins';
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { selected } = initialProps;

  const itemsState = shallowRef<Choice[]>([]);
  const setItems = writeRef(itemsState);
  const chosenState = shallowRef(selected);
  const setChosen = writeRef(chosenState);
  const queryState = shallowRef('');
  const setQuery = writeRef(queryState);
  const filterState = shallowRef('all');
  const setFilter = writeRef(filterState);
  const detailState = shallowRef<string>();
  const setDetail = writeRef(detailState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const watchItems = watchRender();
  const watchChosen = watchRender();
  return ({ threadId, selected, onApply, disabled, kind = 'skills', onDirtyChange }) => {
    const items = itemsState.value;
    const chosen = chosenState.value;
    const query = queryState.value;
    const filter = filterState.value;
    const detail = detailState.value;
    const loading = loadingState.value;
    const error = errorState.value;
    const label = kind === 'skills' ? '技能' : '插件';
    watchItems(() => {
      const controller = new AbortController();
      remoteFetch(`/api/threads/${encodeURIComponent(threadId)}/${kind}`, { signal: controller.signal })
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
    watchChosen(() => {
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
        old.some((v) => v.id === s.id)
          ? old.filter((v) => v.id !== s.id)
          : old.length < 10
            ? [...old, s]
            : old,
      );
    return (
      <section class="skill-picker">
        <div class="picker-head">
          <label class="search-field">
            <Icon name="search" size={20} />
            <input
              type="search"
              aria-label={`搜索${label}`}
              placeholder={`搜索${label}或用途`}
              value={query}
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          {kind === 'skills' && (
            <div class="source-tabs" role="tablist" aria-label="技能来源">
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
        <div class="picker-scroll">
          <p class="picker-section-label" role="status">
            {loading
              ? `正在读取${label}…`
              : query
                ? `找到 ${filtered.length} 个${label}`
                : kind === 'plugins'
                  ? '已安装的插件'
                  : '可用技能'}
          </p>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          {!loading && !filtered.length && <p class="hint">没有匹配的{label}</p>}
          <div class="skill-options">
            {filtered.map((item) => {
              const checked = chosen.some((s) => s.id === item.id);
              return (
                <div key={item.id} class={`picker-option ${checked ? 'selected' : ''}`}>
                  <label>
                    <span class="picker-icon">
                      <Icon name={kind === 'plugins' ? 'puzzle' : 'book'} size={23} />
                    </span>
                    <span class="picker-copy">
                      <strong>{name(item)}</strong>
                      <small class="picker-description">{item.description}</small>
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
                    class="picker-info icon-button"
                    aria-label={`查看 ${name(item)} 详情`}
                    aria-expanded={detail === item.id}
                    onClick={() => setDetail(detail === item.id ? undefined : item.id)}
                  >
                    <Icon name="info" size={18} />
                  </button>
                  {detail === item.id && (
                    <div class="picker-detail">
                      <strong>{item.name}</strong>
                      <p>{item.description}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <footer class="sheet-footer">
          <div class="picker-selected">
            <strong>已选 {chosen.length} 个</strong>
            <div>
              {chosen.map((s) => (
                <span class="skill-chip" key={s.id}>
                  {name(s)}
                  <button aria-label={`移除 ${name(s)}`} onClick={() => toggle(s)}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <button class="primary" disabled={disabled || loading} onClick={() => onApply(chosen)}>
            添加到消息
          </button>
          <small>只用于这条消息</small>
        </footer>
      </section>
    );
  };
});
