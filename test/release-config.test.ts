import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
