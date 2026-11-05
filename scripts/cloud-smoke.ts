import { privateOutput } from './private-output.js';
await privateOutput('.test-output');
/** Authenticated, read-only public-entry QA. Optional restart targets only our tunnel unit. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import WebSocket from 'ws';
import { readConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';

const config = readConfig();
const threadId = process.argv[2];
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/);
assert.equal(new URL(config.origin).protocol, 'https:');
const store = new Store(config.stateDir);
const report = {
  date: new Date().toISOString(),
  origin: config.origin,
  checks: {} as Record<string, boolean>,
  timingsMs: {} as Record<string, number>,
};
let deviceId: string | undefined;
let cookie = '';
const sockets: WebSocket[] = [];
const headers = () => ({ Origin: config.origin, Cookie: cookie, 'Content-Type': 'application/json' });
const api = (path: string, init: RequestInit = {}) =>
  fetch(new URL(path, config.origin), { headers: headers(), signal: AbortSignal.timeout(12000), ...init });
const wsUrl = new URL(`/api/events?threadId=${threadId}`, config.origin);
wsUrl.protocol = 'wss:';
async function rejectedSocket(origin: string, credentials: string) {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Origin: origin, Cookie: credentials },
      handshakeTimeout: 8000,
    });
    sockets.push(ws);
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode!);
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.close();
      reject(Error('Unauthorized WebSocket accepted'));
    });
  });
}
async function snapshot() {
  return new Promise<{ ws: WebSocket; revision: number; id: string }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: headers(), handshakeTimeout: 8000 });
    sockets.push(ws);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(Error('Snapshot timed out'));
    }, 12000);
    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'thread' && event.thread.synchronized) {
        clearTimeout(timeout);
        resolve({ ws, revision: event.thread.revision, id: event.thread.id });
      }
    });
  });
}
try {
  const start = Date.now();
  const root = await api('/');
  assert.equal(root.status, 200);
  const html = await root.text();
  report.timingsMs.html = Date.now() - start;
  report.checks.httpsRoot = true;
  assert.equal((await api('/api/session')).status, 401);
  report.checks.unpairedHttpRejected = true;
  assert.equal(await rejectedSocket(config.origin, ''), 401);
  report.checks.unpairedWebSocketRejected = true;
  const pairing = store.mintPairing();
  const paired = await api('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code: pairing.code, name: `临时云链路检查-${randomUUID()}` }),
  });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie')!;
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Strict/i);
  cookie = setCookie.split(';')[0];
  deviceId = (await paired.json()).deviceId;
  report.checks.securePairingCookie = true;
  assert.equal(
    (await api('/api/pair', { method: 'POST', body: JSON.stringify({ code: pairing.code, name: 'replay' }) }))
      .status,
    401,
  );
  report.checks.pairingSingleUse = true;
  assert.equal(
    (
      await api('/api/logout', {
        method: 'POST',
        headers: { ...headers(), Origin: 'https://invalid.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(await rejectedSocket('https://invalid.example', cookie), 403);
  report.checks.wrongOriginHttpAndWebSocketRejected = true;
  const session = await (await api('/api/session')).json();
  assert.equal(session.status.connected, true);
  assert.equal(session.status.writesEnabled, true);
  report.checks.desktopConnectedAndCompatible = true;
  const projects = await (await api('/api/projects')).json();
  assert.ok(Array.isArray(projects.projects));
  assert.equal(
    projects.projects.reduce((sum: number, p: any) => sum + p.count, projects.ungrouped),
    projects.total,
  );
  const project = projects.projects.find((p: any) => p.count > 0);
  if (project) {
    const filtered = await (await api(`/api/threads?project=${encodeURIComponent(project.id)}`)).json();
    assert.ok(filtered.threads.length > 0);
    assert.ok(filtered.threads.every((t: any) => t.projectId === project.id));
  }
  report.checks.projectCatalogAndFilter = true;
  const models = await (await api('/api/models')).json();
  assert.ok(models.models.length > 0);
  assert.ok(models.models.every((m: any) => m.speeds.some((s: any) => s.id === 'default')));
  report.checks.modelSpeedCatalog = true;
  const skills = await (await api(`/api/threads/${threadId}/skills`)).json();
  assert.ok(Array.isArray(skills.skills));
  assert.ok(
    skills.skills.every(
      (s: any) => /^[a-f0-9]{64}$/.test(s.id) && typeof s.name === 'string' && !('path' in s),
    ),
  );
  report.checks.skillCatalogWithoutPaths = true;
  const initial = await snapshot();
  assert.equal(initial.id, threadId);
  report.checks.publicWssSnapshot = true;
  const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(scriptPath);
  const asset = await api(scriptPath, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-encoding'), 'gzip');
  assert.match(asset.headers.get('cache-control')!, /immutable/);
  await asset.arrayBuffer();
  report.checks.hashedAssetsCompressedAndImmutable = true;
  if (process.argv.includes('--restart-tunnel')) {
    const closed = once(initial.ws, 'close', { signal: AbortSignal.timeout(10000) });
    const started = Date.now();
    const runtime = `/run/user/${process.getuid!()}`;
    execFileSync('systemctl', ['--user', 'kill', '--signal=SIGKILL', 'codex-pocket-tunnel.service'], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
    });
    await closed;
    report.checks.brokenTunnelClosesWss = true;
    let restored = false;
    while (Date.now() - started < 20000) {
      try {
        restored = (await api('/api/session')).status === 200;
      } catch {}
      if (restored) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(restored, 'Tunnel did not automatically restart');
    const fresh = await snapshot();
    assert.equal(fresh.id, threadId);
    report.timingsMs.automaticTunnelRecovery = Date.now() - started;
    report.checks.automaticTunnelRecoveryWithFreshSnapshot = true;
  }
  const active = sockets.filter((ws) => ws.readyState === WebSocket.OPEN);
  const closed = Promise.all(active.map((ws) => once(ws, 'close', { signal: AbortSignal.timeout(18000) })));
  store.revoke(deviceId!);
  assert.equal((await api('/api/session')).status, 401);
  await closed;
  report.checks.revocationRejectsHttpAndClosesWss = true;
} finally {
  for (const ws of sockets) ws.terminate();
  if (deviceId) store.revoke(deviceId);
  store.close();
  await mkdir('.test-output', { recursive: true, mode: 0o700 });
  await writeFile('.test-output/cloud-entry-results.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
