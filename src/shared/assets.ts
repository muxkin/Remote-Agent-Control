export function assetSettings(value?: string): { base: string; origin: string | null } {
  if (!value) return { base: '/', origin: null };
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('POCKET_ASSET_BASE must be an HTTPS asset directory URL without credentials or query.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { base: url.href, origin: url.origin };
}
