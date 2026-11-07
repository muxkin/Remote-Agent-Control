import { useLayoutEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export function ImagePreview({
  src,
  label,
  error,
  reload,
  onClose,
  onError,
  onRetry,
}: {
  src: string;
  label: string;
  error: string;
  reload: number;
  onClose: () => void;
  onError: () => void;
  onRetry: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null),
    image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const current = useRef(view);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ view: typeof view; x: number; y: number; distance: number } | null>(null);
  const tap = useRef<{ time: number; x: number; y: number } | null>(null);
  const moved = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  function apply(next: typeof view) {
    const scale = Math.max(1, Math.min(6, next.scale));
    const bounds = stage.current;
    const width = Math.max(0, ((image.current?.clientWidth ?? 0) * scale - (bounds?.clientWidth ?? 0)) / 2);
    const height = Math.max(
      0,
      ((image.current?.clientHeight ?? 0) * scale - (bounds?.clientHeight ?? 0)) / 2,
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
    const rect = stage.current!.getBoundingClientRect();
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
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
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
  function move(event: ReactPointerEvent<HTMLDivElement>) {
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
  function end(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
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
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const element = stage.current!;
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
  return createPortal(
    <dialog
      ref={ref}
      className="image-preview"
      aria-labelledby={titleId}
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
        <button className="icon-button" aria-label="关闭图片预览" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div
        ref={stage}
        className="image-preview-stage"
        aria-label="图片缩放区域"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={(e) => end(e)}
        onPointerCancel={(e) => end(e, true)}
        onLostPointerCapture={(e) => end(e, true)}
        onDoubleClick={(e) => {
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
          referrerPolicy="no-referrer"
          onLoad={() => apply(current.current)}
          onError={onError}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="image-preview-controls" aria-label="图片缩放">
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
        <div className="image-preview-error" role="alert">
          <p>{error}</p>
          <button className="secondary" onClick={onRetry}>
            重新加载图片
          </button>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
