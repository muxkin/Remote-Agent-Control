import { tsxComponent } from '../tsx-component';
import { PageHeader } from '../shell/AppShell';
import type { AppRoute } from '../shell/routes';
import { AccountForm, Agents, Profile } from './AccountPages';
import ContactsPage from './ContactsPage';
import MessagesPage from './MessagesPage';
import { useMessaging } from './context';
import { Notice, type Navigate } from './ui';
import './messaging.css';
import './input-tools.css';
export default tsxComponent(function MessagingPages(_props: { route: AppRoute; navigate: Navigate }) {
  return ({ route, navigate }) => {
    const { user, loading, connectionError, refresh } = useMessaging();
    if (loading)
      return (
        <main class="module-page">
          <div class="page-loading" role="status">
            正在读取账户…
          </div>
        </main>
      );
    if (!user)
      return (
        <main class="module-page im-auth-page">
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
            <button class="secondary im-retry" onClick={() => void refresh()}>
              重新连接
            </button>
          )}
        </main>
      );
    return (
      <main
        class={`module-page im-page ${route.page === 'messages' || route.page === 'contacts' ? 'im-wide' : ''}`}
      >
        <div class="im-page-body">
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
          <div class="im-connection-notice" role="status">
            <span>{connectionError}</span>
            <button onClick={() => void refresh()}>重新连接</button>
          </div>
        )}
      </main>
    );
  };
});
