import { tsxComponent } from '../tsx-component';
import { shallowRef, useId } from 'vue';
import { writeRef, watchRender } from '../render-effects';

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
export const Expressions = tsxComponent(function Expressions(initialProps: {
  userId: string;
  conversationId: string;
  onEmoji: (value: string) => void;
  onSticker: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { userId } = initialProps;

  const tabState = shallowRef<'recent' | 'emoji' | 'stickers'>('emoji');
  const setTab = writeRef(tabState);
  const queryState = shallowRef('');
  const setQuery = writeRef(queryState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const stickersState = shallowRef<ChatSticker[]>([]);
  const setStickers = writeRef(stickersState);
  const loadingState = shallowRef(true);
  const setLoading = writeRef(loadingState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const panel = shallowRef<HTMLElement | null>(null);
  const bodyId = useId();
  const managingState = shallowRef(false);
  const setManaging = writeRef(managingState);
  const recentState = shallowRef<string[]>(
    (() => {
      try {
        const values: unknown = JSON.parse(localStorage.getItem(`pocket-im-emoji:${userId}`) ?? '[]');
        return Array.isArray(values) ? values.filter((v) => emoji.some(([e]) => e === v)).slice(0, 12) : [];
      } catch {
        return [];
      }
    })(),
  );
  const setRecent = writeRef(recentState);
  const watchPointerdown = watchRender();
  const watchStickers = watchRender();
  return ({ userId, conversationId, onEmoji, onSticker, onClose }) => {
    const tab = tabState.value;
    const query = queryState.value;
    const error = errorState.value;
    const stickers = stickersState.value;
    const loading = loadingState.value;
    const busy = busyState.value;

    const managing = managingState.value;
    watchPointerdown(() => {
      const outside = (event: PointerEvent) => {
        if (
          !(event.target instanceof Element) ||
          panel.value?.contains(event.target) ||
          event.target.closest('[data-expression-trigger]')
        )
          return;
        if (!busy) onClose();
      };
      const escape = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && !busy) {
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
    const recent = recentState.value;
    watchStickers(() => {
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
    const filtered = emoji.filter(([value, label]) => !query || (value + label).includes(query.trim()));
    const tabs = [
      { id: 'recent', label: '最近', icon: 'clock' },
      { id: 'emoji', label: '表情', icon: 'smile' },
      { id: 'stickers', label: '收藏', icon: 'sticker' },
    ] as const;
    return (
      <section ref={panel} class="im-expression-panel im-input-tray" role="region" aria-label="表情与 Emoji">
        <header class="im-tray-header">
          <strong>{tab === 'stickers' ? '收藏的表情' : tab === 'recent' ? '最近使用' : '表情'}</strong>
          <div>
            {tab === 'stickers' && !!stickers.length && (
              <button class="im-tray-text-action" disabled={busy} onClick={() => setManaging(!managing)}>
                {managing ? '完成' : '管理'}
              </button>
            )}
            <button class="icon-button" aria-label="关闭表情" disabled={busy} onClick={onClose}>
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>
        {tab !== 'recent' && (
          <div class="im-expression-search-wrap">
            <Icon name="search" size={16} />
            <input
              class="im-expression-search"
              aria-label={tab === 'emoji' ? '搜索 Emoji' : '搜索收藏表情'}
              value={query}
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
              placeholder={tab === 'emoji' ? '搜索表情，如：开心、加油' : '搜索收藏的表情'}
            />
          </div>
        )}
        <Notice text={error} />
        <div
          id={bodyId}
          key={`${tab}:${query}`}
          class="im-expression-body"
          role="tabpanel"
          aria-label={tabs.find((t) => t.id === tab)!.label}
        >
          {tab !== 'stickers' ? (
            <>
              <div class="im-emoji-grid">
                {(tab === 'recent' ? recent.map((value) => emoji.find(([e]) => e === value)!) : filtered).map(
                  ([value, label]) => (
                    <button
                      key={value}
                      aria-label={`${label} ${value}`}
                      title={label}
                      onClick={() => choose(value)}
                    >
                      {value}
                    </button>
                  ),
                )}
              </div>
              {((tab === 'recent' && !recent.length) || (tab === 'emoji' && !filtered.length)) && (
                <div class="im-expression-empty">
                  <Icon name={tab === 'recent' ? 'clock' : 'search'} size={30} />
                  <p>{tab === 'recent' ? '常用的表情，会留在这里' : '没有找到这个表情'}</p>
                  <small>
                    {tab === 'recent' ? '去「表情」里选一个吧' : '试试「开心」「谢谢」或「加油」'}
                  </small>
                </div>
              )}
            </>
          ) : loading ? (
            <p class="im-tray-status" role="status">
              正在加载表情…
            </p>
          ) : !stickers.length ? (
            <div class="im-expression-empty">
              <Icon name="sticker" size={34} />
              <p>收藏一点小心情</p>
              <small>点击下方 + 添加图片或 GIF，也可以收藏聊天中的图片。</small>
            </div>
          ) : (
            <>
              <div class={`im-sticker-grid ${managing ? 'is-managing' : ''}`}>
                {stickers
                  .filter(
                    (s) => !query || s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
                  )
                  .map((sticker) => (
                    <div key={sticker.id}>
                      <button
                        disabled={busy || managing}
                        class="im-sticker-send"
                        aria-label={`发送表情 ${sticker.name}`}
                        title={sticker.name}
                        onClick={async () => {
                          setBusy(true);
                          setError('');
                          try {
                            await onSticker(sticker.id);
                          } catch (e) {
                            setError(errorText(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <CachedImage src={sticker.url} alt={sticker.name} />
                      </button>
                      {managing && (
                        <button
                          class="im-sticker-remove"
                          aria-label={`移除表情 ${sticker.name}`}
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setError('');
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
                          <Icon name="close" size={14} />
                        </button>
                      )}
                    </div>
                  ))}
              </div>
              {query &&
                !stickers.some((s) =>
                  s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
                ) && <p class="im-tray-status">没有找到匹配的收藏表情</p>}
            </>
          )}
        </div>
        <footer class="im-expression-footer">
          <div
            role="tablist"
            aria-label="表情分类"
            onKeydown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = tabs.findIndex((t) => t.id === tab);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 2
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next].id);
              setQuery('');
              setManaging(false);
              (event.currentTarget as HTMLDivElement)
                .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [next]?.focus();
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                aria-controls={bodyId}
                tabindex={tab === t.id ? 0 : -1}
                onClick={() => {
                  setTab(t.id);
                  setQuery('');
                  setManaging(false);
                }}
              >
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          <label class="im-expression-add" title="添加收藏表情">
            <Icon name="plus" size={22} />
            <input
              aria-label="导入表情包"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              disabled={busy || loading}
              onChange={(e) => {
                setTab('stickers');
                setQuery('');
                void importSticker((e.currentTarget as HTMLInputElement).files?.[0]);
                (e.currentTarget as HTMLInputElement).value = '';
              }}
            />
          </label>
        </footer>
      </section>
    );
  };
});
