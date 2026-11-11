import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { RTCPeerConnection } from 'werift';
import { EncryptedMessagingClient } from './encrypted-messaging.js';
import { AgentCallsClient } from './calls.js';
import type { AgentCall, CallPayload } from '../shared/calls.js';

type Cleanup = () => void | Promise<void>;
type EndReason = 'hangup' | 'declined' | 'failed';
export interface IncomingCall {
  call: AgentCall;
  peer: RTCPeerConnection;
  signal: AbortSignal;
  fail: () => void;
}
export interface AgentCallHandler {
  capabilities: { audio: true; video?: boolean };
  codecs?: RTCPeerConnection['config']['codecs'];
  onCall(context: IncomingCall): false | void | Cleanup | Promise<false | void | Cleanup>;
}

export async function loadCallAccount(file: string) {
  const state = JSON.parse(await readFile(file, 'utf8'));
  if (!state.origin || !state.token || !state.secrets || state.user?.kind !== 'agent')
    throw Error('An encrypted Agent credential file is required');
  const messaging = new EncryptedMessagingClient(state.origin, state.token);
  messaging.account.activate(state.user, state.secrets);
  return new AgentCallsClient(messaging);
}

export async function runAgentCallListener(
  calls: AgentCallsClient,
  handler: AgentCallHandler,
  signal: AbortSignal,
  onState?: (state: 'ready' | 'offline' | 'call-failed') => void,
  lifecycle?: { canAnswer(): boolean; active(value: boolean): void },
) {
  const agentId = calls.messaging.account.user?.id;
  if (!agentId || handler.capabilities.audio !== true || typeof handler.onCall !== 'function')
    throw Error('An Agent identity and an audio handler are required');
  const video = handler.capabilities.video === true;
  async function answer(call: AgentCall) {
    const abort = new AbortController();
    const callSignal = AbortSignal.any([signal, abort.signal]);
    let peer: RTCPeerConnection | undefined;
    let cleanup: Cleanup | undefined;
    let reason: EndReason = 'hangup';
    const fail = () => {
      if (callSignal.aborted) return;
      reason = 'failed';
      onState?.('call-failed');
      abort.abort();
    };
    try {
      if (call.mode === 'video' && !video) {
        reason = 'declined';
        return;
      }
      const { iceServers } = await calls.ice(callSignal);
      const connection = (peer = new RTCPeerConnection({
        iceTransportPolicy: 'all',
        iceServers: iceServers.flatMap((s) => s.urls.map((urls) => ({ ...s, urls }))),
        ...(handler.codecs && { codecs: handler.codecs }),
      }));
      let sending = Promise.resolve();
      const send = (payload: CallPayload) => {
        sending = sending
          .then(async () => {
            if (!callSignal.aborted) await calls.send(call, payload, callSignal);
          })
          .catch(fail);
        return sending;
      };
      connection.onIceCandidate.subscribe((candidate) => {
        if (candidate) void send({ type: 'candidate', candidate: candidate.toJSON() });
      });
      connection.connectionStateChange.subscribe((state) => {
        if (state === 'failed' || state === 'closed') fail();
      });
      const setupAbort = new AbortController();
      const setupSignal = AbortSignal.any([callSignal, setupAbort.signal]);
      let stopSetup: (() => void) | undefined;
      const timeout = setTimeout(() => setupAbort.abort(Error('Call handler setup timed out')), 20_000);
      try {
        const setup = Promise.resolve()
          .then(() => handler.onCall({ call, peer: connection, signal: callSignal, fail }))
          .then(async (result) => {
            if (setupSignal.aborted && typeof result === 'function') await result();
            else if (typeof result === 'function') cleanup = result;
            return result;
          });
        const cancelled = new Promise<never>((_, reject) => {
          stopSetup = () => reject(setupSignal.reason);
          if (setupSignal.aborted) stopSetup();
          else setupSignal.addEventListener('abort', stopSetup, { once: true });
        });
        if ((await Promise.race([setup, cancelled])) === false) {
          reason = 'declined';
          return;
        }
      } finally {
        clearTimeout(timeout);
        if (stopSetup) setupSignal.removeEventListener('abort', stopSetup);
      }

      await calls.update(call.id, 'accept', undefined, callSignal);
      const candidates: Parameters<typeof connection.addIceCandidate>[0][] = [];
      let heartbeat = Date.now(),
        after = 0;
      while (!callSignal.aborted) {
        const result = await calls.poll(call.id, after, callSignal);
        if (result.call.state === 'ended') break;
        for (const item of result.signals) {
          callSignal.throwIfAborted();
          if (item.senderId !== call.callerId) continue;
          const payload = await calls.decode(call, item);
          if (payload.type === 'description') {
            if (payload.description.type !== 'offer') throw Error('Expected an offer');
            await connection.setRemoteDescription(payload.description);
            for (const candidate of candidates.splice(0)) await connection.addIceCandidate(candidate);
            await connection.setLocalDescription(await connection.createAnswer());
            await send({
              type: 'description',
              description: { type: 'answer', sdp: connection.localDescription!.sdp },
            });
          } else if (connection.remoteDescription) await connection.addIceCandidate(payload.candidate);
          else candidates.push(payload.candidate);
        }
        after = result.cursor;
        if (Date.now() - heartbeat >= 20_000) {
          await calls.update(call.id, 'heartbeat', undefined, callSignal);
          heartbeat = Date.now();
        }
        await pause(connection.connectionState === 'connected' ? 1000 : 350, undefined, {
          signal: callSignal,
        });
      }
    } catch {
      fail();
    } finally {
      abort.abort();
      await Promise.allSettled([
        peer?.close(),
        Promise.resolve().then(() => cleanup?.()),
        calls.update(call.id, 'end', reason, AbortSignal.timeout(5000)),
      ]);
    }
  }

  let advertised = 0,
    active: Promise<void> | undefined,
    online: boolean | undefined,
    backoff = 1000;
  try {
    while (!signal.aborted) {
      try {
        if (!online || Date.now() - advertised >= 30_000) {
          await calls.ready(video, true, signal);
          advertised = Date.now();
        }
        if (!active && lifecycle?.canAnswer() !== false) {
          const { calls: pending } = await calls.list(signal);
          const call = pending.find((item) => item.state === 'ringing' && item.agentId === agentId);
          if (call && lifecycle?.canAnswer() !== false) {
            lifecycle?.active(true);
            active = answer(call).finally(() => {
              active = undefined;
              lifecycle?.active(false);
            });
          }
        }
        if (!online) onState?.('ready');
        online = true;
        backoff = 1000;
      } catch {
        if (online !== false && !signal.aborted) onState?.('offline');
        online = false;
        backoff = Math.min(backoff * 2, 15_000);
      }
      await pause(backoff, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await active;
    if (advertised) await calls.ready(false, false, AbortSignal.timeout(5000)).catch(() => {});
  }
}
