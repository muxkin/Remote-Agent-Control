import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { privateOutput } from '../scripts/private-output.js';

it('keeps generated configuration and its child ignore file outside Git without root rules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-release-'));
  try {
    execFileSync('git', ['init', '-q', directory]);
    await privateOutput(join(directory, 'generated'));
    writeFileSync(join(directory, 'generated', 'runtime.env'), 'TEST_KEY=fixture-only\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    expect(execFileSync('git', ['ls-files'], { cwd: directory }).toString()).toBe('');
    expect(readFileSync(join(directory, 'generated/.gitignore'), 'utf8')).toBe('*\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects forced staging of private configuration, state and diagnostics without printing contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-public-'));
  try {
    execFileSync('git', ['init', '-q', directory]);
    const paths = [
      '.env.production',
      '.npmrc',
      '.aws/credentials',
      'cloud.env',
      '.implementation/state.json',
      'relay-state/identity.json',
      'local/config.json',
      '.deploy/service',
      '.test-output/trace.json',
      'docs/design/phone.png',
      'identity.key',
      'identity.p12',
      'state.sqlite-wal',
      'state.db-shm',
    ];
    for (const path of paths) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), 'fixture-sensitive-content');
    }
    execFileSync('git', ['add', '-f', '.'], { cwd: directory });
    const result = spawnSync(process.execPath, [resolve('scripts/check-public.mjs')], {
      cwd: directory,
      env: { ...process.env, POCKET_ENV_FILE: '/dev/null' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    for (const path of paths) expect(result.stderr).toContain(`${path}: private or generated path`);
    expect(result.stderr + result.stdout).not.toContain('fixture-sensitive-content');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('scans staged bytes even when the worktree was cleaned and allows the public environment example', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-public-'));
  try {
    execFileSync('git', ['init', '-q', directory]);
    const secret = 'github_' + 'pat_' + 'x'.repeat(50);
    writeFileSync(join(directory, 'settings.txt'), secret);
    writeFileSync(join(directory, '.env.example'), 'POCKET_PUBLIC_ORIGIN=https://codex.example.com\n');
    execFileSync('git', ['add', '.'], { cwd: directory });
    writeFileSync(join(directory, 'settings.txt'), 'removed from worktree only');
    const run = () =>
      spawnSync(process.execPath, [resolve('scripts/check-public.mjs')], {
        cwd: directory,
        env: { ...process.env, POCKET_ENV_FILE: '/dev/null' },
        encoding: 'utf8',
      });
    const rejected = run();
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('settings.txt: credential pattern');
    expect(rejected.stderr + rejected.stdout).not.toContain(secret);
    expect(rejected.stderr).not.toContain('.env.example');
    execFileSync('git', ['add', '.'], { cwd: directory });
    expect(run().status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('renders a configurable relay runtime without tying it to the deployment root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-deploy-'));
  try {
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/render-deploy.ts',
        '--domain',
        'codex.example.com',
        '--out',
        directory,
        '--relay-root',
        '/srv/pocket/current',
        '--relay-node',
        '/usr/local/bin/node',
      ],
      { env: { ...process.env, POCKET_ENV_FILE: '/dev/null' } },
    );
    const unit = readFileSync(join(directory, 'codex-pocket-relay.service'), 'utf8');
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/srv/pocket/current/dist/server/relay-main.js"');
    expect(unit).not.toContain('/opt/codex-pocket/node');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('loads only the selected environment file and respects process overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-config-'));
  try {
    const file = join(directory, 'runtime.env');
    writeFileSync(file, 'POCKET_PORT=4900\nPOCKET_TEST_CONFIG=fixture-value\n');
    const result = execFileSync(
      process.execPath,
      [
        '--import',
        resolve('scripts/env.mjs'),
        '-e',
        'console.log(JSON.stringify([process.env.POCKET_PORT,process.env.POCKET_TEST_CONFIG]))',
      ],
      { cwd: directory, env: { ...process.env, POCKET_ENV_FILE: file, POCKET_PORT: '4901' } },
    );
    expect(JSON.parse(result.toString())).toEqual(['4901', 'fixture-value']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
