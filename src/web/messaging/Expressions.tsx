import { useEffect, useRef, useState } from 'react';
import type { ChatSticker } from '../../shared/messaging';
import { messaging } from './context';
import { Notice, errorText } from './ui';

import { CachedImage } from './CachedImage';
import { Icon } from '../Icon';
const emoji = [
  ['😀', '开心'],
  ['😄', '大笑'],
  ['😂', '笑哭'],
  ['🤣', '笑倒'],
  ['😊', '微笑'],
  ['🥰', '喜欢'],
  ['😍', '心动'],
  ['😘', '亲亲'],
  ['😎', '酷'],
  ['🤔', '思考'],
  ['🤗', '拥抱'],
  ['🤭', '偷笑'],
  ['🙃', '倒脸'],
  ['😅', '汗颜'],
  ['🥹', '感动'],
  ['🥺', '拜托'],
  ['😴', '睡觉'],
  ['😮', '惊讶'],
  ['😢', '难过'],
  ['😭', '哭泣'],
  ['😤', '生气'],
  ['🤯', '震惊'],
  ['🫡', '收到'],
  ['🤝', '合作'],
  ['👍', '赞'],
  ['👎', '踩'],
  ['👏', '鼓掌'],
  ['🙌', '太棒了'],
  ['🙏', '谢谢'],
  ['👌', '好的'],
  ['✌️', '胜利'],
  ['💪', '加油'],
  ['👋', '你好'],
  ['🫶', '比心'],
  ['❤️', '爱心'],
  ['💛', '黄心'],
  ['💚', '绿心'],
  ['💙', '蓝心'],
  ['💜', '紫心'],
  ['✨', '闪亮'],
  ['🎉', '庆祝'],
  ['🎊', '礼花'],
  ['🎁', '礼物'],
  ['🎂', '生日'],
  ['🌹', '玫瑰'],
  ['🌸', '花'],
  ['🌈', '彩虹'],
  ['☀️', '太阳'],
  ['🌙', '晚安'],
  ['⭐', '星星'],
  ['🔥', '火'],
  ['💯', '满分'],
  ['✅', '完成'],
  ['❌', '错误'],
  ['⚠️', '注意'],
  ['💡', '想法'],
  ['📌', '标记'],
  ['📚', '学习'],
  ['💻', '工作'],
  ['🔬', '研究'],
  ['🚀', '出发'],
  ['☕', '咖啡'],
  ['🍵', '茶'],
  ['🍻', '干杯'],
  ['🐱', '猫'],
  ['🐶', '狗'],
  ['🐼', '熊猫'],
  ['🐣', '小鸡'],
  ['🌱', '成长'],
  ['🍀', '幸运'],
  ['🏆', '奖杯'],
  ['🎵', '音乐'],
];
export function Expressions({
  userId,
  conversationId,
  onEmoji,
  onSticker,
  onClose,
}: {
  userId: string;
  conversationId: string;
  onEmoji: (value: string) => void;
  onSticker: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'emoji' | 'stickers'>('emoji'),
    [query, setQuery] = useState(''),
    [error, setError] = useState('');
  const [stickers, setStickers] = useState<ChatSticker[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        panel.current?.contains(event.target) ||
        event.target.closest('[data-expression-trigger]')
      )
        return;
      if (!busy) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose, busy]);
  const key = `pocket-im-emoji:${userId}`;
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const values: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(values) ? values.filter((v) => emoji.some(([e]) => e === v)).slice(0, 12) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    let active = true;
    void messaging
      .stickers()
      .then((r) => {
        if (active) setStickers(r.stickers);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  function choose(value: string) {
    const next = [value, ...recent.filter((e) => e !== value)].slice(0, 12);
    setRecent(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Emoji still inserts without storage. */
    }
    onEmoji(value);
    onClose();
  }
  async function importSticker(file?: File) {
    if (!file) return;
    if (!file.size || file.size > 2 * 1024 * 1024) {
      setError('请选择不超过 2 MB 的图片或 GIF');
      return;
    }
    setBusy(true);
    setError('');
    let uploaded: string | undefined;
    try {
      const result = await messaging.upload(conversationId, file.name, file);
      uploaded = result.file.id;
      setStickers((await messaging.saveSticker(conversationId, uploaded)).stickers);
    } catch (e) {
      setError(errorText(e));
    } finally {
      if (uploaded)
        void messaging
          .request(`/conversations/${conversationId}/files/${uploaded}`, 'DELETE')
          .catch(() => {});
      setBusy(false);
    }
  }
  return (
    <section ref={panel} className="im-expression-panel" role="region" aria-label="表情与 Emoji">
      <header>
        <strong>表情与 Emoji</strong>
        <button className="icon-button" aria-label="关闭表情" onClick={onClose}>
          <Icon name="close" size={17} />
        </button>
      </header>
      <div className="im-expression-body">
        <div className="im-tabs" aria-label="表情分类">
          <button aria-pressed={tab === 'emoji'} onClick={() => setTab('emoji')}>
            Emoji
          </button>
          <button aria-pressed={tab === 'stickers'} onClick={() => setTab('stickers')}>
            我的表情包
          </button>
        </div>
        <Notice text={error} />
        {tab === 'emoji' ? (
          <>
            <input
              className="im-expression-search"
              aria-label="搜索 Emoji"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索表情，如：开心、谢谢、加油"
            />
            {!query && !!recent.length && (
              <>
                <p className="im-help">最近使用</p>
                <div className="im-emoji-grid">
                  {recent.map((value) => (
                    <button key={value} aria-label={`最近 ${value}`} onClick={() => choose(value)}>
                      {value}
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="im-help">常用表情</p>
            <div className="im-emoji-grid">
              {emoji
                .filter(([value, label]) => !query || (value + label).includes(query))
                .map(([value, label]) => (
                  <button
                    key={value}
                    aria-label={`${label} ${value}`}
                    title={label}
                    onClick={() => choose(value)}
                  >
                    {value}
                  </button>
                ))}
            </div>
            {query && !emoji.some(([value, label]) => (value + label).includes(query)) && (
              <p className="im-help">没有找到这个表情，试试其他关键词。</p>
            )}
          </>
        ) : (
          <>
            <div className="im-sticker-toolbar">
              <p className="im-help">PNG / JPEG / GIF / WebP · 每个 2 MB · {stickers.length}/50</p>
              <label className="secondary im-import-sticker">
                导入表情包
                <input
                  aria-label="导入表情包"
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  disabled={busy}
                  onChange={(e) => {
                    void importSticker(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {loading ? (
              <p role="status">正在加载表情包…</p>
            ) : !stickers.length ? (
              <div className="im-expression-empty">
                <span aria-hidden="true">🫶</span>
                <p>把喜欢的图片收进来</p>
                <small>导入图片，或在聊天图片下点击“收藏表情”。GIF 动图也可以。</small>
              </div>
            ) : (
              <div className="im-sticker-grid">
                {stickers.map((sticker) => (
                  <div key={sticker.id}>
                    <button
                      disabled={busy}
                      className="im-sticker-send"
                      aria-label={`发送表情 ${sticker.name}`}
                      onClick={async () => {
                        setBusy(true);
                        setError('');
                        try {
                          await onSticker(sticker.id);
                          onClose();
                        } catch (e) {
                          setError(errorText(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <CachedImage src={sticker.url} alt={sticker.name} />
                    </button>
                    <button
                      className="im-sticker-remove"
                      aria-label={`移除表情 ${sticker.name}`}
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await messaging.removeSticker(sticker.id);
                          setStickers((old) => old.filter((s) => s.id !== sticker.id));
                        } catch (e) {
                          setError(errorText(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            )}
            {busy && <p role="status">正在处理…</p>}
          </>
        )}
      </div>
    </section>
  );
}
