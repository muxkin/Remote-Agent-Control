import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { onScopeDispose, shallowRef, watch } from 'vue';
import { z } from 'zod';
import {
  desktopAuthorizationLifetime,
  desktopAuthorizationSchema,
  type DesktopAuthorization,
} from '../../shared/desktop-authorization';
import { hostIdSchema } from '../../shared/relay-protocol';
import { syncAccountHosts } from '../account-session';
import { deviceSession } from '../device-session';
import { AccountForm } from '../messaging/AccountPages';
import { messaging, useMessaging } from '../messaging/context';
import type { PairedHost } from '../sync-store';
import { tsxComponent } from '../tsx-component';
import { PageHeader } from './PageHeader';

interface Start {
  kind: 'start';
  hostId: string;
  name: string;
  state: string;
  port: number;
}
interface Complete {
  kind: 'complete';
  authorization: DesktopAuthorization;
  code: string;
  accountId: string;
}
type Request = Start | Complete;
const intentKey = 'pocket-desktop-authorization';
const intentSchema = z.object({ state: z.string().uuid(), hostId: hostIdSchema, accountId: z.string() });

export function readDesktopAuthorization(fragment: string): Request | undefined {
  const params = new URLSearchParams(fragment.slice(1));
  const host = params.get('host');
  const name = params.get('name');
  const state = params.get('state');
  const initial = z
    .object({
      hostId: hostIdSchema,
      name: desktopAuthorizationSchema.shape.name,
      state: z.string().uuid(),
      port: z.number().int().min(1024).max(65535),
    })
    .safeParse({ hostId: host, name, state, port: Number(params.get('port')) });
  if (initial.success) return { kind: 'start', ...initial.data };

  const code = params.get('code') ?? '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) return;
  const result = desktopAuthorizationSchema.safeParse({
    hostId: host,
    name,
    ticket: bytesToHex(sha256(new TextEncoder().encode(code))),
    issuedAt: Number(params.get('issued')),
    signature: params.get('signature'),
  });
  if (!result.success) return;
  try {
    const intent = intentSchema.parse(JSON.parse(sessionStorage.getItem(intentKey) ?? 'null'));
    if (state !== intent.state || host !== intent.hostId) return;
    sessionStorage.removeItem(intentKey);
    return { kind: 'complete', authorization: result.data, code, accountId: intent.accountId };
  } catch {
    return;
  }
}

export const DesktopAuthorizationPage = tsxComponent(function DesktopAuthorizationPage(props: {
  request?: Request;
  finish: () => void;
}) {
  const session = useMessaging();
  const busy = shallowRef(false);
  const error = shallowRef('');
  const completed = shallowRef(false);
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  let pairedTicket: string | undefined;

  function confirm(request: Start, accountId: string) {
    try {
      const { state, hostId, port } = request;
      sessionStorage.setItem(intentKey, JSON.stringify({ state, hostId, accountId }));
      location.replace(`http://127.0.0.1:${port}/authorize/callback?state=${state}`);
    } catch {
      error.value = '浏览器无法保留本次授权，请检查站点存储权限';
    }
  }

  async function authorize({ authorization, code, accountId }: Complete) {
    if (busy.value || !messaging.account.secrets) return;
    const { signal } = controller;
    const assertAccount = () => {
      signal.throwIfAborted();
      if (session.loading || session.user?.id !== accountId || messaging.account.user?.id !== accountId)
        throw Error('登录账号已切换，请在适配器重新打开登录页');
    };
    busy.value = true;
    error.value = '';
    try {
      assertAccount();
      if (!pairedTicket) {
        await messaging.request('/desktop-devices/approve', 'POST', { accountId, authorization }, signal);
        const deadline = authorization.issuedAt + desktopAuthorizationLifetime;
        for (;;) {
          assertAccount();
          if (Date.now() >= deadline) throw Error('授权请求已过期，请在适配器重新打开登录页');
          const { ready } = await messaging.request<{ ready: boolean }>(
            '/desktop-devices/ready',
            'POST',
            {
              accountId,
              hostId: authorization.hostId,
              ticket: authorization.ticket,
            },
            signal,
          );
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        assertAccount();
        const host = await deviceSession.pair(authorization.hostId, code, '账号工作台', authorization.name);
        pairedTicket = host.ticket;
      }
      assertAccount();
      await syncAccountHosts(messaging.account);
      await messaging.account.refreshItems();
      const item = await messaging.account.readItem<{ kind: string; host: PairedHost }>(
        `host:${authorization.hostId}`,
      );
      assertAccount();
      if (item?.kind !== 'host' || item.host.ticket !== pairedTicket)
        throw Error('电脑已连接，账号同步尚未完成。请重试同步。');
      completed.value = true;
    } catch (cause) {
      if (!signal.aborted) error.value = cause instanceof Error ? cause.message : '连接未完成，请重试';
    } finally {
      busy.value = false;
    }
  }

  const request = props.request;
  if (request?.kind === 'complete') {
    let started = false;
    watch(
      [() => session.loading, () => session.user?.id],
      ([loading, userId]) => {
        if (loading || !userId || started) return;
        started = true;
        void authorize(request);
      },
      { immediate: true },
    );
  }

  return ({ finish }) => (
    <main class="module-page im-auth-page">
      <PageHeader title="添加这台电脑" />
      {!request ? (
        <section class="im-account">
          <p>请从电脑适配器点击「登录并连接」，打开新的授权页面。</p>
          <button onClick={finish}>返回工作台</button>
        </section>
      ) : !session.user ? (
        <AccountForm initialMode="login" />
      ) : request.kind === 'start' ? (
        <section class="im-account">
          <h2>{request.name}</h2>
          <p>设备指纹末尾 {request.hostId.slice(-12)}</p>
          <p>
            授权账号 {session.user.displayName}（UID {session.user.id}）
          </p>
          <p>请确认这是你正在设置的电脑。授权后，同一账号可在工作台访问这台电脑。</p>
          <button class="primary" onClick={() => confirm(request, session.user!.id)}>
            确认添加这台电脑
          </button>
          <button onClick={finish}>取消</button>
          {error.value && (
            <p role="alert" class="error">
              {error.value}
            </p>
          )}
        </section>
      ) : (
        <section class="im-account">
          <h2>{request.authorization.name}</h2>
          {completed.value ? (
            <>
              <p role="status">电脑已连接并同步到账号。</p>
              <button class="primary" onClick={finish}>
                打开工作台
              </button>
            </>
          ) : (
            <>
              {busy.value && <p role="status">正在连接并同步…</p>}
              {!busy.value && (
                <button class="primary" onClick={() => void authorize(request)}>
                  {pairedTicket ? '重试同步' : '重新连接'}
                </button>
              )}
              <button disabled={busy.value} onClick={finish}>
                取消
              </button>
            </>
          )}
          {error.value && (
            <p role="alert" class="error">
              {error.value}
            </p>
          )}
        </section>
      )}
    </main>
  );
});
