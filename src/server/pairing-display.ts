import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { Config } from './config.js';
import { hostIdentity } from './device-identity.js';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

const qrOptions = { errorCorrectionLevel: 'M' as const, margin: 4, width: 512 };

export async function desktopPairingLink(config: Pick<Config, 'origin' | 'stateDir'>, code: string) {
  const url = new URL(config.origin);
  const identity = await hostIdentity(config.stateDir);
  url.hash = new URLSearchParams({ pair: code, host: identity.peerId }).toString();
  return url.href;
}

// The desktop supervisor needs only the image. Keep its short-lived ticket out of disk artifacts.
export async function desktopPairingImage(config: Pick<Config, 'origin' | 'stateDir'>, code: string) {
  const png = await QRCode.toBuffer(await desktopPairingLink(config, code), qrOptions);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Private local artifacts only. No unauthenticated endpoint may mint or serve pairing QR codes. */
export async function createPairingDisplay(
  config: Pick<Config, 'origin' | 'stateDir'>,
  pairing: { code: string; expiresAt: number },
) {
  const link = await desktopPairingLink(config, pairing.code);
  const [png, terminal] = await Promise.all([
    QRCode.toBuffer(link, qrOptions),
    QRCode.toString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }),
  ]);
  const directory = join(config.stateDir, 'pairing');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const imagePath = join(directory, 'qr.png');
  const pagePath = join(directory, 'index.html');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>扫码连接手机 · Codex Pocket Remote</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f5f6f8;color:#20242b;font:16px/1.65 system-ui,sans-serif}
main{width:min(100%,480px);padding:32px;background:white;border:1px solid #e5e8ee;border-radius:24px;text-align:center}
.brand{color:#747d8c;font-size:11px;letter-spacing:2px}h1{margin:12px 0;font-size:28px}p{margin:10px 0}.muted{color:#747d8c}#qr{display:block;width:min(100%,340px);height:auto;aspect-ratio:1;margin:16px auto}#countdown{font-variant-numeric:tabular-nums;color:#263b73;font-weight:600}
.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:22px 0 8px}a,button{border:1px solid #d8dce4;border-radius:10px;background:white;padding:10px 16px;color:#263b73;font:inherit;text-decoration:none;cursor:pointer}a:focus-visible,button:focus-visible{outline:3px solid #9eaeef;outline-offset:3px}small{display:block;color:#747d8c}code{background:#f0f2f7;padding:2px 5px}#expired{padding:24px 0}[hidden]{display:none!important}
</style></head><body><main>
<div class="brand">CODEX POCKET REMOTE</div><h1>扫码连接你的手机</h1>
<p class="muted">用手机相机扫一扫，在 Chrome 中打开。</p>
<img id="qr" src="data:image/png;base64,${png.toString('base64')}" width="512" height="512" alt="手机配对二维码">
<p id="countdown" role="status">正在计算有效期…</p>
<p class="muted" id="instruction">手机上点一下「连接电脑」，无需输入配对码。</p>
<div class="actions" id="actions"><button id="copy" type="button">复制配对链接</button><a id="link" href="${escapeHtml(link)}" rel="noreferrer">打开连接页面</a></div>
<p id="copied" role="status"></p>
<div id="expired" hidden><p>二维码已过期</p><p class="muted">在电脑重新运行 <code>npm run pair</code>，然后刷新此页。</p><button id="reload" type="button">刷新二维码</button></div>
<small>仅限一次配对。请只让自己的手机扫描。</small>
</main><script>
const expiresAt=${JSON.stringify(pairing.expiresAt)};
const qr=document.getElementById('qr'), countdown=document.getElementById('countdown');
function update(){const seconds=Math.max(0,Math.ceil((expiresAt-Date.now())/1000));countdown.textContent='剩余 '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+' · 一次有效';if(!seconds){clearInterval(timer);qr.removeAttribute('src');qr.hidden=true;document.getElementById('actions').hidden=true;document.getElementById('link').removeAttribute('href');document.getElementById('instruction').hidden=true;document.getElementById('expired').hidden=false;}}
const timer=setInterval(update,1000);update();
document.addEventListener('visibilitychange',update);
document.getElementById('reload').addEventListener('click',()=>location.reload());
document.getElementById('copy').addEventListener('click',async()=>{update();if(Date.now()>=expiresAt)return;const link=document.getElementById('link').href;try{await navigator.clipboard.writeText(link);document.getElementById('copied').textContent='链接已复制';}catch{document.getElementById('copied').textContent='请右键「打开连接页面」复制链接';}});
</script></body></html>`;
  async function save(path: string, data: string | Buffer) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  await save(imagePath, png);
  await save(pagePath, html);
  return { link, imagePath, pagePath, terminal, expiresAt: pairing.expiresAt };
}
