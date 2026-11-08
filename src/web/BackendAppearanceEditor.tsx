import { useEffect, useRef, useState } from 'react';
import {
  backendIconNames,
  type BackendAppearance,
  type BackendAppearanceDocument,
  type BackendAppearancePatch,
} from '../shared/backends';
import { deviceSession } from './device-session';
import { Dialog } from './shell/Dialog';
const errorText = (error: unknown) => (error instanceof Error ? error.message : '设置未保存，请重试');
import { BackendIcon } from './BackendIcon';
import { Icon } from './Icon';

const labels = {
  code: '代码',
  terminal: '终端',
  puzzle: '助手',
  chat: '聊天',
  monitor: '电脑',
  book: '阅读',
  folder: '项目',
  sun: '阳光',
};
async function readIcon(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 5 * 1024 ** 2) throw Error('图片不能超过 5 MB');
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    const size = Math.min(image.width, image.height);
    canvas
      .getContext('2d')!
      .drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 192, 192);
    const value = canvas.toDataURL('image/webp', 0.82);
    if (value.length > 90000) throw Error('图片过于复杂，请选择尺寸更小的图片');
    return value;
  } finally {
    image.close();
  }
}

export default function BackendAppearanceEditor({
  id,
  product,
  onClose,
  onSaved,
}: {
  id: string;
  product?: string;
  onClose: () => void;
  onSaved: (value: BackendAppearanceDocument) => void;
}) {
  const [document, setDocument] = useState<BackendAppearanceDocument>();
  const [draft, setDraft] = useState<BackendAppearance>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'builtin' | 'emoji' | 'image'>('builtin');
  const reset = useRef(false),
    fileRef = useRef<HTMLInputElement>(null),
    active = useRef(true);
  const path = `/backends/${encodeURIComponent(id)}/appearance`;
  useEffect(() => {
    active.current = true;
    void deviceSession
      .api<BackendAppearanceDocument>(path, undefined, 'codex-local')
      .then((value) => {
        if (!active.current) return;
        setDocument(value);
        setDraft(value.values);
        setTab(value.values.icon.kind);
      })
      .catch((e) => {
        if (active.current) setError(errorText(e));
      })
      .finally(() => {
        if (active.current) setLoading(false);
      });
    return () => {
      active.current = false;
    };
  }, [path]);
  async function save() {
    if (!document || !draft || busy) return;
    setBusy(true);
    setError('');
    const patch: BackendAppearancePatch = {};
    for (const key of ['name', 'description', 'icon'] as const) {
      // Unchanged fields keep inheriting plugin defaults. Reset removes all overrides.
      if (reset.current)
        Object.assign(patch, {
          [key]: JSON.stringify(draft[key]) === JSON.stringify(document.defaults[key]) ? null : draft[key],
        });
      else if (JSON.stringify(draft[key]) !== JSON.stringify(document.values[key]))
        Object.assign(patch, { [key]: draft[key] });
    }
    if (!Object.keys(patch).length) {
      setBusy(false);
      onClose();
      return;
    }
    try {
      const result = await deviceSession.api<BackendAppearanceDocument>(
        path,
        {
          method: 'POST',
          body: JSON.stringify({ revision: document.revision, patch }),
        },
        'codex-local',
      );
      if (active.current) {
        onSaved(result);
        onClose();
      }
    } catch (e) {
      if (active.current) setError(errorText(e));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title="编辑实例"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="backend-editor-error" role={error ? 'alert' : undefined}>
        {error}
      </p>
      {loading ? (
        <p role="status">正在读取设置…</p>
      ) : draft && document ? (
        <form
          className="backend-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="backend-preview">
            <BackendIcon icon={draft.icon} product={product} />
            <span>
              <strong>{draft.name || '实例名称'}</strong>
              <small>{draft.description || '添加一句说明'}</small>
            </span>
          </div>
          <fieldset disabled={busy}>
            <label>
              名称
              <input
                value={draft.name}
                required
                maxLength={80}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              说明
              <input
                value={draft.description}
                maxLength={160}
                placeholder="例如：桌面编程助手"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <div className="backend-icon-tabs" role="group" aria-label="图标类型">
              {(['builtin', 'emoji', 'image'] as const).map((kind) => (
                <button key={kind} type="button" aria-pressed={tab === kind} onClick={() => setTab(kind)}>
                  {kind === 'builtin' ? '图标' : kind === 'emoji' ? 'Emoji' : '图片'}
                </button>
              ))}
            </div>
            {tab === 'builtin' && (
              <div className="backend-icon-grid" role="group" aria-label="选择图标">
                {backendIconNames.map((name) => (
                  <button
                    type="button"
                    key={name}
                    aria-label={labels[name]}
                    title={labels[name]}
                    aria-pressed={draft.icon.kind === 'builtin' && draft.icon.value === name}
                    onClick={() => setDraft({ ...draft, icon: { kind: 'builtin', value: name } })}
                  >
                    <Icon name={name} />
                  </button>
                ))}
              </div>
            )}
            {tab === 'emoji' && (
              <label>
                Emoji
                <input
                  value={draft.icon.kind === 'emoji' ? draft.icon.value : ''}
                  placeholder="输入一个 Emoji，例如 🦄"
                  maxLength={32}
                  onChange={(e) => setDraft({ ...draft, icon: { kind: 'emoji', value: e.target.value } })}
                />
              </label>
            )}
            {tab === 'image' && (
              <div className="backend-image-picker">
                <button className="secondary" type="button" onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={18} />
                  选择图片
                </button>
                <small>PNG、JPEG 或 WebP，最大 5 MB。自动裁成方形并压缩。</small>
                <input
                  ref={fileRef}
                  type="file"
                  aria-label="实例图标图片"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    setBusy(true);
                    setError('');
                    void readIcon(file)
                      .then((value) => {
                        if (active.current)
                          setDraft((current) =>
                            current ? { ...current, icon: { kind: 'image', value } } : current,
                          );
                      })
                      .catch((e) => {
                        if (active.current) setError(errorText(e));
                      })
                      .finally(() => {
                        if (active.current) setBusy(false);
                      });
                  }}
                />
              </div>
            )}
          </fieldset>
          <p className="hint">保存到此主机，已配对设备共用。</p>
          <div className="im-dialog-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                reset.current = true;
                setDraft(document.defaults);
                setTab(document.defaults.icon.kind);
                setError('');
              }}
            >
              恢复默认
            </button>
            <button className="primary" type="submit" disabled={busy || !draft.name.trim()}>
              {busy ? '处理中…' : '保存'}
            </button>
          </div>
        </form>
      ) : (
        <button className="secondary" onClick={onClose}>
          返回
        </button>
      )}
    </Dialog>
  );
}
