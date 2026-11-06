import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../Icon';
import {
  exportThemes,
  importThemes,
  MAX_CUSTOM_THEMES,
  presets,
  themeTokens,
  type Appearance,
  type ColorMode,
  type Theme,
} from './palette';
import { updateAppearance, useAppearance } from './store';

function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <div className="theme-preview" style={themeTokens(theme) as CSSProperties} aria-hidden="true">
      <div className="theme-preview-rail">
        <i />
        <i />
        <i />
      </div>
      <div className="theme-preview-chat">
        <span className="theme-preview-bubble" />
        <span className="theme-preview-line" />
        <span className="theme-preview-line short" />
        <span className="theme-preview-input">
          <i />
        </span>
      </div>
    </div>
  );
}
function ThemeEditor({
  theme,
  onSave,
  onClose,
}: {
  theme: Theme;
  onSave: (theme: Theme) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(theme);
  const [seedText, setSeedText] = useState(theme.seed);
  const validColor = /^#[0-9a-f]{6}$/i.test(seedText);
  const [error, setError] = useState('');
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const el = dialog.current!;
    el.showModal();
    return () => {
      el.close();
      prior?.focus({ preventScroll: true });
    };
  }, []);
  const changeColor = (value: string) => {
    setSeedText(value);
    if (/^#[0-9a-f]{6}$/i.test(value)) setDraft((old) => ({ ...old, seed: value }));
  };
  return (
    <dialog
      ref={dialog}
      className="theme-editor"
      aria-labelledby="theme-editor-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!validColor || !draft.name.trim()) return;
          try {
            onSave({ ...draft, name: draft.name.trim() });
          } catch {
            setError('无法保存，请检查浏览器存储空间或权限');
          }
        }}
      >
        <header>
          <h2 id="theme-editor-title">{theme.name ? '编辑主题' : '添加主题'}</h2>
          <button type="button" className="icon-button" aria-label="关闭主题编辑" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <label>
          主题名称
          <input
            autoFocus
            required
            maxLength={32}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="例如：暮色"
          />
        </label>
        <fieldset className="theme-mode-picker">
          <legend>适用模式</legend>
          <div className="appearance-segmented">
            {(['light', 'dark'] as const).map((mode) => (
              <label key={mode}>
                <input
                  type="radio"
                  name="editor-mode"
                  value={mode}
                  checked={draft.mode === mode}
                  onChange={() => setDraft({ ...draft, mode })}
                />
                <span>{mode === 'light' ? '浅色' : '深色'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="theme-color-field">
          <label htmlFor="theme-seed">主色</label>
          <div>
            <input
              aria-label="选择主色"
              type="color"
              value={draft.seed}
              onChange={(e) => changeColor(e.target.value)}
            />
            <input
              id="theme-seed"
              type="text"
              value={seedText}
              maxLength={7}
              pattern="#[0-9a-fA-F]{6}"
              required
              spellCheck={false}
              aria-invalid={!validColor}
              onChange={(e) => changeColor(e.target.value)}
            />
          </div>
          <p className="hint">选一个主色，自动搭配背景、文字与按钮颜色。</p>
        </div>
        <div className="theme-live-sample" style={themeTokens(draft) as CSSProperties}>
          <strong>让工作更专注</strong>
          <p>这是一段消息的预览文字。</p>
          <span>已选择的内容</span>
          <button type="button">发送</button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!validColor || !draft.name.trim()}>
            保存主题
          </button>
        </footer>
      </form>
    </dialog>
  );
}
export default function AppearanceSettings() {
  const { settings, resolved } = useAppearance();
  const [editor, setEditor] = useState<Theme>();
  const [deleting, setDeleting] = useState<string>();
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const themes = [...presets, ...settings.customThemes];
  function save(next: Appearance) {
    try {
      updateAppearance(next);
      setNotice('');
      return true;
    } catch {
      setNotice('无法保存，请检查浏览器存储空间或权限');
      return false;
    }
  }
  function add(mode: ColorMode) {
    if (settings.customThemes.length >= MAX_CUSTOM_THEMES) {
      setNotice(`最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`);
      return;
    }
    setEditor({ id: `custom-${crypto.randomUUID()}`, name: '', mode, seed: '#197b66' });
  }
  function download(theme: Theme) {
    const url = URL.createObjectURL(new Blob([exportThemes([theme])], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${theme.name.replace(/[\\/:*?"<>|]/g, '_')}.theme.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="appearance-settings">
      <section className="appearance-intro">
        <h2>让界面合你心意</h2>
        <p>浅色与深色，各有自己的配色。</p>
      </section>
      <fieldset className="theme-mode-picker">
        <legend>显示模式</legend>
        <div className="appearance-segmented">
          {(
            [
              ['system', '跟随系统', 'monitor'],
              ['light', '浅色', 'sun'],
              ['dark', '深色', 'moon'],
            ] as const
          ).map(([mode, label, icon]) => (
            <label key={mode}>
              <input
                type="radio"
                name="appearance-mode"
                value={mode}
                checked={settings.mode === mode}
                onChange={() => save({ ...settings, mode })}
              />
              <span>
                <Icon name={icon} size={18} />
                {label}
              </span>
            </label>
          ))}
        </div>
        <p className="hint">
          {settings.mode === 'system'
            ? `随设备自动切换，当前为${resolved === 'light' ? '浅色' : '深色'}。`
            : `始终使用${resolved === 'light' ? '浅色' : '深色'}模式。`}
        </p>
      </fieldset>
      {(['light', 'dark'] as const).map((mode) => (
        <section key={mode} className="theme-section" aria-labelledby={`${mode}-themes`}>
          <header>
            <div>
              <h2 id={`${mode}-themes`}>{mode === 'light' ? '浅色主题' : '深色主题'}</h2>
              <p className="hint">{resolved === mode ? '当前模式' : '切换到此模式时使用'}</p>
            </div>
            <button
              className="theme-add"
              onClick={() => add(mode)}
              aria-label={`添加${mode === 'light' ? '浅色' : '深色'}主题`}
            >
              <Icon name="plus" size={18} />
              添加主题
            </button>
          </header>
          <div className="theme-grid">
            {themes
              .filter((t) => t.mode === mode)
              .map((theme) => (
                <article className="theme-card" key={theme.id}>
                  <button
                    className="theme-select"
                    aria-label={`选择${theme.name}`}
                    aria-pressed={settings[mode] === theme.id}
                    onClick={() => save({ ...settings, [mode]: theme.id })}
                  >
                    <ThemePreview theme={theme} />
                    <span className="theme-card-label">
                      <strong>{theme.name}</strong>
                      {settings[mode] === theme.id ? (
                        <span>
                          <Icon name="check" size={16} />
                          已选择
                        </span>
                      ) : (
                        <small>{theme.id.startsWith('custom-') ? '自定义' : '预设'}</small>
                      )}
                    </span>
                  </button>
                  <div className="theme-card-tools">
                    <button onClick={() => download(theme)} title="导出主题" aria-label={`导出${theme.name}`}>
                      <Icon name="download" size={16} />
                    </button>
                    {settings.customThemes.some((t) => t.id === theme.id) && (
                      <>
                        <button
                          onClick={() => setEditor(theme)}
                          title="编辑主题"
                          aria-label={`编辑${theme.name}`}
                        >
                          <Icon name="sliders" size={16} />
                        </button>
                        <button
                          onClick={() => setDeleting(theme.id)}
                          title="删除主题"
                          aria-label={`删除${theme.name}`}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      </>
                    )}
                  </div>
                  {deleting === theme.id && (
                    <div className="theme-delete-confirm">
                      <p>删除“{theme.name}”？</p>
                      <button className="secondary" onClick={() => setDeleting(undefined)}>
                        取消
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          if (
                            save({
                              ...settings,
                              customThemes: settings.customThemes.filter((t) => t.id !== theme.id),
                            })
                          )
                            setDeleting(undefined);
                        }}
                      >
                        确认删除
                      </button>
                    </div>
                  )}
                </article>
              ))}
          </div>
        </section>
      ))}
      <div className="theme-import">
        <button className="secondary" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" size={18} />
          导入主题
        </button>
        <p className="hint">主题保存在此浏览器。导出后可在其他设备导入。</p>
        <input
          hidden
          type="file"
          ref={fileInput}
          accept=".json,application/json"
          aria-label="导入主题文件"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              if (file.size > 32768) throw Error('主题文件过大（最多 32 KB）');
              const imported = importThemes(await file.text());
              if (settings.customThemes.length + imported.length > MAX_CUSTOM_THEMES)
                throw Error(`最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`);
              if (
                save({
                  ...settings,
                  customThemes: [
                    ...settings.customThemes,
                    ...imported.map((t) => ({ ...t, id: `custom-${crypto.randomUUID()}` })),
                  ],
                })
              )
                setNotice(`已导入 ${imported.length} 个主题，可在对应模式中选择`);
            } catch (error) {
              setNotice(error instanceof Error ? error.message : '主题导入失败');
            }
          }}
        />
      </div>
      {notice && (
        <p className="appearance-notice" role="status">
          {notice}
        </p>
      )}
      {editor && (
        <ThemeEditor
          theme={editor}
          onClose={() => setEditor(undefined)}
          onSave={(theme) => {
            const customThemes = settings.customThemes.filter((t) => t.id !== theme.id);
            updateAppearance({ ...settings, customThemes: [...customThemes, theme], [theme.mode]: theme.id });
            setEditor(undefined);
            setNotice('主题已保存');
          }}
        />
      )}
    </div>
  );
}
