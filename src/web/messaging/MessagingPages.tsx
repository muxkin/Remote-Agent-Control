import { PageHeader } from '../shell/AppShell';
import type { AppRoute } from '../shell/routes';
import { AccountForm, Agents, Profile } from './AccountPages';
import ContactsPage from './ContactsPage';
import MessagesPage from './MessagesPage';
import { useMessaging } from './context';
import { Notice, type Navigate } from './ui';
import './messaging.css';
export default function MessagingPages({ route, navigate }: { route: AppRoute; navigate: Navigate }) {
  const { user, loading, connectionError, refresh } = useMessaging();
  if (loading)
    return (
      <main className="module-page">
        <div className="page-loading" role="status">
          正在读取账户…
        </div>
      </main>
    );
  if (!user)
    return (
      <main className="module-page im-auth-page">
        <PageHeader
          title={route.page === 'contacts' ? '联系人' : '消息与账户'}
          back={
            route.page === 'profile'
              ? () => navigate({ page: 'me' })
              : route.page === 'integrations'
                ? () => navigate({ page: 'contacts' })
                : route.conversation
                  ? () => navigate({ page: 'messages' })
                  : undefined
          }
        />
        <AccountForm />
        <Notice text={connectionError} />
        {connectionError && (
          <button className="secondary im-retry" onClick={() => void refresh()}>
            重新连接
          </button>
        )}
      </main>
    );
  return (
    <main
      className={`module-page im-page ${route.page === 'messages' || route.page === 'contacts' ? 'im-wide' : ''}`}
    >
      <div className="im-page-body">
        {route.page === 'profile' ? (
          <Profile navigate={navigate} />
        ) : route.page === 'integrations' ? (
          <Agents navigate={navigate} />
        ) : route.page === 'contacts' ? (
          <ContactsPage navigate={navigate} />
        ) : (
          <MessagesPage id={route.conversation} navigate={navigate} />
        )}
      </div>
      {connectionError && (
        <div className="im-connection-notice" role="status">
          <span>{connectionError}</span>
          <button onClick={() => void refresh()}>重新连接</button>
        </div>
      )}
    </main>
  );
}
