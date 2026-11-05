/** Inspect the staged Git tree, never print credential values or private configuration. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const git = (args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const files = git(['ls-files', '--cached', '-z']).toString().split('\0').filter(Boolean);
const privateValues = new Set([homedir()]);
try {
  const config = parseEnv(readFileSync(resolve(process.env.POCKET_ENV_FILE || 'local/gateway.env'), 'utf8'));
  for (const [key, value] of Object.entries(config)) {
    if (
      /(?:ACCESS_KEY|SECRET_KEY|TOKEN|PASSWORD|ORIGIN|ASSET_BASE|STATE_DIR|STUN_URLS|BUCKET|ADAPTER)$/.test(
        key,
      ) &&
      value.length >= (/(?:BUCKET|ADAPTER)$/.test(key) ? 4 : 8) &&
      !/^(?:https?:\/\/)?[^/]*example\.(?:com|org|net)/i.test(value)
    )
      privateValues.add(value);
    if (/STUN_URLS$/.test(key)) {
      for (const address of value.split(',')) {
        const host = address.match(/^stuns?:([^:]+)(?::\d+)?$/)?.[1];
        if (host && !/(^|\.)example\.(com|org|net)$/.test(host)) privateValues.add(host);
      }
    }
    if (/ORIGIN|ASSET_BASE/.test(key)) {
      try {
        const host = new URL(value).hostname;
        if (!/^(?:localhost|127\.0\.0\.1)$/.test(host) && !/(^|\.)example\.(com|org|net)$/.test(host))
          privateValues.add(host);
      } catch {
        /* Optional empty values are not URLs. */
      }
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const forbidden =
  /(^|\/)(?:local|inner|\.deploy|\.test-output|node_modules|dist|coverage|\.env|[^/]+\.pem|id_rsa|id_ed25519|known_hosts|ssh_config)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|log|har|map)$/i;
const findings = [];
for (const file of files) {
  if (forbidden.test(file) || file.startsWith('docs/design/'))
    findings.push([file, 'private or generated path']);
  if (file.endsWith('/.gitignore')) findings.push([file, 'local ignore file must remain local']);
  const bytes = git(['show', `:${file}`]);
  if (/\.(png|webp|jpg|jpeg|ico|woff2?)$/i.test(file)) continue;
  const content = bytes.toString('utf8');
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/.test(
      content,
    )
  )
    findings.push([file, 'credential pattern']);
  for (const match of content.matchAll(
    /https?:\/\/[^\s"'<>]+[?&](?:token|access_token|signature)=[^\s"'<>]+/gi,
  )) {
    if (!/(^|\.)example\.(com|org|net)$/.test(new URL(match[0]).hostname))
      findings.push([file, 'signed or authenticated URL']);
  }
  for (const value of privateValues)
    if (value.length > 1 && content.includes(value)) {
      findings.push([file, 'local configuration value']);
      break;
    }
}
if (findings.length) {
  for (const [file, reason] of findings) console.error(`${file}: ${reason}`);
  process.exitCode = 1;
} else
  console.log(
    `Public tree check passed (${files.length} staged/tracked files). Review images and history separately.`,
  );
