import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { DeliveryError } from '../../../src/server/delivery-error.js';
import type { CodexConfig } from './config.js';

// Older servers may silently ignore lastTurnId. Only use a verified protocol build.
const verifiedVersion = '0.167.0-alpha.3.2';
const clientName = 'pocket_reply_fork';
const threadResult = z.object({ id: z.string().uuid(), forkedFromId: z.string() });

export async function replyForkExecutable(config: CodexConfig): Promise<string | undefined> {
  if (config.readOnly || !isAbsolute(config.desktopRoot)) return;
  const platform = config.platform?.id ?? process.platform;
  const resources = join(
    config.desktopRoot,
    ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']),
  );
  const executable = join(resources, platform === 'win32' ? 'codex.exe' : 'codex');
  if (!existsSync(executable)) return;
  const version = await promisify(execFile)(executable, ['--version'], { timeout: 2000 }).catch(() => null);
  if (version?.stdout.trim() === `codex-cli ${verifiedVersion}`) return executable;
}

export function forkCodexReply(
  executable: string,
  codexHome: string,
  threadId: string,
  lastTurnId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let sent = false;
    let buffer = '';
    const timer = setTimeout(() => failed(), 15000);
    let finished = false;
    function finish(result: string | DeliveryError) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (typeof result === 'string') resolve(result);
      else reject(result);
    }
    function failed() {
      finish(new DeliveryError(sent ? '分支创建结果待确认，请检查会话列表' : '本机分支接口暂不可用', !sent));
    }
    function write(message: object) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }
    child.once('error', failed);
    child.once('close', failed);
    child.stdin.on('error', failed);
    child.stdout.on('error', failed);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (finished) return;
      buffer += chunk;
      if (buffer.length > 256 * 1024) return failed();
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return failed();
        }
        if (message?.id === 1 && !sent) {
          const agent = message.result?.userAgent;
          if (typeof agent !== 'string' || !agent.startsWith(`${clientName}/${verifiedVersion} `))
            return failed();
          write({ method: 'initialized' });
          sent = true;
          write({
            id: 2,
            method: 'thread/fork',
            params: { threadId, lastTurnId, excludeTurns: true, threadSource: 'user' },
          });
        } else if (message?.id === 2 && sent) {
          if (message.error?.code === -32600)
            return finish(new DeliveryError('桌面无法从这一回合创建分支，请重新加载会话', true));
          const fork = threadResult.safeParse(message.result?.thread);
          if (!fork.success || fork.data.id === threadId || fork.data.forkedFromId !== threadId)
            return failed();
          return finish(fork.data.id);
        }
      }
    });
    write({ id: 1, method: 'initialize', params: { clientInfo: { name: clientName, version: '1.0.0' } } });
  });
}
