const el = (id) => document.getElementById(id);
const phaseNames = { setup: '待设置', connecting: '正在连接', online: '已连接', unavailable: '连接中断，正在重试' };
const storageKey = 'agent-space-adapter-session';
let token = sessionStorage.getItem(storageKey);
let pairLink;
let qrUrl;
let qrRequest = 0;
let pairingAfterConnect = false;
let diagnostics = "";
let connecting = false;
let updateSettingsDirty = false;
let polling = false;
let expired = false;
let switching = false;
const reconnectMessage = '暂时无法连接本机适配器。请等待重连，或从托盘重新打开设置。';

function notify(text = '', error = false) {
  const notice = el('notice');
  notice.hidden = !text;
  notice.textContent = text;
  notice.dataset.kind = error ? 'error' : 'info';
}

async function request(path, options = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if ('body' in options) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    cache: 'no-store',
    body: 'body' in options ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      sessionStorage.removeItem(storageKey);
      expired = true;
      el('panel').hidden = true;
    }
    throw new Error(data.error || '请求未完成，请稍后重试');
  }
  return response;
}

const post = (path, body = {}) => request(path, { method: 'POST', body });

function showPair(pair) {
  el('pair-code').hidden = !pair;
  el('pair').textContent = pair ? '重新生成' : '生成配对码';
  if (pair) {
    el('pair-link').value = pair.link;
    const remaining = Math.max(0, pair.expiresAt - Date.now());
    el('pair-expiry').textContent = `剩余 ${Math.ceil(remaining / 1000)} 秒`;
  }
  if (pairLink === pair?.link) return;
  pairLink = pair?.link;
  const generation = ++qrRequest;
  if (qrUrl) URL.revokeObjectURL(qrUrl);
  qrUrl = undefined;
  el('qr').hidden = true;
  el('qr').removeAttribute('src');
  if (pair) {
    request('/api/pair-qr')
      .then((response) => response.blob())
      .then((blob) => {
        if (generation !== qrRequest) return;
        qrUrl = URL.createObjectURL(blob);
        el('qr').src = qrUrl;
        el('qr').hidden = false;
      })
      .catch(() => { /* The text link remains usable. */ });
  }
}

function render(state) {
  const ready = state.phase !== 'setup';
  const online = state.phase === 'online';
  el('panel').hidden = false;
  el('version').textContent = `v${state.version}`;
  el('phase').textContent = phaseNames[state.phase] || '正在启动';
  el('phase').dataset.phase = state.phase;
  el('connect').hidden = ready;
  el('connected').hidden = !ready;
  el('origin-value').textContent = state.origin || '';
  if (state.origin) el('workbench').href = state.origin;
  el('pair-section').hidden = !online;
  el('check').disabled = !state.updateSettings || state.checking;
  el('check').textContent = state.checking ? '正在检查…' : '检查更新';
  el('install').hidden = !state.manualUpdate;
  el('update-state').textContent = state.update || (ready ? '正在读取更新设置…' : '连接服务后即可检查更新。');
  el('startup-form').hidden = state.startup === null;
  if (state.startup !== null && !el('startup').disabled) el('startup').checked = state.startup;
  el('update-form').hidden = !state.updateSettings;
  if (state.updateSettings && !updateSettingsDirty) {
    el('automatic').checked = state.updateSettings.autoUpdate;
    el('update-base').value = state.updateSettings.updateBaseURL || '';
  }
  el('history').textContent = state.history ? '可用' : '未就绪';
  el('agents').textContent = state.agents.length
    ? state.agents.map((agent) => `${agent.name}（${agent.connected ? '在线' : '离线'}）`).join('、')
    : '暂无';
  diagnostics = [
    `Agent 空间适配器 v${state.version}`,
    `服务连接：${el('phase').textContent}`,
    `本机历史：${el('history').textContent}`,
    `受管 Agent：${el('agents').textContent}`,
    '设备通道：Noise 加密 · WebSocket',
  ].join('\n');
  showPair(online ? state.pairing : null);
  if (online && pairingAfterConnect) {
    pairingAfterConnect = false;
    post('/api/pair').catch((error) => notify(error.message, true));
  }
}

