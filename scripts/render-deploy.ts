import { privateOutput } from './private-output.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
const { values } = parseArgs({
  options: {
    domain: { type: 'string' },
    out: { type: 'string', default: '.deploy/v2' },
    'relay-port': { type: 'string', default: '4318' },
    'env-file': { type: 'string', default: 'local/gateway.env' },
    'relay-root': { type: 'string', default: '/opt/codex-pocket' },
    'relay-node': { type: 'string', default: '/usr/bin/node' },
  },
});
const domain = z
  .string()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/)
  .parse(values.domain);
const port = z.coerce.number().int().min(1024).max(65535).parse(values['relay-port']);
const relayNode = z
  .string()
  .regex(/^\/[^\r\n\0]+$/)
  .parse(values['relay-node']);
const out = resolve(values.out!);
await privateOutput(out);
const quote = (v: string) =>
  '"' + v.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const unitPath = (value: string) =>
  value.replaceAll('%', '%%').replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20');
const files = {
  Caddyfile: `${domain} {\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:${port}\n}\n`,
  'codex-pocket-remote.service': `[Unit]
Description=Codex Pocket local device gateway (outbound WSS, WebRTC)
After=network-online.target
[Service]
WorkingDirectory=${unitPath(process.cwd())}
EnvironmentFile=${unitPath(resolve(values['env-file']!))}
ExecStart=${quote(process.execPath)} ${quote(resolve('dist/server/main.js'))}
Restart=on-failure
RestartSec=3
UMask=0077
[Install]
WantedBy=default.target
`,
  'codex-pocket-relay.service': `[Unit]
Description=Codex Pocket ciphertext relay and static PWA
After=network-online.target
[Service]
DynamicUser=yes
WorkingDirectory=${unitPath(values['relay-root']!)}
StateDirectory=codex-pocket-relay
EnvironmentFile=/etc/codex-pocket-relay.env
Environment=POCKET_RELAY_STATE=/var/lib/codex-pocket-relay
ExecStart=${quote(relayNode)} ${quote(resolve(values['relay-root']!, 'dist/server/relay-main.js'))}
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
UMask=0077
[Install]
WantedBy=multi-user.target
`,
  'relay.env.example': `POCKET_PUBLIC_ORIGIN=https://${domain}\nPOCKET_RELAY_PORT=${port}\nPOCKET_RELAY_ENROLLMENT=REPLACE_WITH_RANDOM_32_BYTES\nPOCKET_WEB_ROOT=${values['relay-root']}/dist/web\n# POCKET_ASSET_BASE=https://static.example.com/pocket/v1/\n# POCKET_UPLOAD_ORIGINS=https://upload.example.com,https://objects.example.com\n`,
};
for (const [name, data] of Object.entries(files)) await writeFile(resolve(out, name), data, { mode: 0o600 });
console.log(`Rendered ${Object.keys(files).length} v2 deployment files; no SSH business tunnel.`);
