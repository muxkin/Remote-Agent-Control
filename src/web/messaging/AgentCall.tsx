import { useEffect, useRef, useState } from 'react';
import { AgentCallsClient } from '../../client/calls';
import type { CallCapabilities, CallMode } from '../../shared/calls';
import type { ChatConversation } from '../../shared/messaging';
import { Icon } from '../Icon';
import { messaging } from './context';
import { Dialog, Avatar, errorText } from './ui';
import { AgentCallSession, type CallViewState } from './call-session';
import './calls.css';
const calls = new AgentCallsClient(messaging);
const callModes = {
  audio: { label: '语音', icon: 'phone', devices: '麦克风' },
  video: { label: '视频', icon: 'video', devices: '麦克风和摄像头' },
} as const;
function Stream({ stream, local = false }: { stream?: MediaStream; local?: boolean }) {
  const video = useRef<HTMLVideoElement>(null),
    [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const node = video.current!;
    node.srcObject = stream ?? null;
    if (stream) void node.play().catch(() => setBlocked(true));
    return () => {
      node.srcObject = null;
    };
  }, [stream]);
  return (
    <>
      <video
        ref={video}
        playsInline
        autoPlay
        muted={local}
        aria-label={local ? '我的画面' : 'Agent 音视频'}
      />
      {!local && blocked && (
        <button
          className="secondary call-play"
          onClick={() =>
            void video.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => {})
          }
        >
          播放 Agent 声音
        </button>
      )}
    </>
  );
}
export function AgentCallActions({ conversation }: { conversation: ChatConversation }) {
  const [mode, setMode] = useState<CallMode>();
  return (
    <>
      <div className="call-entry-actions" role="group" aria-label="与 Agent 通话">
        {(['audio', 'video'] as const).map((kind) => (
          <button
            key={kind}
            className="call-entry"
            aria-label={`${callModes[kind].label}通话`}
            title={`${callModes[kind].label}通话`}
            aria-haspopup="dialog"
            onClick={() => setMode(kind)}
          >
            <Icon name={callModes[kind].icon} size={17} />
            <span>{callModes[kind].label}</span>
          </button>
        ))}
      </div>
      {mode && <CallDialog conversation={conversation} mode={mode} onClose={() => setMode(undefined)} />}
    </>
  );
}
function CallDialog({
  conversation,
  mode,
  onClose,
}: {
  conversation: ChatConversation;
  mode: CallMode;
  onClose: () => void;
}) {
  const [cap, setCap] = useState<CallCapabilities>(),
    [capFailed, setCapFailed] = useState(false),
    [error, setError] = useState(''),
    [started, setStarted] = useState(false),
    [view, setView] = useState<CallViewState>(),
    [seconds, setSeconds] = useState(0);
  const session = useRef<AgentCallSession | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => {
      if (session.current) return;
      void calls
        .capabilities(conversation.id, abort.signal)
        .then((value) => {
          if (abort.signal.aborted) return;
          setCap(value);
          setCapFailed(false);
        })
        .catch(() => {
          if (abort.signal.aborted) return;
          setCap(undefined);
          setCapFailed(true);
        });
    };
    refresh();
    const timer = setInterval(refresh, 15_000);
    const leave = () => session.current?.close();
    window.addEventListener('pagehide', leave);
    return () => {
      abort.abort();
      clearInterval(timer);
      window.removeEventListener('pagehide', leave);
      session.current?.close();
    };
  }, [conversation.id]);
  useEffect(() => {
    if (!view?.connectedAt || view.phase === 'ended') return;
    const tick = () => setSeconds(Math.floor((Date.now() - view.connectedAt!) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [view?.connectedAt, view?.phase]);
  function start() {
    if (session.current || !cap?.[mode]) return;
    setError('');
    setStarted(true);
    const active = new AgentCallSession(calls, setView);
    session.current = active;
    void active.start(conversation.id, mode);
  }
  const { label, icon, devices } = callModes[mode],
    available = !!cap?.[mode],
    readiness = capFailed
      ? '暂时无法确认 Agent 接听状态，稍后会自动重试。'
      : !cap
        ? '正在确认 Agent 接听状态…'
        : available
          ? '可接听'
          : mode === 'video' && cap.audio
            ? '这个 Agent 当前只支持语音通话。'
            : 'Agent 尚未开启通话或目前离线，文字聊天仍可使用。',
    phase = view?.phase,
    showVideo = started && mode === 'video' && phase !== 'ended',
    hasRemoteVideo = showVideo && view?.remote?.getVideoTracks().some((track) => track.readyState === 'live'),
    duration = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`,
    status =
      phase === 'connected'
        ? '通话中'
        : phase === 'ringing'
          ? '正在呼叫 Agent…'
          : phase === 'connecting'
            ? '正在连接…'
            : phase === 'ended'
              ? view?.error
              : started
                ? '正在准备设备…'
                : readiness;
  return (
    <Dialog className="call-sheet" title={`${label}通话`} titleIcon={<Icon name={icon} />} onClose={onClose}>
      <div
        className={`agent-call ${showVideo ? 'with-video' : ''} ${hasRemoteVideo ? 'has-remote-video' : ''}`}
      >
        <div className="call-stage">
          <div className="call-identity">
            {conversation.peer?.avatarUrl ? (
              <Avatar user={conversation.peer} large />
            ) : (
              <span className="call-avatar" aria-hidden="true">
                <Icon name="bot" size={42} />
              </span>
            )}
            <h3>{conversation.name}</h3>
            <p className="call-status" role="status">
              {(phase === 'connected' || (!started && available)) && <span aria-hidden="true" />}
              {status}
            </p>
            {!started && available && <p className="call-device-note">开始通话后将启用{devices}</p>}
          </div>
          {started && phase !== 'ended' && (
            <div className={`call-remote ${hasRemoteVideo ? '' : 'audio-only'}`}>
              <Stream stream={view?.remote} />
            </div>
          )}
          {showVideo && view?.local && (
            <div className="call-local">
              <Stream stream={view.local} local />
              <small>{view.camera ? '我' : '摄像头已关闭'}</small>
            </div>
          )}
        </div>
        {phase === 'connected' && (
          <span className="call-timer" role="timer" aria-label="通话时长">
            {duration}
          </span>
        )}
        {!started ? (
          <button className="primary call-start" disabled={!available} onClick={start}>
            <Icon name={icon} />
            开始{label}通话
          </button>
        ) : phase === 'ended' ? (
          <button className="secondary" onClick={onClose}>
            返回聊天
          </button>
        ) : (
          <div className="call-controls">
            <button
              className="secondary"
              disabled={!view?.local}
              aria-pressed={view?.muted ?? false}
              onClick={() => session.current?.mute()}
            >
              <Icon name="mic" />
              <span>{view?.muted ? '取消静音' : '静音'}</span>
            </button>
            {mode === 'video' && (
              <button
                className="secondary"
                disabled={!view?.local}
                aria-pressed={view?.camera ?? false}
                onClick={() => void session.current?.camera().catch((e) => setError(errorText(e)))}
              >
                <Icon name="video" />
                <span>{view?.camera ? '关闭画面' : '开启画面'}</span>
              </button>
            )}
            <button className="call-hangup" onClick={() => session.current?.close()}>
              <Icon name="hangup" />
              <span>挂断</span>
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
