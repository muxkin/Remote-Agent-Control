import { tsxComponent } from './tsx-component';
import { shallowRef, useId, Teleport } from 'vue';
import { watchRender, writeRef } from './render-effects';

import { Icon } from './Icon';
import { copyImage } from './image-clipboard';

export const ImagePreview = tsxComponent(function ImagePreview(_props: {
  src: string;
  label: string;
  error: string;
  reload: number;
  onClose: () => void;
  onError: () => void;
  onRetry: () => void;
  onCopy?: () => Promise<void>;
  onDownload?: () => void | Promise<void>;
  returnFocus?: HTMLElement | null;
}) {
  const ref = shallowRef<HTMLDialogElement | null>(null);
  const stage = shallowRef<HTMLDivElement | null>(null);
  const image = shallowRef<HTMLImageElement | null>(null);
  const viewState = shallowRef({ scale: 1, x: 0, y: 0 });
  const setView = writeRef(viewState);
  const copyStateState = shallowRef('');
  const setCopyState = writeRef(copyStateState);
  const copyingState = shallowRef(false);
  const setCopying = writeRef(copyingState);
  const downloadingState = shallowRef(false);
  const setDownloading = writeRef(downloadingState);
  const current = { current: viewState.value };
  const pointers = { current: new Map<number, { x: number; y: number }>() };
  const gesture: {
    current: { view: typeof viewState.value; x: number; y: number; distance: number } | null;
  } = { current: null };
  const tap: { current: { time: number; x: number; y: number } | null } = { current: null };
  const moved = { current: false };
  const start = { current: { x: 0, y: 0 } };
  const titleId = useId();
  const watchReturnFocus = watchRender();
  const watchWheel = watchRender();
  return ({ src, label, error, reload, onClose, onError, onRetry, onCopy, onDownload, returnFocus }) => {
    const view = viewState.value;
    const copyState = copyStateState.value;
    const copying = copyingState.value;
    const downloading = downloadingState.value;

    function apply(next: typeof view) {
      const scale = Math.max(1, Math.min(6, next.scale));
      const bounds = stage.value;
      const width = Math.max(0, ((image.value?.clientWidth ?? 0) * scale - (bounds?.clientWidth ?? 0)) / 2);
      const height = Math.max(
        0,
        ((image.value?.clientHeight ?? 0) * scale - (bounds?.clientHeight ?? 0)) / 2,
      );
      current.current = {
        scale,
        x: Math.max(-width, Math.min(width, next.x)),
        y: Math.max(-height, Math.min(height, next.y)),
      };
      setView(current.current);
    }
    function zoom(scale: number, x = 0, y = 0) {
      const old = current.current,
        next = Math.max(1, Math.min(6, scale)),
        ratio = next / old.scale;
      apply({ scale: next, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio });
    }
    function point(clientX: number, clientY: number) {
      const rect = stage.value!.getBoundingClientRect();
      return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    }
    function measure() {
      const [a, b] = [...pointers.current.values()];
      if (!a) return null;
      return {
        x: b ? (a.x + b.x) / 2 : a.x,
        y: b ? (a.y + b.y) / 2 : a.y,
        distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      };
    }
    function begin() {
      const center = measure();
      gesture.current = center ? { ...center, view: { ...current.current } } : null;
    }
    function down(event: PointerEvent) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
      const position = point(event.clientX, event.clientY);
      pointers.current.set(event.pointerId, position);
      if (pointers.current.size === 1) {
        start.current = position;
        moved.current = false;
      } else {
        moved.current = true;
        tap.current = null;
      }
      begin();
    }
    function move(event: PointerEvent) {
      if (!pointers.current.has(event.pointerId)) return;
      const position = point(event.clientX, event.clientY);
      pointers.current.set(event.pointerId, position);
      if (Math.hypot(position.x - start.current.x, position.y - start.current.y) > 6) moved.current = true;
      const center = measure(),
        base = gesture.current;
      if (!center || !base) return;
      const scale = Math.max(
        1,
        Math.min(
          6,
          base.distance > 0 && center.distance > 0
            ? (base.view.scale * center.distance) / base.distance
            : base.view.scale,
        ),
      );
      const ratio = scale / base.view.scale;
      apply({
        scale,
        x: center.x - (base.x - base.view.x) * ratio,
        y: center.y - (base.y - base.view.y) * ratio,
      });
    }
    function end(event: PointerEvent, cancelled = false) {
      if (!pointers.current.delete(event.pointerId)) return;
      if (!cancelled && !moved.current && !pointers.current.size && event.pointerType !== 'mouse') {
        const position = point(event.clientX, event.clientY),
          now = Date.now();
        if (
          tap.current &&
          now - tap.current.time < 300 &&
          Math.hypot(position.x - tap.current.x, position.y - tap.current.y) < 24
        ) {
          zoom(current.current.scale > 1 ? 1 : 2.5, position.x, position.y);
          tap.current = null;
        } else tap.current = { time: now, ...position };
      }
      begin();
    }

    watchReturnFocus(() => {
      const dialog = ref.value!;
      const trigger = returnFocus ?? document.activeElement;
      dialog.showModal();
      return () => {
        dialog.close();
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
      };
    }, [returnFocus]);
    watchWheel(() => {
      const element = stage.value!;
      const wheel = (event: WheelEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const position = point(event.clientX, event.clientY);
        zoom(current.current.scale * Math.exp(-event.deltaY * 0.005), position.x, position.y);
      };
      const observer = new ResizeObserver(() => apply(current.current));
      observer.observe(element);
      element.addEventListener('wheel', wheel, { passive: false });
      return () => {
        observer.disconnect();
        element.removeEventListener('wheel', wheel);
      };
    }, []);
    return (
      <Teleport to={document.body}>
        <dialog
          ref={ref}
          class="image-preview"
          aria-labelledby={titleId}
          onContextmenu={(event) => event.stopPropagation()}
          onCancel={(event) => {
            event.preventDefault();
            onClose();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <header>
            <h2 id={titleId}>{label || '图片预览'}</h2>
            <button
              class="image-preview-copy"
              disabled={copying || !!error}
              onClick={() => {
                setCopying(true);
                setCopyState('');
                void (onCopy ? onCopy() : copyImage(src))
                  .then(() => setCopyState('图片已复制'))
                  .catch(() => setCopyState('复制失败，请在图片上右键复制，或下载保存'))
                  .finally(() => setCopying(false));
              }}
            >
              <Icon name="copy" size={18} />
              {copying ? '正在复制…' : '复制图片'}
            </button>
            {onDownload && (
              <button
                class="icon-button"
                aria-label="下载图片"
                disabled={downloading}
                onClick={async () => {
                  setDownloading(true);
                  setCopyState('');
                  try {
                    await onDownload();
                  } catch {
                    setCopyState('图片下载失败，请重试');
                  } finally {
                    setDownloading(false);
                  }
                }}
              >
                <Icon name="download" />
              </button>
            )}
            <button class="icon-button" aria-label="关闭图片预览" onClick={onClose}>
              <Icon name="close" />
            </button>
          </header>
          {copyState && (
            <p class="image-preview-copy-status" role="status">
              {copyState}
            </p>
          )}
          <div
            ref={stage}
            class="image-preview-stage"
            aria-label="图片缩放区域"
            onPointerdown={down}
            onPointermove={move}
            onPointerup={(e) => end(e)}
            onPointercancel={(e) => end(e, true)}
            onLostpointercapture={(e) => end(e, true)}
            onDblclick={(e) => {
              const p = point(e.clientX, e.clientY);
              zoom(current.current.scale > 1 ? 1 : 2.5, p.x, p.y);
            }}
          >
            <img
              ref={image}
              key={reload}
              src={src}
              alt={label}
              draggable={false}
              referrerpolicy="no-referrer"
              onLoad={() => apply(current.current)}
              onError={onError}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
          </div>
          <div class="image-preview-controls" aria-label="图片缩放">
            <button
              type="button"
              aria-label="缩小图片"
              disabled={view.scale <= 1}
              onClick={() => zoom(current.current.scale / 1.5)}
            >
              −
            </button>
            <button type="button" aria-label="重置图片缩放" onClick={() => apply({ scale: 1, x: 0, y: 0 })}>
              {Math.round(view.scale * 100)}%
            </button>
            <button
              type="button"
              aria-label="放大图片"
              disabled={view.scale >= 6}
              onClick={() => zoom(current.current.scale * 1.5)}
            >
              +
            </button>
          </div>
          {error && (
            <div class="image-preview-error" role="alert">
              <p>{error}</p>
              <button class="secondary" onClick={onRetry}>
                重新加载图片
              </button>
            </div>
          )}
        </dialog>
      </Teleport>
    );
  };
});
