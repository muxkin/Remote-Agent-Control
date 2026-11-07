import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { Notice, errorText } from './ui';

/** Audio stays on this device until explicitly sent. Every exit releases the microphone. */
export function VoiceRecorder({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (file: File) => Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'stopping' | 'preview'>('idle');
  const [seconds, setSeconds] = useState(0),
    [clip, setClip] = useState<{ file: File; url: string }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [notice, setNotice] = useState('');
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    generation = useRef(0),
    objectURL = useRef(''),
    started = useRef(0),
    gesture = useRef<{ id: number; y: number; cancel: boolean } | null>(null),
    panel = useRef<HTMLElement>(null),
    clickMode = useRef(false);
  function release() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }
  function reset() {
    generation.current++;
    gesture.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
    recorder.current = null;
    if (objectURL.current) URL.revokeObjectURL(objectURL.current);
    objectURL.current = '';
  }
  useEffect(() => () => reset(), []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.preventDefault();
      reset();
      onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [busy, onClose]);
  function discard(message = '已取消录音') {
    reset();
    setState('idle');
    setClip(undefined);
    setSeconds(0);
    setCancelling(false);
    setNotice(message);
  }
  function stop() {
    if (recorder.current?.state !== 'recording') return;
    gesture.current = null;
    setCancelling(false);
    setState('stopping');
    recorder.current.stop();
    release();
  }
  useEffect(() => {
    if (state !== 'recording') return;
    const tick = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started.current) / 1000);
      setSeconds(elapsed);
      if (elapsed >= 120) stop();
    }, 200);
    const hidden = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [state]);
  async function start(hold?: { id: number; y: number; cancel: boolean }) {
    reset();
    gesture.current = hold ?? null;
    clickMode.current = !hold;
    setClip(undefined);
    setError('');
    setNotice('');
    setSeconds(0);
    setCancelling(false);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('idle');
      gesture.current = null;
      setError('当前浏览器无法录音。请使用 HTTPS 页面，或通过附件发送已有音频。');
      return;
    }
    const attempt = generation.current;
    setState('requesting');
    try {
      const source = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (attempt !== generation.current) {
        source.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = source;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      const media = new MediaRecorder(source, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64000,
      });
      recorder.current = media;
      const chunks: BlobPart[] = [];
      let size = 0;
      media.ondataavailable = (event) => {
        if (event.data.size) {
          chunks.push(event.data);
          size += event.data.size;
          if (size >= 9 * 1024 * 1024 && media.state === 'recording') stop();
        }
      };
      media.onerror = () => {
        if (attempt !== generation.current) return;
        discard('');
        setError('录音中断，请重试或上传已有音频。');
      };
      media.onstop = () => {
        source.getTracks().forEach((t) => t.stop());
        if (stream.current === source) stream.current = null;
        if (attempt !== generation.current) return;
        const mime = media.mimeType || mimeType || 'audio/webm',
          blob = new Blob(chunks, { type: mime });
        if (!blob.size || Date.now() - started.current < 500) {
          setError('说话时间太短，请再录一次。');
          setState('idle');
          return;
        }
        const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `语音-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, {
          type: mime,
        });
        objectURL.current = URL.createObjectURL(blob);
        setSeconds(Math.max(1, Math.round((Date.now() - started.current) / 1000)));
        setClip({ file, url: objectURL.current });
        setState('preview');
      };
      media.start(1000);
      started.current = Date.now();
      setState('recording');
    } catch (e) {
      if (attempt !== generation.current) return;
      release();
      gesture.current = null;
      setState('idle');
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? '麦克风权限未开启。请允许此站点使用麦克风后重试。'
          : e instanceof DOMException && e.name === 'NotFoundError'
            ? '没有找到麦克风，可以通过附件发送已有音频。'
            : errorText(e),
      );
    }
  }
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const recording = state === 'recording';
  return (
    <section
      ref={panel}
      className={`im-voice-panel im-input-tray ${state} ${cancelling ? 'is-cancelling' : ''}`}
      aria-label="语音消息"
    >
      <header className="im-tray-header">
        <strong>语音消息</strong>
        <button
          className="icon-button"
          aria-label="关闭语音"
          disabled={busy}
          onClick={() => {
            reset();
            onClose();
          }}
        >
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="im-voice-content">
        <div className="im-voice-visual" aria-hidden="true">
          {recording ? (
            <div className="im-voice-wave">
              {[12, 22, 34, 20, 40, 26, 34, 18, 12].map((height, i) => (
                <i key={i} style={{ height, animationDelay: `${i * -0.13}s` }} />
              ))}
            </div>
          ) : (
            <Icon name={clip ? 'check' : 'mic'} size={28} />
          )}
        </div>
        <strong className="im-voice-time">
          {clock}
          <small> / 2:00</small>
        </strong>
        <p className="im-voice-hint" role="status">
          {cancelling
            ? '松开取消'
            : recording
              ? clickMode.current
                ? '正在录音，点击停止后试听'
                : '松开试听，上滑取消'
              : state === 'requesting'
                ? '请允许使用麦克风'
                : state === 'stopping'
                  ? '正在保存录音…'
                  : clip
                    ? '先听一听，满意后再发送'
                    : notice || '按住说话，松开后可以试听'}
        </p>
        {clip ? (
          <>
            <audio controls preload="metadata" src={clip.url} aria-label="试听语音" />
            <div className="im-voice-actions">
              <button className="secondary" disabled={busy} onClick={() => discard('')}>
                <Icon name="refresh" size={16} />
                重录
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await onSend(clip.file);
                    reset();
                    onClose();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? '正在发送…' : '发送语音'}
                <Icon name="arrow" size={16} />
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="im-voice-hold"
              disabled={busy || state === 'stopping'}
              aria-label="按住说话"
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(event) => {
                if (event.button !== 0 || !event.isPrimary || state !== 'idle') return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                void start({ id: event.pointerId, y: event.clientY, cancel: false });
              }}
              onPointerMove={(event) => {
                const current = gesture.current;
                if (!current || current.id !== event.pointerId) return;
                current.cancel = event.clientY < current.y - 56;
                setCancelling(current.cancel);
              }}
              onPointerUp={(event) => {
                const current = gesture.current;
                if (!current || current.id !== event.pointerId) return;
                if (current.cancel) discard();
                else if (recorder.current?.state === 'recording') stop();
                else discard('允许麦克风后，再次按住说话');
              }}
              onPointerCancel={() => {
                if (gesture.current) discard();
              }}
              onLostPointerCapture={() => {
                if (gesture.current) discard();
              }}
              onClick={(event) => {
                if (event.detail === 0 && state === 'idle') void start();
                else if (event.detail === 0 && recording) stop();
              }}
            >
              <Icon name={cancelling ? 'trash' : 'mic'} size={20} />
              {cancelling
                ? '松开取消'
                : recording
                  ? '松开结束'
                  : state === 'requesting'
                    ? '正在打开麦克风…'
                    : '按住说话'}
            </button>
            <button
              className="im-voice-click"
              disabled={state === 'requesting' || state === 'stopping'}
              onClick={() => (recording ? stop() : void start())}
            >
              {recording ? '停止录音' : '也可以点击录音'}
            </button>
          </>
        )}
        <Notice text={error} />
      </div>
    </section>
  );
}
