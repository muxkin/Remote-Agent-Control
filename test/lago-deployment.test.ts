import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
// The optional Lago stack targets POSIX hosts; permission checks do not apply to Windows.
const deploymentTest = it.skipIf(process.platform === 'win32');
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'pocket-lago-test-'));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

deploymentTest(
  'generates private Lago credentials for explicit origins and refuses to overwrite them',
  async () => {
    const path = await directory();
    const args = [
      resolve('deploy/lago/init-env.py'),
      '--directory',
      path,
      '--admin-email',
      'admin@example.com',
      '--api-url',
      'https://billing-api.example.com/',
      '--front-url',
      'https://billing.example.com',
    ];
    const { stdout, stderr } = await run('python3', args);
    const credentials = JSON.parse(await readFile(join(path, 'admin-credentials.json'), 'utf8'));
    const env = await readFile(join(path, '.env'), 'utf8');
    expect(env).toContain('LAGO_API_URL=https://billing-api.example.com\n');
    expect(env).toContain('LAGO_FRONT_URL=https://billing.example.com\n');
    expect(credentials.url).toBe('https://billing.example.com');
    expect(stdout + stderr).not.toContain(credentials.password);
    expect((await stat(join(path, '.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, 'admin-credentials.json'))).mode & 0o777).toBe(0o600);
    await expect(run('python3', args)).rejects.toThrow('refusing to replace');
    expect(await readFile(join(path, '.env'), 'utf8')).toBe(env);
    await expect(run('python3', [...args, '--api-url', 'https://example.com/path'])).rejects.toThrow(
      'Use an HTTPS origin',
    );
  },
);

deploymentTest(
  'bootstraps Lago features and plans on a fresh install without overwriting later entitlements',
  async () => {
    const path = await directory();
    await writeFile(join(path, '.env'), 'LAGO_ORG_API_KEY=fixture-only-key\n');
    for (const file of ['features.json', 'resource-plans.json'])
      await copyFile(join('deploy/lago', file), join(path, file));
    const features = new Set<string>();
    const plans = new Map<string, Record<string, unknown> | null>();
    let mutations = 0;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const [, , , resource, code, child] = req.url!.split('/');
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== 'Bearer fixture-only-key') return reply(401, {});
      if (req.method === 'GET') {
        if (resource === 'features') return reply(features.has(code) ? 200 : 404, { feature: { code } });
        if (!plans.has(code)) return reply(404, {});
        return reply(
          200,
          child === 'entitlements'
            ? { entitlements: plans.get(code) ? [plans.get(code)] : [] }
            : { plan: { code } },
        );
      }
      if (req.method !== 'POST') return reply(405, {});
      mutations++;
      if (resource === 'features') features.add(body.feature.code);
      else if (!code) plans.set(body.plan.code, null);
      else if (child === 'entitlements') {
        // A fresh Lago installation rejects entitlements for features that do not exist.
        if (Object.keys(body.entitlements).some((feature) => !features.has(feature))) return reply(422, {});
        plans.set(code, body.entitlements);
      }
      reply(201, {});
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address() as { port: number };
    const args = [
      resolve('deploy/lago/configure-resources.py'),
      '--directory',
      path,
      '--base-url',
      `http://127.0.0.1:${address.port}`,
    ];
    try {
      await run('python3', args);
      expect(features.has('storage')).toBe(true);
      expect(features.has('relay')).toBe(true);
      expect(plans.size).toBe(3);
      expect(plans.get('pocket-ordinary')).toMatchObject({ storage: { max_bytes: 100000000 } });
      const custom = { storage: { max_bytes: 12345 }, relay: { max_bytes: 67890 } };
      plans.set('pocket-ordinary', custom);
      const before = mutations;
      await run('python3', args);
      expect(mutations).toBe(before);
      expect(plans.get('pocket-ordinary')).toEqual(custom);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
