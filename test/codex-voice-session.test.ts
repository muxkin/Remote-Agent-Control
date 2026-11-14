import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexVoiceSession } from '../src/web/codex-voice-session';

function setup(getUserMedia: () => Promise<MediaStream>) {
  vi.stubGlobal('window', { isSecureContext: true, RTCPeerConnection: function () {} });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const transport = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
  const changed = vi.fn();
  const audio = { pause: vi.fn(), srcObject: null } as unknown as HTMLAudioElement;
  return { session: new CodexVoiceSession(transport, changed), transport, changed, audio };
}

afterEach(() => vi.unstubAllGlobals());

describe('Codex Voice microphone startup', () => {
  it('releases the microphone when permission resolves after hangup', async () => {
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const track = { stop: vi.fn() };
    const { session, transport, changed, audio } = setup(() => permission);

    const starting = session.start(audio);
    session.stop();
    grant({ getTracks: () => [track] } as unknown as MediaStream);
    await starting;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.stop).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ended' }));
  });

  it('reports a refused microphone before starting the remote session', async () => {
    const { session, transport, changed, audio } = setup(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });

    await session.start(audio);

    expect(transport.start).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'error', error: expect.stringContaining('麦克风权限') }),
    );
  });
});

it('replaces partial transcript snapshots and keeps interleaved speakers in order', () => {
  const { session, changed } = setup(async () => {
    throw Error('microphone unused');
  });
  session.receive({ type: 'transcript', role: 'user', text: '检查', final: false });
  session.receive({ type: 'transcript', role: 'assistant', text: '好', final: false });
  session.receive({ type: 'transcript', role: 'user', text: '检查进度', final: false });
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcript: [
        { role: 'user', text: '检查进度', final: false },
        { role: 'assistant', text: '好', final: false },
      ],
    }),
  );
  session.receive({ type: 'transcript', role: 'user', text: '检查一下进度。', final: true });
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcript: [
        { role: 'user', text: '检查一下进度。', final: true },
        { role: 'assistant', text: '好', final: false },
      ],
    }),
  );
});
