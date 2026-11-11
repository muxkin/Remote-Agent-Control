import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from './render-effects';
import { remoteFetch } from './device-session';
import type { ThreadView, Operation } from '../shared/types';
import type { ModelChoice } from '../shared/backends';
import { Icon } from './Icon';
export type ModelUpdate = {
  model: string;
  effort: string;
  mode: 'default' | 'plan';
  serviceTier: string;
  expectedModel: string | null;
  expectedEffort: string | null;
  expectedServiceTier: string | null;
  expectedMode: 'default' | 'plan';
};
const effortNames: Record<string, string> = {
  default: '原生默认',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
  ultra: '极高',
};
export function modelLabel(name: string | null) {
  if (name?.startsWith('[')) {
    try {
      const pair = JSON.parse(name);
      if (Array.isArray(pair) && pair.length === 2) return pair.join(' / ');
    } catch {
      /* Native label below. */
    }
  }
  return (
    name
      ?.replace(/^gpt-(\d+(?:\.\d+)?)-?/i, 'GPT-$1 ')
      .replace(/\b(astra|sol|terra|luna|codex)\b/gi, (s) => s[0].toUpperCase() + s.slice(1))
      .trim() || '选择模型'
  );
}
export function settingsUpdate(view: ThreadView, mode: 'default' | 'plan'): ModelUpdate {
  return {
    model: view.model ?? '',
    effort: view.reasoningEffort ?? '',
    serviceTier: view.serviceTier ?? 'default',
    mode,
    expectedModel: view.model,
    expectedEffort: view.reasoningEffort ?? null,
    expectedServiceTier: view.serviceTier ?? null,
    expectedMode: view.mode === 'plan' ? 'plan' : 'default',
  };
}
export const ModelSettings = tsxComponent(function ModelSettings(initialProps: {
  view: ThreadView;
  disabled: boolean;
  onSave: (settings: ModelUpdate) => Promise<string | undefined>;
  onDirtyChange?: (dirty: boolean) => void;
  response?: Operation;
  onApplied: () => void;
  creation?: boolean;
}) {
  const { view } = initialProps;

  const modelsState = shallowRef<ModelChoice[]>([]);
  const setModels = writeRef(modelsState);
  const initialState = shallowRef((() => settingsUpdate(view, view.mode === 'plan' ? 'plan' : 'default'))());
  const modelState = shallowRef(initialState.value.model);
  const setModel = writeRef(modelState);
  const effortState = shallowRef(initialState.value.effort);
  const setEffort = writeRef(effortState);
  const tierState = shallowRef(initialState.value.serviceTier);
  const setTier = writeRef(tierState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const pickingState = shallowRef(false);
  const setPicking = writeRef(pickingState);
  const queryState = shallowRef('');
  const setQuery = writeRef(queryState);
  const submittedState = shallowRef<string>();
  const setSubmitted = writeRef(submittedState);
  const watchModels = watchRender();
  const watchModel = watchRender();
  const watchSubmitted = watchRender();
  return ({ view, disabled, onSave, onDirtyChange, response, onApplied, creation = false }) => {
    const models = modelsState.value;
    const initial = initialState.value;
    const model = modelState.value;
    const effort = effortState.value;
    const tier = tierState.value;
    const error = errorState.value;
    const loading = loadingState.value;
    const picking = pickingState.value;
    const query = queryState.value;
    const submitted = submittedState.value;
    watchModels(() => {
      const controller = new AbortController();
      remoteFetch('/api/models', { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw Error('暂时无法读取原实例模型目录');
          setModels((await r.json()).models);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
      return () => controller.abort();
    }, []);
    watchModel(() => {
      onDirtyChange?.(model !== initial.model || effort !== initial.effort || tier !== initial.serviceTier);
      return () => onDirtyChange?.(false);
    }, [model, effort, tier, initial, onDirtyChange]);
    watchSubmitted(() => {
      if (submitted && response?.id === submitted && response.state === 'completed') onApplied();
    }, [submitted, response, onApplied]);
    const ownResponse = response?.id === submitted ? response : undefined;
    const choice = models.find((m) => m.id === model);
    const stale =
      view.model !== initial.expectedModel ||
      (view.reasoningEffort ?? null) !== initial.expectedEffort ||
      (view.serviceTier ?? null) !== initial.expectedServiceTier ||
      (view.mode === 'plan' ? 'plan' : 'default') !== initial.expectedMode;
    return (
      <section class="model-settings">
        <div class="settings-scroll">
          {picking ? (
            <div class="model-catalog">
              <button class="catalog-back" onClick={() => setPicking(false)}>
                <Icon name="back" size={18} />
                返回模型设置
              </button>
              <label class="search-field">
                <Icon name="search" size={20} />
                <input
                  autofocus
                  onVnodeMounted={(vnode) => (vnode.el as HTMLElement).focus()}
                  type="search"
                  placeholder="搜索模型"
                  aria-label="搜索模型"
                  value={query}
                  onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <div role="radiogroup" aria-label="模型">
                {models
                  .filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(query.toLowerCase()))
                  .map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={m.id === model}
                      disabled={disabled}
                      onClick={() => {
                        setModel(m.id);
                        if (!m.efforts.includes(effort)) setEffort(m.defaultEffort ?? '');
                        if (!m.speeds.some((s) => s.id === tier)) setTier('default');
                        setPicking(false);
                      }}
                    >
                      <span>
                        {modelLabel(m.name)}
                        <small>{m.id}</small>
                      </span>
                      {m.id === model && <Icon name="check" size={20} />}
                    </button>
                  ))}
              </div>
            </div>
          ) : (
            <>
              <div class="setting-section">
                <h3>模型</h3>
                <button
                  class="model-choice"
                  aria-label="选择模型"
                  disabled={disabled || loading}
                  onClick={() => setPicking(true)}
                >
                  <Icon name="sliders" size={24} />
                  <span>
                    <strong>{modelLabel(choice?.name ?? model)}</strong>
                    <small>{model === initial.model ? '当前模型' : '下轮使用'}</small>
                  </span>
                  <Icon name="down" size={20} />
                </button>
              </div>
              <div class="setting-section">
                <h3>推理强度</h3>
                <p class="setting-caption">控制思考深度</p>
                <div class="effort-options" role="radiogroup" aria-label="推理强度">
                  {choice?.efforts.map((value) => (
                    <button
                      type="button"
                      role="radio"
                      key={value}
                      aria-checked={effort === value}
                      disabled={disabled || loading}
                      onClick={() => setEffort(value)}
                    >
                      {effortNames[value] ?? value}
                    </button>
                  ))}
                </div>
              </div>
              {!creation && (
                <div class="setting-section">
                  <h3>速度</h3>
                  <div class="speed-options" role="radiogroup" aria-label="速度">
                    {choice?.speeds.map((speed) => (
                      <label key={speed.id}>
                        <input
                          type="radio"
                          name="model-speed"
                          aria-label={
                            speed.id === 'default'
                              ? '标准'
                              : speed.name === 'Fast'
                                ? '快速 · Fast'
                                : speed.name
                          }
                          checked={tier === speed.id}
                          disabled={disabled || loading}
                          onChange={() => setTier(speed.id)}
                        />
                        <span>
                          <strong>
                            {speed.id === 'default'
                              ? '标准'
                              : speed.name === 'Fast'
                                ? '快速 · Fast'
                                : speed.name}
                          </strong>
                          <small>
                            {speed.id === 'default'
                              ? '使用标准速度'
                              : speed.id === 'priority'
                                ? '更快响应，可能增加用量'
                                : speed.description}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          {loading && (
            <p role="status" class="hint">
              正在读取原实例模型…
            </p>
          )}
          {error && (
            <p role="alert" class="error">
              {error}
            </p>
          )}
          {stale && !submitted && (
            <p role="status" class="hint">
              原实例设置已更新，请关闭并重新打开面板。
            </p>
          )}
        </div>
        <footer class="sheet-footer">
          {view.activeTurnId && (
            <p class="settings-scope">
              <Icon name="clock" size={18} />
              当前任务继续使用原设置
            </p>
          )}
          {ownResponse && ownResponse.state !== 'completed' && (
            <p class="tools-feedback" role="status">
              {ownResponse.error || '正在与电脑同步设置…'}
            </p>
          )}
          <button
            class="primary"
            disabled={disabled || loading || stale || !choice || !choice.efforts.includes(effort)}
            onClick={async () => setSubmitted(await onSave({ ...initial, model, effort, serviceTier: tier }))}
          >
            {creation ? '用于新会话' : '应用到下一轮'}
          </button>
          <small>{creation ? '发送第一条消息时使用，不影响原会话' : '确认后与电脑同步'}</small>
        </footer>
      </section>
    );
  };
});
