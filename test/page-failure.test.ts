import { describe, expect, it } from 'vitest';
import { pageFailure } from '../src/web/shell/page-failure';

describe('page failure recovery diagnostics', () => {
  it('identifies failed imports without retaining URLs or credentials', () => {
    expect(
      pageFailure(
        new TypeError(
          'Failed to fetch dynamically imported module: https://example.com/assets/Page-abc123.js?token=private',
        ),
      ),
    ).toEqual({
      kind: 'resource',
      resource: 'Page-abc123.js',
    });
  });
  it.each([
    'Importing a module script failed.',
    'error loading dynamically imported module',
    'Unable to preload CSS for https://example.com/assets/style-abc.css',
  ])('recognizes browser resource errors: %s', (message) => {
    expect(pageFailure(new Error(message)).kind).toBe('resource');
  });
  it('does not mislabel application failures as network failures or persist their contents', () => {
    expect(pageFailure(new Error('private account data'))).toEqual({ kind: 'runtime' });
    expect(pageFailure({ message: 'private data' })).toEqual({ kind: 'runtime' });
  });
});
