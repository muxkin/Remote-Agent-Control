export type AppPage =
  | 'messages'
  | 'workbench'
  | 'me'
  | 'settings'
  | 'appearance'
  | 'devices'
  | 'integrations'
  | 'profile'
  | 'about'
  | 'pair';
export interface AppRoute {
  page: AppPage;
  backend?: string;
  thread?: string;
  host?: string;
}
const pages: AppPage[] = [
  'messages',
  'workbench',
  'me',
  'settings',
  'appearance',
  'devices',
  'integrations',
  'profile',
  'about',
  'pair',
];
export function readRoute(url: URL): AppRoute {
  if (new URLSearchParams(url.hash.slice(1)).has('pair')) return { page: 'pair' };
  const page = url.searchParams.get('page') as AppPage;
  const thread = url.searchParams.get('thread');
  const host = url.searchParams.get('host');
  return {
    ...(url.searchParams.get('backend') && /^[a-zA-Z0-9_-]{1,80}$/.test(url.searchParams.get('backend')!)
      ? { backend: url.searchParams.get('backend')! }
      : {}),
    page: pages.includes(page) ? page : 'workbench',
    ...(page === 'workbench' && thread && /^[^\x00-\x1f/\\]{1,200}$/.test(thread)
      ? { thread, ...(host && /^[a-zA-Z0-9]{1,200}$/.test(host) ? { host } : {}) }
      : {}),
  };
}
export function routeURL(route: AppRoute): string {
  const query = new URLSearchParams({ page: route.page });
  if (route.backend) query.set('backend', route.backend);
  if (route.page === 'workbench' && route.thread) {
    query.set('thread', route.thread);
    if (route.host) query.set('host', route.host);
  }
  return `/?${query}`;
}
export function parentRoute(route: AppRoute): AppRoute {
  if (route.page === 'workbench')
    return { page: 'workbench', ...(route.backend && route.thread ? { backend: route.backend } : {}) };
  if (route.page === 'pair') return { page: 'devices' };
  if (route.page === 'about' || route.page === 'appearance') return { page: 'settings' };
  return { page: 'me' };
}
