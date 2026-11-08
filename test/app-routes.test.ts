import { apiCall } from '../src/shared/rpc.js';
import { expect, it } from 'vitest';
import { readRoute, routeURL, parentRoute } from '../src/web/shell/routes';
it('restores a host-scoped conversation and keeps browser back destinations explicit', () => {
  const route = { page: 'workbench' as const, thread: 'chat-123', host: 'host123' };
  expect(readRoute(new URL(routeURL(route), 'https://app.invalid'))).toEqual(route);
  expect(parentRoute(route)).toEqual({ page: 'workbench' });
  expect(readRoute(new URL('https://app.invalid/?page=settings&thread=chat-123'))).toEqual({
    page: 'settings',
  });
});
it('handles one-use pairing fragments before ordinary routes without reflecting secrets', () => {
  expect(readRoute(new URL('https://app.invalid/?page=me#pair=secret&host=computer'))).toEqual({
    page: 'pair',
  });
  expect(routeURL({ page: 'pair' })).toBe('/?page=pair');
  expect(readRoute(new URL('https://app.invalid/?page=unknown'))).toEqual({ page: 'messages' });
});

it('round-trips opaque native IDs and preserves the selected backend', () => {
  const thread = 'native:id?# with spaces';
  const route = { page: 'workbench' as const, backend: 'dsh-one', thread };
  expect(readRoute(new URL(routeURL(route), 'https://example.com'))).toEqual(route);
  expect(apiCall(`/threads/${encodeURIComponent(thread)}/history`).params.id).toBe(thread);
});

it('keeps messaging conversation identities separate from desktop thread routes', () => {
  const conversation = '12345678-1234-1234-1234-123456789abc';
  const route = { page: 'messages' as const, conversation };
  expect(readRoute(new URL(routeURL(route), 'https://app.invalid'))).toEqual(route);
  expect(parentRoute(route)).toEqual({ page: 'messages' });
  expect(readRoute(new URL('https://app.invalid/?page=contacts&conversation=' + conversation))).toEqual({
    page: 'contacts',
  });
  expect(
    readRoute(new URL('https://app.invalid/?page=messages&conversation=invalid&thread=private')),
  ).toEqual({ page: 'messages' });
  expect(parentRoute({ page: 'integrations' })).toEqual({ page: 'contacts' });
});

it('opens messages from the root and preserves explicit workspace links', () => {
  expect(readRoute(new URL('https://app.invalid/'))).toEqual({ page: 'messages' });
  expect(readRoute(new URL('https://app.invalid/?page=workbench&backend=dsh'))).toEqual({
    page: 'workbench',
    backend: 'dsh',
  });
});
