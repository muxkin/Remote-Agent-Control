export type AppPage =
  'messages' | 'workbench' | 'me' | 'settings' | 'devices' | 'integrations' | 'profile' | 'about' | 'pair';
export interface AppRoute {
  page: AppPage;
  thread?: string;
  host?: string;
}
const pages: AppPage[] = [
  'messages',
  'workbench',
  'me',
  'settings',
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
    page: pages.includes(page) ? page : 'workbench',
    ...(page === 'workbench' && thread && /^[a-zA-Z0-9-]{1,200}$/.test(thread)
      ? { thread, ...(host && /^[a-zA-Z0-9]{1,200}$/.test(host) ? { host } : {}) }
      : {}),
  };
}
export function routeURL(route: AppRoute): string {
  const query = new URLSearchParams({ page: route.page });
  if (route.page === 'workbench' && route.thread) {
    query.set('thread', route.thread);
    if (route.host) query.set('host', route.host);
  }
  return `/?${query}`;
}
export function parentRoute(route: AppRoute): AppRoute {
  if (route.page === 'workbench') return { page: 'workbench' };
  if (route.page === 'pair') return { page: 'devices' };
  if (route.page === 'about') return { page: 'settings' };
  return { page: 'me' };
}
