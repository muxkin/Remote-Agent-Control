import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { setMediaAccount, invalidateMediaConversations, setEncryptedDownload } from './media-cache';
import { clearDrafts } from './drafts';
import { browserId } from '../browser-id';
import { MessagingError } from '../../client/messaging';
import { EncryptedMessagingClient } from '../../client/encrypted-messaging';
import { activateAccount, syncAccountHosts } from '../account-session';
import type { ChatConversation, ChatContact, ChatMessage, ChatUser } from '../../shared/messaging';
export const messaging = new EncryptedMessagingClient();
setEncryptedDownload((path, signal, cache) => messaging.download(path, signal, cache));
interface MessagingState {
  humanContacts: boolean;
  user: ChatUser | null;
  loading: boolean;
  contacts: ChatContact[];
  conversations: ChatConversation[];
  revision: number;
  recovery: number;
  updates: ChatMessage[];
  connectionError: string;
  setUser: (user: ChatUser | null) => void;
  updateProfile: (user: ChatUser) => void;
  refresh: () => Promise<void>;
}
const Context = createContext<MessagingState | null>(null);
export const useMessaging = () => useContext(Context)!;
export function MessagingProvider({ children }: { children: ReactNode }) {
  const [humanContacts, setHumanContacts] = useState(false);
  const [user, setUser] = useState<ChatUser | null>(null),
    [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<ChatContact[]>([]),
    [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [revision, setRevision] = useState(0),
    [recovery, setRecovery] = useState(0),
    [updates, setUpdates] = useState<ChatMessage[]>([]),
    [connectionError, setConnectionError] = useState('');
  const refresh = useCallback(async () => {
    window.dispatchEvent(new Event('pocket-im-reconnect'));
    try {
      const next = (await messaging.me()).user;
      await activateAccount(messaging.account, next);
      setMediaAccount(next?.id ?? null);
      setUser(next);
      setConnectionError('');
    } catch (e) {
      if (e instanceof MessagingError && e.status === 401) {
        await activateAccount(messaging.account, null);
        setMediaAccount(null);
        setUser(null);
      } else setConnectionError('消息服务暂不可用，请检查连接后重试');
    } finally {
      setLoading(false);
    }
  }, []);
  const updateUser = useCallback((next: ChatUser | null) => {
    setLoading(true);
    void activateAccount(messaging.account, next)
      .then(() => {
        setMediaAccount(next?.id ?? null);
        setUser(next);
        setRevision((v) => v + 1);
      })
      .catch((e) => {
        setUser(next);
        setConnectionError(e instanceof Error ? e.message : '账号同步失败');
      })
      .finally(() => setLoading(false));
    try {
      localStorage.setItem('pocket-im-account-change', browserId());
    } catch {}
  }, []);
  const updateProfile = useCallback((next: ChatUser) => {
    // Profile edits keep the unlocked session, mounted pages and drafts intact.
    setUser((current) => (current?.id === next.id ? next : current));
    setRevision((v) => v + 1);
  }, []);
  useEffect(() => {
    void refresh();
    const changed = (e: StorageEvent) => {
      if (e.key === 'pocket-im-account-change') void refresh();
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [refresh]);
  useEffect(() => {
    setMediaAccount(user?.id ?? null);
    clearDrafts();
    setHumanContacts(false);
    setContacts([]);
    setConversations([]);
    setUpdates([]);
    if (!user || loading) return;
    if (user.encrypted && !messaging.account.secrets) return;
    const abort = new AbortController(),
      signal = abort.signal;
    let request: AbortController | undefined, resumePause: (() => void) | undefined;
    const wake = () => {
      if (document.visibilityState === 'visible') {
        request?.abort();
        resumePause?.();
      }
    };
    window.addEventListener('online', wake);
    window.addEventListener('pocket-im-reconnect', wake);
    document.addEventListener('visibilitychange', wake);
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          if (resumePause === finish) resumePause = undefined;
          resolve();
        };
        const timer = setTimeout(finish, ms);
        resumePause = finish;
        signal.addEventListener('abort', finish, { once: true });
      });
    void (async () => {
      let cursor: number | undefined,
        recovering = true;
      let failures = 0;
      while (!signal.aborted) {
        request = new AbortController();
        const requestSignal = AbortSignal.any([signal, request.signal]);
        try {
          if (recovering) {
            if (messaging.account.secrets) await syncAccountHosts(messaging.account);
            const state = await messaging.request<{
              humanContacts?: boolean;
              contacts: ChatContact[];
              conversations: ChatConversation[];
              cursor: number;
            }>('/bootstrap', 'GET', undefined, requestSignal);
            if (signal.aborted) return;
            setHumanContacts(state.humanContacts === true);
            setContacts(state.contacts);
            setConversations(state.conversations);
            invalidateMediaConversations(new Set(state.conversations.map((c) => c.id)));
            cursor ??= state.cursor;
            setRecovery((v) => v + 1);
            recovering = false;
            setConnectionError('');
          }
          const next = await messaging.sync(cursor!, 25000, requestSignal);
          if (signal.aborted) return;
          if (next.events.length) {
            const messages = next.events.flatMap((e) => (e.message ? [e.message] : []));
            setUpdates((old) =>
              Array.from(new Map([...old, ...messages].map((m) => [m.id, m])).values()).slice(-200),
            );
            const [contacts, conversations] = await Promise.all([
              messaging.contacts(requestSignal),
              messaging.conversations(requestSignal),
            ]);
            if (signal.aborted) return;
            setContacts(contacts.users);
            setConversations(conversations.conversations);
            invalidateMediaConversations(new Set(conversations.conversations.map((c) => c.id)));
            setRevision((v) => v + 1);
            if (next.events.some((e) => e.type === 'profile')) {
              const result = await messaging.me(requestSignal);
              if (!signal.aborted) setUser(result.user);
            }
          }
          cursor = next.cursor;
          failures = 0;
          setConnectionError('');
        } catch (e) {
          if (signal.aborted) return;
          if (request.signal.aborted) {
            recovering = true;
            continue;
          }
          if (e instanceof MessagingError && e.status === 401) {
            await activateAccount(messaging.account, null);
            setMediaAccount(null);
            setUser(null);
            return;
          }
          failures++;
          if (!navigator.onLine) setConnectionError('当前离线，联网后会自动补齐消息');
          else if (failures >= 2) setConnectionError('正在恢复消息同步，已有记录仍可查看');
          recovering = true;
          await pause(Math.min(1000 * 2 ** (failures - 1), 10000));
        }
      }
    })();
    return () => {
      abort.abort();
      window.removeEventListener('online', wake);
      window.removeEventListener('pocket-im-reconnect', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [user?.id, user?.encrypted, loading]);
  return (
    <Context.Provider
      value={{
        user,
        humanContacts,
        loading,
        contacts,
        conversations,
        revision,
        recovery,
        updates,
        connectionError,
        setUser: updateUser,
        updateProfile,
        refresh,
      }}
    >
      {children}
    </Context.Provider>
  );
}
