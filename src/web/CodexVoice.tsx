import { onMounted, onScopeDispose, shallowRef, Teleport, useId, watch } from 'vue';
import { tsxComponent } from './tsx-component';
import type { CodexVoiceMode } from '../shared/codex-voice';
import { CodexVoiceSession, type CodexVoiceState } from './codex-voice-session';
import { deviceSession } from './device-session';
import { Icon } from './Icon';
import orb from './assets/codex-voice-orb.webp';
import './codex-voice.css';

const idle: CodexVoiceState = {
  phase: 'idle',
  muted: false,
  audioBlocked: false,
  transcript: [],
  activity: 'idle',
};

export default tsxComponent(function CodexVoice(_props: {
  hostId: string;
  backendId: string;
  threadId: string;
  mode: CodexVoiceMode;
  onClose: () => void;
  onOpenThread: (id: string) => void;
}) {
  const title = useId();
  const dialog = shallowRef<HTMLDialogElement | null>(null);
  const audio = shallowRef<HTMLAudioElement | null>(null);
  const transcript = shallowRef<HTMLDivElement | null>(null);
  let active: { release: () => void; session: CodexVoiceSession } | undefined;
  const stateRef = shallowRef(idle);
  let followTranscript = true;

  function stop(leavePage = false) {
    const call = active;
    active = undefined;
    call?.session.stop();
    call?.release();
    if (leavePage && call) {
      stateRef.value = { ...stateRef.value, phase: 'ended', activity: 'idle', audioBlocked: false };
    }
  }

  function pageHide() {
    stop(true);
  }

  let returnFocus: Element | null = null;
  let openDialog: HTMLDialogElement | null = null;
  onMounted(() => {
    returnFocus = document.activeElement;
    openDialog = dialog.value;
    openDialog?.showModal();
    window.addEventListener('pagehide', pageHide);
  });
  onScopeDispose(() => {
    window.removeEventListener('pagehide', pageHide);
    stop();
    openDialog?.close();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
  });

  watch(
    () => stateRef.value.transcript,
    () => {
      const element = transcript.value;
      if (element && followTranscript) element.scrollTop = element.scrollHeight;
    },
    { flush: 'post' },
  );

  return ({ hostId, backendId, threadId, mode, onClose, onOpenThread }) => {
    const state = stateRef.value;
    const inCall = state.phase === 'connecting' || state.phase === 'connected';
    const ended = state.phase === 'ended' || state.phase === 'error';

    function start() {
      if (!audio.value || active) return;
      followTranscript = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let session: CodexVoiceSession | undefined;
      try {
        const voice = deviceSession.voice(hostId, backendId, threadId, mode, (event) =>
          session?.receive(event),
        );
        const release = () => {
          clearInterval(heartbeat);
          voice.dispose();
        };
        session = new CodexVoiceSession(
          {
            start: async (sdp) => {
              await voice.start(sdp);
              if (!session || active?.session !== session) return;
              const call = session;
              heartbeat = setInterval(() => {
                void voice.heartbeat().catch(() => call.stop('电脑连接已中断'));
              }, 15_000);
            },
            stop: voice.stop,
          },
          (next) => {
            if (!session || active?.session !== session) return;
            stateRef.value = next;
            if (next.phase === 'error' || next.phase === 'ended') {
              release();
              active = undefined;
            }
          },
        );
        active = { session, release };
        void session.start(audio.value);
      } catch (error) {
        stateRef.value = {
          ...idle,
          phase: 'error',
          error: error instanceof Error ? error.message : '无法连接电脑',
        };
      }
    }

    const branchId = state.voiceThreadId !== threadId ? state.voiceThreadId : undefined;
    const status = {
      idle: '在语音分支中继续',
      connecting: '正在连接',
      connected: state.activity === 'speaking' ? 'Codex 正在说话' : state.muted ? '麦克风已静音' : '正在聆听',
      ended: '通话已结束',
      error: '语音连接失败',
    }[state.phase];

    return (
      <Teleport to={document.body}>
        <dialog
          ref={dialog}
          class="codex-voice"
          aria-labelledby={title}
          data-phase={state.phase}
          data-activity={state.activity}
          onCancel={(event) => {
            event.preventDefault();
            onClose();
          }}
        >
          <div class="codex-voice-layout">
            <header class="codex-voice-header">
              <div>
                <h2 id={title}>Codex Voice</h2>
                <p>
                  <span aria-hidden="true" />
                  {state.phase === 'connected' ? '正在与 Codex 语音对话' : '语音分支'}
                </p>
              </div>
              <button class="codex-voice-close" type="button" aria-label="关闭语音" onClick={onClose}>
                <Icon name="close" size={24} />
              </button>
            </header>

            <div class="codex-voice-stage">
              <img src={orb} alt="" width={640} height={640} />
              <p class="codex-voice-status" role="status">
                {status}
              </p>
              <div class="codex-voice-meter" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>

            {state.phase === 'idle' ? (
              <p class="codex-voice-note">
                用当前聊天的历史创建独立语音分支，Codex 可以查看项目，权限为只读。
              </p>
            ) : (
              <section class="codex-voice-transcript" aria-label="实时转写">
                <h3>实时转写</h3>
                <div
                  ref={transcript}
                  class="codex-voice-transcript-text"
                  tabindex={state.transcript.length ? 0 : undefined}
                  onScroll={() => {
                    const el = transcript.value;
                    if (el) followTranscript = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                  }}
                >
                  {state.transcript.length ? (
                    state.transcript.map(({ role, text }, index) => (
                      <p key={index}>
                        <span>{role === 'user' ? '你' : 'Codex'}</span>
                        {text}
                      </p>
                    ))
                  ) : (
                    <p class="codex-voice-note">
                      {inCall ? '说话后，转写将显示在这里。' : '本次通话没有转写。'}
                    </p>
                  )}
                </div>
              </section>
            )}

            <footer class="codex-voice-controls">
              {state.error && (
                <p role="alert" class="codex-voice-error">
                  {state.error}
                </p>
              )}
              {state.audioBlocked && (
                <button
                  type="button"
                  class="codex-voice-action"
                  onClick={() => void active?.session.resumeAudio()}
                >
                  开启声音
                </button>
              )}
              {inCall ? (
                <div class="codex-voice-buttons">
                  <button
                    type="button"
                    aria-pressed={state.muted}
                    onClick={() => active?.session.mute(!state.muted)}
                  >
                    <span>
                      <Icon name={state.muted ? 'micOff' : 'mic'} size={25} />
                    </span>
                    {state.muted ? '取消静音' : '静音'}
                  </button>
                  <button type="button" class="codex-voice-end" onClick={() => active?.session.stop()}>
                    <span>
                      <Icon name="hangup" size={29} />
                    </span>
                    挂断
                  </button>
                </div>
              ) : (
                <div class="codex-voice-actions">
                  {ended && branchId ? (
                    <button type="button" class="codex-voice-action" onClick={() => onOpenThread(branchId)}>
                      打开语音分支
                    </button>
                  ) : (
                    state.phase !== 'ended' && (
                      <button type="button" class="codex-voice-action" onClick={start}>
                        <Icon name="mic" size={18} />
                        {state.phase === 'error' ? '重试' : '开始语音'}
                      </button>
                    )
                  )}
                  {ended && (
                    <button type="button" class="codex-voice-action secondary-action" onClick={onClose}>
                      关闭
                    </button>
                  )}
                </div>
              )}
            </footer>
            <audio ref={audio} autoplay />
          </div>
        </dialog>
      </Teleport>
    );
  };
});
