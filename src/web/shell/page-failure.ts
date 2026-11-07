export interface PageFailure {
  kind: 'resource' | 'runtime';
  resource?: string;
}
/** Keep URLs, query strings and arbitrary error text out of local diagnostic records. */
export function pageFailure(error: unknown): PageFailure {
  const message = error instanceof Error ? error.message : '';
  const resource = /(?:\/assets\/)([A-Za-z0-9_.-]+\.(?:js|css))(?:[?#\s]|$)/.exec(message)?.[1];
  return {
    kind: /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading (?:CSS )?chunk|Unable to preload CSS|Failed to load module script/i.test(
      message,
    )
      ? 'resource'
      : 'runtime',
    ...(resource ? { resource } : {}),
  };
}
