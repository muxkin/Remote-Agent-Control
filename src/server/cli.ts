import { readConfig } from './config.js';
import { Store } from './store.js';
import { createPairingDisplay } from './pairing-display.js';
import { platformRuntime } from './platform.js';
process.umask(0o077);
const config = readConfig();
const store = new Store(config.stateDir);
try {
  const command = process.argv[2];
  if (command === 'pair') {
    const display = await createPairingDisplay(config, store.mintPairing());
    console.log('用手机相机扫码，在 Chrome 打开后点击「连接电脑」：\n');
    console.log(display.terminal);
    console.log(
      `有效期至：${new Date(display.expiresAt).toLocaleString('zh-CN', { hour12: false })}（一次使用，5 分钟）`,
    );
    console.log(`大图页面：${display.pagePath}\n二维码图片：${display.imagePath}`);
    console.log(`备用链接：${display.link}`);
    if (process.argv.includes('--open')) {
      try {
        await platformRuntime().openFile(display.pagePath);
      } catch {
        console.error(`未能自动打开浏览器，请在电脑打开上方大图页面。`);
      }
    } else console.log('需要浏览器大图：npm run pair -- --open');
  } else if (command === 'devices') console.table(store.devices());
  else if (command === 'revoke' && process.argv[3]) {
    store.revoke(process.argv[3]);
    console.log('设备已撤销；活动连接将在 15 秒内关闭。');
  } else throw new Error('Usage: cli.ts pair [--open] | devices | revoke <device-id>');
} finally {
  store.close();
}