async function refresh() {
  if (polling || expired || switching || document.hidden) return;
  polling = true;
  try {
    const state = await (await request('/api/status')).json();
    if (el('panel').hidden || el('notice').textContent === reconnectMessage) {
      notify(state.setupError || '', Boolean(state.setupError));
    }
    render(state);
  } catch (error) {
    notify(expired ? error.message : reconnectMessage, true);
  } finally {
    polling = false;
  }
}

async function action(button, run) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await run();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
  await refresh();
}

el('connect').addEventListener('submit', (event) => {
  event.preventDefault();
  if (connecting) return;
  connecting = true;
  const button = event.submitter || el('connect').querySelector('button');
  action(button, async () => {
    await post('/api/connect', { origin: el('origin').value.trim(), enrollment: el('enrollment').value.trim() });
    el('enrollment').value = '';
    pairingAfterConnect = true;
    notify();
  }).finally(() => { connecting = false; });
});
el('pair').addEventListener('click', () => action(el('pair'), async () => {
  await post('/api/pair');
  notify('正在生成配对码…');
  setTimeout(() => {
    if (el('notice').textContent === '正在生成配对码…') notify();
  }, 2500);
}));
el('copy').addEventListener('click', () => action(el('copy'), async () => {
  try {
    await navigator.clipboard.writeText(el('pair-link').value);
    notify('已复制配对链接');
  } catch {
    el('pair-link').focus();
    el('pair-link').select();
    notify('已选中配对链接，请使用浏览器的复制命令。');
  }
}));
el('check').addEventListener('click', () => action(el('check'), () => post('/api/update/check')));
el('install').addEventListener('click', () => action(el('install'), async () => {
  await post('/api/update/install');
  notify('已请求安装更新，适配器会在安装后自动重启。');
}));
el('change').addEventListener('click', () => {
  if (!window.confirm('切换服务会暂时断开当前连接。继续后会打开新的连接设置页。')) return;
  action(el('change'), async () => {
    await post('/api/configure');
    switching = true;
    el('panel').hidden = true;
    notify('正在重新启动并打开连接设置…');
  });
});
el('copy-diagnostics').addEventListener('click', () => action(el('copy-diagnostics'), async () => {
  try {
    await navigator.clipboard.writeText(diagnostics);
    notify('已复制诊断信息');
  } catch {
    const text = el('diagnostics-text');
    text.value = diagnostics;
    text.hidden = false;
    text.focus();
    text.select();
    notify('已选中诊断信息，请使用浏览器的复制命令。');
  }
}));
el('quit').addEventListener('click', () => {
  if (!window.confirm('退出适配器会断开当前设备连接。确定退出？')) return;
  action(el('quit'), async () => {
    await post('/api/quit');
    switching = true;
    el('panel').hidden = true;
    notify('适配器已退出。可从系统的应用菜单重新启动。');
  });
});
el('startup').addEventListener('change', () => action(el('startup'), async () => {
  await post('/api/startup', { enabled: el('startup').checked });
  notify('已保存登录自启动设置');
}));
el('update-form').addEventListener('input', () => { updateSettingsDirty = true; });
el('update-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(event.submitter || el('update-form').querySelector('button'), async () => {
    await post('/api/update/settings', { automatic: el('automatic').checked, base: el('update-base').value });
    updateSettingsDirty = false;
    notify('已保存更新设置');
  });
});

async function start() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    const session = await (await post('/api/session', ticket)).json();
    token = session.token;
    sessionStorage.setItem(storageKey, token);
  }
  if (!token) throw new Error('请从适配器托盘菜单重新打开设置。');
  await refresh();
  document.addEventListener('visibilitychange', refresh);
  setInterval(refresh, 2000);
}

start().catch((error) => notify(error.message, true));
