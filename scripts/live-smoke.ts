/** Opt-in, mutating acceptance test. Use ONLY a dedicated Desktop-owned test chat. */
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import WebSocket from 'ws';
import { readConfig } from '../src/server/config.js';
import { Store } from '../src/server/store.js';
import type { ThreadView, Operation, ServerEvent } from '../src/shared/types.js';
import { applyViewDelta } from '../src/shared/delta.js';

const threadId = process.argv[2];
if (!threadId || !process.argv.includes('--allow-control'))
  throw new Error('Usage: live-smoke.ts <DEDICATED_TEST_THREAD_ID> --allow-control [--public]');
const config = readConfig();
const publicEntry = process.argv.includes('--public');
const base = publicEntry ? config.origin : `http://127.0.0.1:${config.port}`;
const eventUrl = new URL(`/api/events?threadId=${threadId}`, base);
eventUrl.protocol = eventUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const store = new Store(config.stateDir);
const pairing = store.mintPairing();
store.close();
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: config.origin,
  Host: new URL(config.origin).host,
};
async function request(path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${data.error}`);
  return { data, res };
}
const paired = await request('/pair', { code: pairing.code, name: '临时验收客户端' });
headers.Cookie = paired.res.headers.get('set-cookie')!.split(';')[0];
let view: ThreadView | null = null;
let socket: WebSocket | undefined;
const operations = new Map<string, Operation>();
let events = 0;
const traffic = { snapshotBytes: 0, deltaBytes: 0, equivalentFullStateBytes: 0, deltaFrames: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, label: string, timeout = 90000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timeout: ${label}`);
    await sleep(100);
  }
  return Date.now() - start;
}
async function connect() {
  view = null;
  socket = new WebSocket(eventUrl, { headers });
  socket.on('message', (raw) => {
    const e = JSON.parse(raw.toString()) as ServerEvent;
    events++;
    if (e.type === 'thread') {
      view = e.thread;
      traffic.snapshotBytes += Buffer.byteLength(raw.toString());
    }
    if (e.type === 'threadDelta') {
      view = applyViewDelta(view, e.delta);
      traffic.deltaBytes += Buffer.byteLength(raw.toString());
      traffic.deltaFrames++;
      traffic.equivalentFullStateBytes += Buffer.byteLength(JSON.stringify({ type: 'thread', thread: view }));
    }
    if (e.type === 'operation') operations.set(e.operation.id, e.operation);
  });
  socket.on('error', () => {});
  await until(() => !!view?.synchronized, 'snapshot', 10000);
}
async function serverPids() {
  const ids: string[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8');
      if (/(?:^|\u0000)app-server\u0000/.test(cmd) && !cmd.includes('\u0000proxy\u0000')) ids.push(pid);
    } catch {}
  }
  return ids.sort();
}
const report: any = { date: new Date().toISOString(), entry: base, threadId, checks: {}, timingsMs: {} };
try {
  report.appServerPidsBefore = await serverPids();
  const connectedAt = Date.now();
  await connect();
  report.timingsMs.initialSnapshot = Date.now() - connectedAt;
  const initialModel = view!.model;
  if (!view!.canSend) throw new Error(`Dedicated chat is not idle: ${view!.reason}`);
  const id = randomUUID();
  const marker = `POCKET_POC_SEND_${id.slice(0, 8)}`;
  const body = { requestId: id, text: `请只回复 ${marker}，不要调用工具或修改文件。` };
  const start = Date.now();
  await request(`/threads/${threadId}/messages`, body);
  console.log('Text send submitted; awaiting Desktop acceptance.');
  await until(
    () =>
      ['accepted', 'completed', 'failed', 'rejected', 'uncertain'].includes(operations.get(id)?.state ?? ''),
    'send acceptance',
  );
  report.timingsMs.sendAccepted = Date.now() - start;
  console.log('Send state:', operations.get(id)?.state);
  if (['rejected', 'uncertain', 'failed'].includes(operations.get(id)?.state ?? ''))
    throw new Error(operations.get(id)?.error ?? 'send failed');
  await until(
    () =>
      operations.get(id)?.state === 'completed' &&
      !!view?.messages.some((m) => m.role === 'assistant' && m.text.includes(marker)),
    'reply completion',
  );
  report.timingsMs.sendCompleted = Date.now() - start;
  report.checks.nativeSend = true;
  const replay = await request(`/threads/${threadId}/messages`, body);
  await sleep(500);
  report.checks.sameRequestReturnsSameOperation = replay.data.id === id;
  report.checks.singleAssistantReply =
    view!.messages.filter((m) => m.role === 'assistant' && m.text.includes(marker)).length === 1;
  const waitingId = randomUUID();
  await request(`/threads/${threadId}/messages`, {
    requestId: waitingId,
    text: '这是中断验收。请执行一次不会写文件的 shell 命令 sleep 25，完成后回复 POCKET_POC_WAIT_FINISHED；不要执行其他命令或修改文件。',
  });
  await until(() => !!view?.activeTurnId, 'active interrupt target');
  const activeTurnId = view!.activeTurnId!;
  socket!.close();
  await sleep(1500);
  await connect();
  report.checks.phoneDisconnectKeepsTask = view!.activeTurnId === activeTurnId;
  const stopId = randomUUID();
  const stopAt = Date.now();
  await request(`/threads/${threadId}/interrupt`, { requestId: stopId, expectedTurnId: activeTurnId });
  await until(
    () => operations.get(stopId)?.state === 'interrupted' && !view?.activeTurnId,
    'targeted interruption',
    30000,
  );
  report.timingsMs.interruptConfirmed = Date.now() - stopAt;
  report.checks.interruptedExpectedTurn = operations.get(stopId)?.turnId === activeTurnId;
  report.checks.modelPreserved = view!.model === initialModel;
  report.appServerPidsAfter = await serverPids();
  report.checks.noAdditionalAppServer =
    JSON.stringify(report.appServerPidsBefore) === JSON.stringify(report.appServerPidsAfter);
  report.eventCount = events;
  report.traffic = {
    ...traffic,
    measurement: 'JSON payload bytes before WebSocket compression; excludes HTTP assets and framing',
  };
  report.passed = Object.values(report.checks).every(Boolean);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = (error as Error).message;
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket?.close();
  await request('/logout', {}).catch(() => {});
  await writeFile(
    publicEntry ? '/tmp/pocket-remote-cloud-smoke.json' : '/tmp/pocket-remote-live-smoke.json',
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
