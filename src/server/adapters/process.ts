import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execaNode } from 'execa';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { hostEnvironment } from './package.js';

export function hostLaunch() {
  const development = import.meta.url.endsWith('.ts');
  const path = development
    ? fileURLToPath(new URL('./host.ts', import.meta.url))
    : ['./adapters/host.js', './host.js']
        .map((p) => fileURLToPath(new URL(p, import.meta.url)))
        .find(existsSync);
  if (!path) throw Error('Adapter host entry not found');
  return { path, nodeOptions: development ? ['--import', import.meta.resolve('tsx')] : [] };
}

/** Execa owns process termination; JSON-RPC owns framing and request correlation.
 * The separate Node IPC channel is reserved for Execa's cross-platform cancellation.
 */
export function startHostProcess(root: string, cwd?: string, check = false) {
  const launch = hostLaunch(),
    cancellation = new AbortController();
  const child = execaNode(launch.path, [root, ...(check ? ['--check'] : [])], {
    nodeOptions: launch.nodeOptions,
    env: hostEnvironment(),
    extendEnv: false,
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    cancelSignal: cancellation.signal,
    gracefulCancel: true,
    forceKillAfterDelay: 2000,
    windowsHide: true,
  });
  // Always observe completion, including errors before the child emits spawn.
  const finished = child.then(
    () => undefined,
    () => undefined,
  );
  // Adapter diagnostics cannot share stdout with the framed RPC stream.
  child.stderr.resume();
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  void finished.then(() => connection.dispose());
  return {
    child,
    connection,
    finished,
    async close() {
      connection.dispose();
      cancellation.abort();
      await finished;
    },
  };
}
export type HostProcess = ReturnType<typeof startHostProcess>;
