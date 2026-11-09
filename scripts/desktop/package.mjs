import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { updateURL, httpsOrigin, resolveUpdateFeed } = require('../../desktop/settings.cjs');
const preview = process.argv.includes('--preview');
const updateBaseURL = process.env.POCKET_DESKTOP_UPDATE_BASE_URL
  ? updateURL(process.env.POCKET_DESKTOP_UPDATE_BASE_URL)
  : '';
if (process.env.POCKET_DESKTOP_UPDATE_URL)
  throw Error(
    'Use POCKET_DESKTOP_UPDATE_BASE_URL (without platform/arch), or omit it to follow the service address',
  );
const origin = process.env.POCKET_DESKTOP_ORIGIN ? httpsOrigin(process.env.POCKET_DESKTOP_ORIGIN) : '';
const update = preview ? '' : resolveUpdateFeed({ origin, updateBaseURL });
if (!preview && !update)
  throw Error('Set POCKET_DESKTOP_ORIGIN or POCKET_DESKTOP_UPDATE_BASE_URL for release metadata');
// Production macOS/Windows updates require a real signing identity.
if (
  !preview &&
  ['darwin', 'win32'].includes(process.platform) &&
  !process.env.CSC_LINK &&
  !process.env.WIN_CSC_LINK &&
  !process.env.CSC_NAME
)
  throw Error(
    'Configure platform code signing before producing a public installer. Use --preview only for local QA.',
  );
const file = 'desktop/release.json',
  previous = await readFile(file, 'utf8');
try {
  await writeFile(file, JSON.stringify({ origin, updateBaseURL, updatesEnabled: !preview }));
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/electron-builder/out/cli/cli.js',
      '--config',
      'builder.cjs',
      '--publish',
      'never',
      ...(process.argv.includes('--dir') ? ['--dir'] : []),
    ],
    {
      cwd: 'desktop',
      stdio: 'inherit',
      env: { ...process.env, POCKET_DESKTOP_PREVIEW: preview ? '1' : '0', POCKET_DESKTOP_BUILD_FEED: update },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await writeFile(file, previous);
}
