import { expect, it } from 'vitest';
import { AgentCallsClient } from '../../src/client/calls.js';
import { EncryptedMessagingClient } from '../../src/client/encrypted-messaging.js';
import { protectAccount } from '../../src/shared/account-crypto.js';
import type { AccountClient } from '../../src/client/account.js';
import type { ChatUser } from '../../src/shared/messaging.js';
export interface CallTestSession {
  account: AccountClient;
  client(): EncryptedMessagingClient;
}
export function agentCallsContract(setup: () => { origin: string; session(): CallTestSession }) {
  it('defaults to personal Agents and shares encrypted call authorization, capabilities, busy/end/revoke behavior', async () => {
    const { origin, session } = setup(),
      owner = session(),
      stranger = session();
    const suffix = Date.now().toString();
    await owner.account.register(`callowner${suffix}`, 'Owner', 'test-owner-call-password');
    await stranger.account.register(`callother${suffix}`, 'Other', 'test-other-call-password');
    const human = owner.client(),
      outsider = stranger.client();
    expect((await human.raw<{ humanContacts: boolean }>('/bootstrap')).humanContacts).toBe(false);
    await expect(human.addContact(stranger.account.user!.id)).rejects.toThrow('自己的 Agent');
    await expect(human.addContact('nonexistent-account')).rejects.toThrow('自己的 Agent');
    await expect(human.direct(stranger.account.user!.id)).rejects.toThrow('自己的 Agent');
    const protectedAccount = await protectAccount('test-agent-call-password');
    const { invitation } = await human.raw<{ invitation: string }>('/agent-invitations', 'POST');
    const registered = await new EncryptedMessagingClient(origin).raw<{ user: ChatUser; token: string }>(
      '/agents/register',
      'POST',
      {
        invitation,
        username: `callagent${suffix}`,
        displayName: 'Call Agent',
        vault: protectedAccount.vault,
      },
    );
    const agent = new EncryptedMessagingClient(origin, registered.token);
    agent.account.activate(registered.user, protectedAccount.secrets, protectedAccount.vault);
    await expect(outsider.addContact(registered.user.id)).rejects.toThrow('自己的 Agent');
    const { conversation } = await human.direct(registered.user.id),
      cid = conversation.id;
    const a = new AgentCallsClient(human),
      b = new AgentCallsClient(agent),
      evil = new AgentCallsClient(outsider);
    await expect(a.create(cid, 'audio')).rejects.toThrow('离线');
    await expect(a.ready(true)).rejects.toThrow('仅 Agent');
    await b.ready(false);
    expect(await a.capabilities(cid)).toMatchObject({ audio: true, video: false });
    await expect(a.create(cid, 'video')).rejects.toThrow('视频');
    await b.ready(true);
    const { call } = await a.create(cid, 'video');
    expect((await a.create(cid, 'video', call.id)).call.id).toBe(call.id);
    await expect(a.create(cid, 'audio')).rejects.toThrow('另一通');
    await expect(evil.poll(call.id, 0)).rejects.toThrow('不存在');
    await expect(evil.update(call.id, 'end')).rejects.toThrow('不存在');
    await expect(a.update(call.id, 'accept')).rejects.toThrow('只有 Agent');
    await expect(
      human.raw(`/calls/${call.id}/signals`, 'POST', {
        id: crypto.randomUUID(),
        encrypted: 'plaintext-sdp-not-allowed',
      }),
    ).rejects.toThrow('加密');
    const offer = {
      type: 'description' as const,
      description: { type: 'offer' as const, sdp: 'private-network-sdp-marker' },
    };
    await a.send(call, offer);
    const received = await b.poll(call.id, 0);
    expect(received.signals).toHaveLength(1);
    expect(received.signals[0].encrypted).not.toContain('private-network');
    expect(await b.decode(call, received.signals[0])).toEqual(offer);
    expect((await b.update(call.id, 'accept')).call.state).toBe('active');
    expect((await a.update(call.id, 'heartbeat')).call.state).toBe('active');
    await b.send(call, { type: 'description', description: { type: 'answer', sdp: 'private-answer' } });
    expect((await a.poll(call.id, received.cursor)).signals).toHaveLength(1);
    await a.update(call.id, 'end');
    expect(await b.poll(call.id, 0)).toMatchObject({ call: { state: 'ended' }, signals: [] });
    await expect(b.send(call, offer)).rejects.toThrow('结束');
    const second = (await a.create(cid, 'audio')).call;
    await human.raw(`/agents/${registered.user.id}/credentials`, 'DELETE');
    expect((await a.poll(second.id, 0)).call).toMatchObject({ state: 'ended', reason: 'unavailable' });
    expect(await a.capabilities(cid)).toMatchObject({ audio: false, video: false });
  }, 30000);
}
