import { tsxComponent } from './tsx-component';
import { shallowRef } from 'vue';
import { writeRef, watchRender } from './render-effects';
import { useAttachmentAccess } from './AttachmentAccess';
import { remoteFetch } from './device-session';
import { ImagePreview } from './ImagePreview';
import { AttachmentActions } from './AttachmentActions';
import { AttachmentIdentity } from './AttachmentIdentity';
import { attachmentInfo, localReference, attachmentName } from '../shared/attachments';
import { mediaContent, downloadFile } from './file-client';
import { useVisible } from './useVisible';
import { copyImage, imageBlob } from './image-clipboard';

export const Media = tsxComponent(function Media(_props: {
  src: string;
  label: string;
  threadId: string;
  compact?: boolean;
  onRemove?: () => void;
  mediaType?: 'image' | 'video' | 'audio';
}) {
  const attachmentAccess = useAttachmentAccess();
  const { ref, visible: intersectionVisible } = useVisible();
  const urlState = shallowRef('');
  const setUrl = writeRef(urlState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const refreshState = shallowRef(0);
  const setRefresh = writeRef(refreshState);
  const previewState = shallowRef(false);
  const setPreview = writeRef(previewState);
  const originalState = shallowRef('');
  const setOriginal = writeRef(originalState);
  const expiresAt = { current: 0 };
  const refreshing = { current: false };
  const recovery: { current: { time: number; playing: boolean } | null } = { current: null };
  const watchUrl = watchRender();
  return ({ src, label, threadId, compact = false, onRemove, mediaType }) => {
    const access = attachmentAccess.value;
    const visible = intersectionVisible.value;
    // Start external media only after visibility initialization, too. Otherwise a
    // fast failed load can be cleared by the first visibility effect.
    const url = urlState.value;
    const error = errorState.value;
    const refresh = refreshState.value;
    const preview = previewState.value;
    const original = originalState.value;

    function renew(element?: HTMLMediaElement) {
      if (refreshing.current) return;
      refreshing.current = true;
      recovery.current = element ? { time: element.currentTime, playing: !element.paused } : null;
      setError('');
      setRefresh((value) => value + 1);
    }
    function checkExpiry(element: HTMLMediaElement) {
      if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew(element);
    }
    function failed(element?: HTMLMediaElement) {
      if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew(element);
      else setError('附件加载失败，可重新获取访问链接');
    }
    function restore(element: HTMLMediaElement) {
      const previous = recovery.current;
      recovery.current = null;
      if (!previous) return;
      if (Number.isFinite(previous.time)) element.currentTime = previous.time;
      if (previous.playing) void element.play().catch(() => {});
    }
    watchUrl(() => {
      if (!visible) return;
      if (access) {
        const controller = new AbortController();
        void access
          .load(threadId, src, controller.signal)
          .then((file) => {
            if (controller.signal.aborted) return;
            if (!/^(image|audio|video)\//.test(file.mime)) throw Error('此附件不支持媒体预览');
            expiresAt.current = file.expiresAt;
            setUrl(file.url);
            setError('');
          })
          .catch((error) => {
            if (!controller.signal.aborted) setError(error.message);
          })
          .finally(() => {
            refreshing.current = false;
          });
        return () => controller.abort();
      }
      if (!localReference(src)) {
        expiresAt.current = 0;
        setUrl(src);
        setError('');
        refreshing.current = false;
        return;
      }
      const controller = new AbortController();
      void remoteFetch(`/api/threads/${encodeURIComponent(threadId)}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: src }),
        signal: controller.signal,
      })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error ?? '附件不可用');
          expiresAt.current = body.expiresAt;
          setUrl(body.url);
          setError('');
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        })
        .finally(() => {
          refreshing.current = false;
        });
      return () => controller.abort();
    }, [src, threadId, visible, refresh, access]);
    async function download() {
      if (access) {
        const file = await access.load(threadId, src, undefined, true);
        return downloadFile({ ...file, url: file.downloadUrl ?? file.url });
      }
      if (localReference(src)) return downloadFile(await mediaContent(threadId, src));
      const response = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw Error('图片下载失败，请重试');
      const temporary = URL.createObjectURL(await response.blob());
      downloadFile({ url: temporary, name: attachmentName(src) });
      setTimeout(() => URL.revokeObjectURL(temporary), 60000);
    }
    const info = attachmentInfo(src.split(/[?#]/)[0]);
    const media = mediaType ?? info.media;
    const name = label || info.name;
    const copyOriginal = () =>
      copyImage(async () => {
        const file = access
          ? await access.load(threadId, src, undefined, true)
          : localReference(src)
            ? await mediaContent(threadId, src)
            : { url: src };
        return imageBlob(file.url);
      });
    return (
      <AttachmentActions
        path={src}
        name={name}
        onDownload={download}
        onCopyImage={media === 'image' ? copyOriginal : undefined}
        hideMore={media === 'image'}
        surface={compact ? 'compact' : 'media'}
        onRemove={onRemove}
      >
        {() => (
          <>
            <div class="media" ref={ref} data-media-type={media}>
              {url ? (
                media === 'video' ? (
                  <video
                    key={`${url}:${localReference(src) ? '' : refresh}`}
                    controls
                    preload="metadata"
                    src={url}
                    aria-label={label}
                    onPlay={(e) => checkExpiry(e.currentTarget as HTMLVideoElement)}
                    onSeeking={(e) => checkExpiry(e.currentTarget as HTMLVideoElement)}
                    onError={(e) => failed(e.currentTarget as HTMLVideoElement)}
                    onLoadedmetadata={(e) => restore(e.currentTarget as HTMLVideoElement)}
                  />
                ) : media === 'audio' ? (
                  <audio
                    key={`${url}:${localReference(src) ? '' : refresh}`}
                    controls
                    preload="none"
                    src={url}
                    aria-label={label}
                    onPlay={(e) => checkExpiry(e.currentTarget as HTMLAudioElement)}
                    onSeeking={(e) => checkExpiry(e.currentTarget as HTMLAudioElement)}
                    onError={(e) => failed(e.currentTarget as HTMLAudioElement)}
                    onLoadedmetadata={(e) => restore(e.currentTarget as HTMLAudioElement)}
                  />
                ) : (
                  <button
                    type="button"
                    class={compact ? 'file-card-link image-thumbnail compact-image' : 'image-thumbnail'}
                    aria-label={`放大预览：${label || '图片'}`}
                    aria-haspopup="dialog"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (expiresAt.current && Date.now() + 10000 >= expiresAt.current) renew();
                      setPreview(true);
                      if (access)
                        void access
                          .load(threadId, src, undefined, true)
                          .then((file) => setOriginal(file.url))
                          .catch(() => setError('原图加载失败，可重试'));
                    }}
                  >
                    {compact ? (
                      <AttachmentIdentity
                        path={src}
                        name={name}
                        leading={
                          <img
                            key={`${url}:${localReference(src) ? '' : refresh}`}
                            loading="lazy"
                            decoding="async"
                            src={url}
                            alt=""
                            referrerpolicy="no-referrer"
                            onError={() => failed()}
                          />
                        }
                      />
                    ) : (
                      <img
                        key={`${url}:${localReference(src) ? '' : refresh}`}
                        loading="lazy"
                        decoding="async"
                        src={url}
                        alt={label}
                        referrerpolicy="no-referrer"
                        onError={() => failed()}
                      />
                    )}
                  </button>
                )
              ) : compact || error ? (
                <span class="file-card-link" aria-busy={!error}>
                  <AttachmentIdentity path={src} name={name} />
                </span>
              ) : (
                <span class="attachment-media-loading" role="status">
                  正在加载附件…
                </span>
              )}
              {!compact && url && label && media !== 'audio' && (
                <span class="attachment-caption" title={label}>
                  {label}
                </span>
              )}
              {error && (
                <div role="alert">
                  <small>{error}</small>
                  {!error.startsWith('原附件文件已') && (
                    <button type="button" class="secondary" onClick={() => renew()}>
                      重新加载附件
                    </button>
                  )}
                </div>
              )}
              {preview && url && (
                <ImagePreview
                  key={src}
                  src={original || url}
                  label={label}
                  error={error}
                  reload={refresh}
                  onClose={() => setPreview(false)}
                  onError={() => failed()}
                  onRetry={() => renew()}
                  onCopy={copyOriginal}
                  onDownload={download}
                />
              )}
            </div>
          </>
        )}
      </AttachmentActions>
    );
  };
});
