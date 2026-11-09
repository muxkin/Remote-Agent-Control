/** Runs a user-supplied real-time media handler beside an existing encrypted IM Agent. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { RTCPeerConnection } from 'werift';
import { EncryptedMessagingClient } from '../src/client/encrypted-messaging.js';
import { AgentCallsClient } from '../src/client/calls.js';
import type { AgentCall, CallPayload } from '../src/shared/calls.js';

const { values } = parseArgs({ options: { state: { type: 'string' }, handler: { type: 'string' } } });
if (!values.state || !values.handler)
  throw Error('Usage: npm run im:call -- --state private-agent.json --handler ./media-handler.mjs');
const state = JSON.parse(await readFile(resolve(values.state), 'utf8'));
if (!state.origin || !state.token || !state.secrets || state.user?.kind !== 'agent')
  throw Error('An encrypted Agent credential file is required');
const handler = await import(pathToFileURL(resolve(values.handler)).href);
if (typeof handler.onCall !== 'function' || handler.capabilities?.audio !== true)
  throw Error('Handler must export capabilities.audio=true and onCall({ call, peer, signal })');
const messaging = new EncryptedMessagingClient(state.origin, state.token);
messaging.account.activate(state.user, state.secrets);
const calls = new AgentCallsClient(messaging),
  stop = new AbortController();
let active: { call: AgentCall; stop: () => Promise<void> } | undefined;
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort());
async function answer(call: AgentCall) {
  const abort = new AbortController();
  const { iceServers } = await calls.ice(stop.signal);
  const peer = new RTCPeerConnection({
    iceServers: iceServers.flatMap((s) => s.urls.map((urls) => ({ ...s, urls }))),
  });
  let cleanup: (() => void | Promise<void>) | undefined,
    closed = false,
    heartbeat = Date.now(),
    after = 0;
  const close = async () => {
    if (closed) return;
    closed = true;
    abort.abort();
    await peer.close();
    try {
      await cleanup?.();
    } finally {
      await calls.update(call.id, 'end').catch(() => {});
    }
  };
  active = { call, stop: close };
  let sending = Promise.resolve();
  const send = (payload: CallPayload) => {
    sending = sending
      .then(() => calls.send(call, payload, abort.signal))
      .then(() => {})
      .catch(() => close());
    return sending;
  };
  peer.onIceCandidate.subscribe((candidate) => {
    if (candidate) void send({ type: 'candidate', candidate: candidate.toJSON() });
  });
  peer.connectionStateChange.subscribe((s) => {
    if (s === 'failed' || s === 'closed') void close();
  });
  const candidates: Parameters<typeof peer.addIceCandidate>[0][] = [];
  try {
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    let stopSetup: (() => void) | undefined;
    const setup = Promise.resolve()
      .then(() => handler.onCall({ call, peer, signal: abort.signal }))
      .then(async (result) => {
        if (closed && typeof result === 'function') {
          await result();
          return false;
        }
        return result;
      });
    const deadline = new Promise<never>((_, reject) => {
      stopSetup = () => reject(Error('Call setup cancelled'));
      abort.signal.addEventListener('abort', stopSetup, { once: true });
      setupTimer = setTimeout(() => reject(Error('Call handler setup timed out')), 20_000);
    });
    let result;
    try {
      result = await Promise.race([setup, deadline]);
    } finally {
      clearTimeout(setupTimer);
      if (stopSetup) abort.signal.removeEventListener('abort', stopSetup);
    }

    if (result === false) {
      await calls.update(call.id, 'end', 'declined');
      return;
    }
    cleanup = typeof result === 'function' ? result : undefined;
    if (stop.signal.aborted || closed) return;
    await calls.update(call.id, 'accept');
    while (!stop.signal.aborted && !closed) {
      const result = await calls.poll(call.id, after, abort.signal);
      if (result.call.state === 'ended') break;
      for (const item of result.signals) {
        if (item.senderId !== call.callerId) continue;
        const payload = await calls.decode(call, item);
        if (payload.type === 'description') {
          if (payload.description.type !== 'offer') throw Error('Expected an offer');
          await peer.setRemoteDescription(payload.description);
          for (const c of candidates.splice(0)) await peer.addIceCandidate(c);
          await peer.setLocalDescription(await peer.createAnswer());
          await send({
            type: 'description',
            description: { type: 'answer', sdp: peer.localDescription!.sdp },
          });
        } else if (peer.remoteDescription) await peer.addIceCandidate(payload.candidate);
        else candidates.push(payload.candidate);
      }
      after = result.cursor;
      if (Date.now() - heartbeat >= 20_000) {
        await calls.update(call.id, 'heartbeat');
        heartbeat = Date.now();
      }
      await pause(750, undefined, { signal: abort.signal });
    }
  } catch (e) {
    if (!closed && !stop.signal.aborted)
      console.error('Agent call ended:', e instanceof Error ? e.name : 'Error');
  } finally {
    await close();
    if (active?.call.id === call.id) active = undefined;
  }
}
let advertised = 0,
  answering = false;
try {
  while (!stop.signal.aborted) {
    if (Date.now() - advertised > 30_000) {
      await calls.ready(handler.capabilities.video === true);
      advertised = Date.now();
    }
    if (!active && !answering) {
      const { calls: pending } = await calls.list(stop.signal);
      const call = pending.find((c) => c.state === 'ringing' && c.agentId === state.user.id);
      if (call) {
        answering = true;
        void answer(call)
          .catch(() => {})
          .finally(() => {
            answering = false;
          });
      }
    }
    await pause(1000, undefined, { signal: stop.signal });
  }
} catch (error) {
  if (!stop.signal.aborted) throw error;
} finally {
  stop.abort();
  await active?.stop();
  await calls.ready(false, false).catch(() => {});
}
