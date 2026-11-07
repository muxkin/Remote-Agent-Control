/** Never navigate to a QR URL; parse only a same-origin, identity-pinned pairing capability. */
export function parsePairingLink(value: string, origin: string) {
  const url = new URL(value.trim());
  if (url.origin !== new URL(origin).origin || !['https:', 'http:'].includes(url.protocol))
    throw Error('请扫描当前服务生成的电脑配对二维码');
  const params = new URLSearchParams(url.hash.slice(1));
  const host = params.get('host') ?? '',
    code = params.get('pair') ?? '';
  if (!/^12D3KooW[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(host) || !/^[A-Za-z0-9_-]{20,256}$/.test(code))
    throw Error('二维码不是有效的电脑配对链接');
  return { host, code };
}
