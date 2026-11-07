import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { Dialog, Notice, errorText } from './ui';

/** A recording stays local until the user attaches it; every exit releases microphone tracks. */
export function VoiceRecorder({
  onClose,
  onAttach,
}: {
  onClose: () => void;
  onAttach: (file: File) => Promise<boolean>;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'stopping' | 'preview'>('idle');
  const [seconds, setSeconds] = useState(0),
    [clip, setClip] = useState<{ file: File; url: string }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    generation = useRef(0),
    objectURL = useRef('');
  const started = useRef(0),
    discarded = useRef(false);
  function release() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }
  function reset() {
    generation.current++;
    discarded.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
    recorder.current = null;
    if (objectURL.current) URL.revokeObjectURL(objectURL.current);
    objectURL.current = '';
  }
  useEffect(() => () => reset(), []);
  function stop() {
    if (recorder.current?.state !== 'recording') return;
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
  async function start() {
    reset();
    setClip(undefined);
    setError('');
    setSeconds(0);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('idle');
      setError('当前浏览器无法录音。请使用 HTTPS 页面并允许麦克风，或通过附件发送已有音频。');
      return;
    }
    const attempt = generation.current;
    discarded.current = false;
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
        discarded.current = true;
        release();
        setError('录音中断，请重试或上传已有音频。');
        setState('idle');
      };
      media.onstop = () => {
        source.getTracks().forEach((t) => t.stop());
        if (stream.current === source) stream.current = null;
        if (attempt !== generation.current || discarded.current) return;
        const mime = media.mimeType || mimeType || 'audio/webm',
          blob = new Blob(chunks, { type: mime });
        if (!blob.size) {
          setError('没有录到声音，请重试。');
          setState('idle');
          return;
        }
        const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `语音-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, {
          type: mime,
        });
        objectURL.current = URL.createObjectURL(blob);
        setClip({ file, url: objectURL.current });
        setState('preview');
      };
      media.start(1000);
      started.current = Date.now();
      setState('recording');
    } catch (e) {
      if (attempt !== generation.current) return;
      release();
      setState('idle');
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? '麦克风权限未开启。允许此站点使用麦克风后再试。'
          : errorText(e),
      );
    }
  }
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <Dialog
      title="语音消息"
      onClose={() => {
        if (!busy) {
          reset();
          onClose();
        }
      }}
    >
      <div className={`im-voice ${state}`}>
        <span className="im-voice-symbol">
          <Icon name="mic" size={32} />
        </span>
        <strong className="im-voice-time" aria-live="polite">
          {clock}
        </strong>
        <p>
          {state === 'recording'
            ? '正在录音 · 最长 2 分钟'
            : state === 'requesting'
              ? '请允许使用麦克风'
              : state === 'preview'
                ? '试听后添加到消息'
                : state === 'stopping'
                  ? '正在保存录音…'
                  : '点按开始，说完后停止并试听'}
        </p>
        {clip && <audio controls src={clip.url} aria-label="试听语音" />}
        <Notice text={error} />
        <div className="im-voice-actions">
          {state === 'recording' ? (
            <button className="primary" onClick={stop}>
              <Icon name="stop" size={16} />
              停止录音
            </button>
          ) : (
            <button
              className="secondary"
              disabled={busy || ['requesting', 'stopping'].includes(state)}
              onClick={() => void start()}
            >
              {clip ? '重新录制' : '开始录音'}
            </button>
          )}
          {clip && (
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  if (await onAttach(clip.file)) {
                    reset();
                    onClose();
                  } else setError('上传未完成，录音已保留，可以重试。');
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '正在上传…' : '添加到消息'}
            </button>
          )}
        </div>
        <small className="im-help">录音不会自动发送；关闭面板会丢弃未添加的录音。</small>
      </div>
    </Dialog>
  );
}
