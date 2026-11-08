/** Shared browser security policy; runtimes only apply the resulting response headers. */
export function edgeSecurityHeaders(assetOrigin: string | null, uploadOrigins: string[]) {
  const uploads = uploadOrigins.map((value) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value) throw Error('Invalid storage origin');
    return value;
  });
  const asset = assetOrigin ? ` ${assetOrigin}` : '';
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'${asset}; style-src 'self' 'unsafe-inline'${asset}; font-src 'self'${asset}; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'${asset}${uploads.map((v) => ` ${v}`).join('')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  };
}
