const $ = (id) => document.getElementById(id);
let loaded = false,
  expires = 0,
  running = false;
async function action(fn) {
  if (running) return;
  running = true;
  document.querySelectorAll('button').forEach((x) => (x.disabled = true));
  try {
    await fn();
  } catch (e) {
    $('notice').textContent = e.message || '操作未完成';
  } finally {
    running = false;
    document.querySelectorAll('button').forEach((x) => (x.disabled = false));
  }
}
async function refresh() {
  try {
    const s = await window.adapter.state();
    $('status').textContent = s.status;
    $('update').textContent = s.autoUpdate ? s.update : '自动更新已关闭';
    $('updateFeed').textContent = s.updateFeed ? `当前更新地址：${s.updateFeed}` : '填写服务地址后启用更新';
    $('version').textContent = `版本 ${s.version}`;
    if (!loaded) {
      $('origin').value = s.origin;
      $('updateBaseURL').value = s.updateBaseURL;
      $('autoStart').checked = s.autoStart;
      $('autoUpdate').checked = s.autoUpdate;
      loaded = true;
    }
  } catch {
    $('status').textContent = '管理器暂不可用';
  }
}
async function save() {
  await window.adapter.save({
    origin: $('origin').value.trim(),
    updateBaseURL: $('updateBaseURL').value.trim(),
    enrollment: $('enrollment').value,
    autoStart: $('autoStart').checked,
    autoUpdate: $('autoUpdate').checked,
  });
  $('enrollment').value = '';
  $('notice').textContent = '设置已保存';
  await refresh();
}
$('save').onclick = () => action(save);
$('saveUpdates').onclick = () => action(save);
for (const id of ['autoStart', 'autoUpdate'])
  $(id).onchange = () =>
    action(async () => {
      try {
        await save();
      } catch (e) {
        loaded = false;
        await refresh();
        throw e;
      }
    });
$('open').onclick = () => action(() => window.adapter.open());
$('check').onclick = () => action(() => window.adapter.check());
$('pair').onclick = () =>
  action(async () => {
    const p = await window.adapter.pair();
    $('qr').src = p.image;
    $('qr').hidden = false;
    expires = p.expiresAt;
    $('notice').textContent = '请用自己的手机扫描';
  });
setInterval(() => {
  if (expires) {
    const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    $('expiry').textContent = seconds
      ? `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : '二维码已过期，请重新生成';
    if (!seconds) {
      $('qr').hidden = true;
      $('qr').removeAttribute('src');
      expires = 0;
    }
  }
}, 1000);
setInterval(refresh, 3000);
void refresh();
