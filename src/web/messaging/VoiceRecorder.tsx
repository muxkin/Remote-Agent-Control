import { tsxComponent } from '../tsx-component';
import { shallowRef } from 'vue';
import { watchRender, writeRef } from '../render-effects';

import { Icon } from '../Icon';
import { Notice, errorText } from './ui';

/** Audio stays on this device until explicitly sent. Every exit releases the microphone. */
export const VoiceRecorder = tsxComponent(function VoiceRecorder(_props: {
  onClose: () => void;
  onSend: (file: File) => Promise<void>;
}) {
  const stateState = shallowRef<'idle' | 'requesting' | 'recording' | 'stopping' | 'preview'>('idle');
  const setState = writeRef(stateState);
  const secondsState = shallowRef(0);
  const setSeconds = writeRef(secondsState);
  const clipState = shallowRef<{ file: File; url: string }>();
  const setClip = writeRef(clipState);
  const errorState = shallowRef('');
  const setError = writeRef(errorState);
  const busyState = shallowRef(false);
  const setBusy = writeRef(busyState);
  const cancellingState = shallowRef(false);
  const setCancelling = writeRef(cancellingState);
  const noticeState = shallowRef('');
  const setNotice = writeRef(noticeState);
  const recorder: { current: MediaRecorder | null } = { current: null };
  const stream: { current: MediaStream | null } = { current: null };
  const generation = { current: 0 };
  const objectURL = { current: '' };
  const started = { current: 0 };
  const gesture: { current: { id: number; y: number; cancel: boolean } | null } = { current: null };
  const panel = shallowRef<HTMLElement | null>(null);
  const clickMode = { current: false };
  const afterRender = watchRender();
  const watchKeydown = watchRender();
  const watchInterval = watchRender();
  return ({ onClose, onSend }) => {
    const state = stateState.value;
    const seconds = secondsState.value;
    const clip = clipState.value;
    const error = errorState.value;
    const busy = busyState.value;
    const cancelling = cancellingState.value;
    const notice = noticeState.value;

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
    afterRender(() => () => reset(), []);
    watchKeydown(() => {
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
    watchInterval(() => {
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
          const file = new File(
            [blob],
            `语音-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`,
            {
              type: mime,
            },
          );
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
        class={`im-voice-panel im-input-tray ${state} ${cancelling ? 'is-cancelling' : ''}`}
        aria-label="语音消息"
      >
        <header class="im-tray-header">
          <strong>语音消息</strong>
          <button
            class="icon-button"
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
        <div class="im-voice-content">
          <div class="im-voice-visual" aria-hidden="true">
            {recording ? (
              <div class="im-voice-wave">
                {[12, 22, 34, 20, 40, 26, 34, 18, 12].map((height, i) => (
                  <i key={i} style={{ height, animationDelay: `${i * -0.13}s` }} />
                ))}
              </div>
            ) : (
              <Icon name={clip ? 'check' : 'mic'} size={28} />
            )}
          </div>
          <strong class="im-voice-time">
            {clock}
            <small> / 2:00</small>
          </strong>
          <p class="im-voice-hint" role="status">
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
              <div class="im-voice-actions">
                <button class="secondary" disabled={busy} onClick={() => discard('')}>
                  <Icon name="refresh" size={16} />
                  重录
                </button>
                <button
                  class="primary"
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
                class="im-voice-hold"
                disabled={busy || state === 'stopping'}
                aria-label="按住说话"
                onContextmenu={(e) => e.preventDefault()}
                onPointerdown={(event) => {
                  if (event.button !== 0 || !event.isPrimary || state !== 'idle') return;
                  event.preventDefault();
                  (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId);
                  void start({ id: event.pointerId, y: event.clientY, cancel: false });
                }}
                onPointermove={(event) => {
                  const current = gesture.current;
                  if (!current || current.id !== event.pointerId) return;
                  current.cancel = event.clientY < current.y - 56;
                  setCancelling(current.cancel);
                }}
                onPointerup={(event) => {
                  const current = gesture.current;
                  if (!current || current.id !== event.pointerId) return;
                  if (current.cancel) discard();
                  else if (recorder.current?.state === 'recording') stop();
                  else discard('允许麦克风后，再次按住说话');
                }}
                onPointercancel={() => {
                  if (gesture.current) discard();
                }}
                onLostpointercapture={() => {
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
                class="im-voice-click"
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
  };
});
