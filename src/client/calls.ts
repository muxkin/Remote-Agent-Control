import type { EncryptedMessagingClient } from './encrypted-messaging.js';
import { encryptFor, decryptFor } from '../shared/account-crypto.js';
import type {
  AgentCall,
  CallCapabilities,
  CallIceServer,
  CallMode,
  CallPayload,
  CallSignal,
} from '../shared/calls.js';

/** Browser and Agent use the same authenticated, signed, encrypted signaling contract. */
export class AgentCallsClient {
  constructor(readonly messaging: EncryptedMessagingClient) {}
  capabilities(cid: string, signal?: AbortSignal) {
    return this.messaging.raw<CallCapabilities>(
      `/conversations/${encodeURIComponent(cid)}/call-capabilities`,
      'GET',
      undefined,
      signal,
    );
  }
  ready(video: boolean, available = true, signal?: AbortSignal) {
    return this.messaging.raw<{ expiresAt: number }>('/calls/presence', 'PUT', { video, available }, signal);
  }
  ice(signal?: AbortSignal) {
    return this.messaging.raw<{ iceServers: CallIceServer[] }>('/calls/ice', 'GET', undefined, signal);
  }
  create(cid: string, mode: CallMode, id: string = crypto.randomUUID(), signal?: AbortSignal) {
    return this.messaging.raw<{ call: AgentCall }>(
      `/conversations/${encodeURIComponent(cid)}/calls`,
      'POST',
      { id, mode },
      signal,
    );
  }
  list(signal?: AbortSignal) {
    return this.messaging.raw<{ calls: AgentCall[] }>('/calls', 'GET', undefined, signal);
  }
  update(
    id: string,
    action: 'accept' | 'heartbeat' | 'end',
    reason?: 'hangup' | 'declined' | 'failed',
    signal?: AbortSignal,
  ) {
    return this.messaging.raw<{ call: AgentCall }>(`/calls/${id}`, 'PATCH', { action, reason }, signal);
  }
  poll(id: string, after: number, signal?: AbortSignal) {
    return this.messaging.raw<{ call: AgentCall; signals: CallSignal[]; cursor: number }>(
      `/calls/${id}?after=${after}`,
      'GET',
      undefined,
      signal,
    );
  }
  async send(call: AgentCall, payload: CallPayload, signal?: AbortSignal) {
    const account = this.messaging.account;
    if (!account.user || !account.secrets || ![call.callerId, call.agentId].includes(account.user.id))
      throw Error('请先解锁通话账号');
    const sender = account.user.id,
      id = crypto.randomUUID();
    const keys = Object.fromEntries(
      await Promise.all(
        [call.callerId, call.agentId].map(async (uid) => [uid, await account.publicKeys(uid)]),
      ),
    );
    const encrypted = await encryptFor(account.secrets, sender, keys, `call:${call.id}:${id}`, payload);
    signal?.throwIfAborted();
    return this.messaging.raw(`/calls/${call.id}/signals`, 'POST', { id, encrypted }, signal);
  }
  async decode(call: AgentCall, item: CallSignal): Promise<CallPayload> {
    const account = this.messaging.account;
    if (!account.user || !account.secrets || ![call.callerId, call.agentId].includes(item.senderId))
      throw Error('通话信令身份无效');
    const payload = await decryptFor<CallPayload>(
      account.secrets,
      account.user.id,
      item.senderId,
      await account.publicKeys(item.senderId),
      `call:${call.id}:${item.id}`,
      item.encrypted,
    );
    if (
      payload.type === 'description' &&
      payload.description &&
      (payload.description.type === 'offer' || payload.description.type === 'answer') &&
      typeof payload.description.sdp === 'string'
    )
      return payload;
    if (payload.type === 'candidate' && payload.candidate && typeof payload.candidate.candidate === 'string')
      return payload;
    throw Error('通话信令格式无效');
  }
}
