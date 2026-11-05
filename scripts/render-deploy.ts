import { privateOutput } from './private-output.js';
/** Generates reviewable configuration only; never connects to or changes a server. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readConfig } from '../src/server/config.js';

const { values } = parseArgs({
  options: {
    domain: { type: 'string' },
    'ssh-host': { type: 'string' },
    'tunnel-user': { type: 'string', default: 'pocket-tunnel' },
    'remote-port': { type: 'string', default: '14317' },
    'stun-port': { type: 'string', default: '3479' },
    out: { type: 'string', default: '.deploy' },
    'env-file': { type: 'string' },
  },
});
const domain = z
  .string()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/)
  .parse(values.domain);
const target = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .parse(values['ssh-host']);
const user = z
  .string()
  .regex(/^[a-z_][a-z0-9_-]{0,31}$/)
  .parse(values['tunnel-user']);
const remotePort = z.coerce.number().int().min(1024).max(65535).parse(values['remote-port']);
const stunPort = z.coerce.number().int().min(1024).max(65535).parse(values['stun-port']);
const config = readConfig();
const output = resolve(values.out!);
const project = process.cwd();
// systemd expands '%' independently of shell quoting.
const quote = (value: string) =>
  '"' + value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const unitPath = (value: string) =>
  value.replaceAll('%', '%%').replaceAll('\\', '\\x5c').replaceAll(' ', '\\x20');
await privateOutput(output);
const files: Record<string, string> = {
  'codex-pocket-stun.conf': `# Standard STUN only: no TURN allocations or media relay.
listening-port=${stunPort}
listening-ip=0.0.0.0
stun-only
no-auth
no-tcp
no-tls
no-dtls
no-cli
no-tcp-relay
no-multicast-peers
relay-threads=0
log-file=stdout
pidfile=/run/codex-pocket-stun/turnserver.pid
userdb=/run/codex-pocket-stun/turndb
`,
  'codex-pocket-stun.service': `[Unit]
Description=Codex Pocket standard STUN (no TURN relay)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
RuntimeDirectory=codex-pocket-stun
ExecStart=/usr/bin/turnserver -c /etc/codex-pocket-stun.conf
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
`,
  Caddyfile: `${domain} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:${remotePort} {
        header_up Host {hostport}
        stream_close_delay 5m
    }
}
`,
  'sshd-pocket.conf': `# Merge into the cloud server's sshd config; validate before reload.
# This account is exclusively for the reverse tunnel, with a dedicated public key.
Match User ${user}
    AuthenticationMethods publickey
    PasswordAuthentication no
    AllowTcpForwarding remote
    AllowStreamLocalForwarding no
    PermitListen 127.0.0.1:${remotePort}
    GatewayPorts no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    MaxSessions 0
Match all
`,
  'codex-pocket-remote.service': `[Unit]
Description=Codex Pocket Remote local desktop gateway

[Service]
Type=simple
WorkingDirectory=${unitPath(project)}
EnvironmentFile=${unitPath(resolve(values['env-file'] ?? process.env.POCKET_ENV_FILE ?? 'local/gateway.env'))}
ExecStart=${quote(process.execPath)} ${quote(resolve(project, 'dist/server/main.js'))}
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
`,
  'codex-pocket-tunnel.service': `[Unit]
Description=Codex Pocket Remote SSH reverse tunnel
Wants=codex-pocket-remote.service
After=codex-pocket-remote.service

[Service]
Type=simple
ExecStart=/usr/bin/ssh -NT -l ${user} -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none -R 127.0.0.1:${remotePort}:127.0.0.1:${config.port} ${target}
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
`,
  'gateway.env.example': `POCKET_PORT=${config.port}\nPOCKET_PUBLIC_ORIGIN=https://${domain}\n# After deploying the STUN service and allowing its UDP port:\n# POCKET_STUN_URLS=stun:${domain}:${stunPort}\n# Optional; set before build as well as startup:\n# POCKET_ASSET_BASE=https://static.example.com/pocket/v1/\n`,
};
for (const [name, contents] of Object.entries(files))
  await writeFile(resolve(output, name), contents, { mode: 0o600 });
console.log(
  `Rendered ${Object.keys(files).length} files in ${output}. Nothing deployed; no credentials generated or uploaded.`,
);
