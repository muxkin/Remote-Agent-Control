import { execFileSync } from 'node:child_process';
import { open, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

export function windowsSign(file) {
  const certificate = process.env.POCKET_NATIVE_WINDOWS_SIGN_CERT_SHA1;
  const timestamp = new URL(process.env.POCKET_NATIVE_WINDOWS_TIMESTAMP_URL);
  if (
    !/^[a-f0-9]{40}$/i.test(certificate ?? '') ||
    timestamp.protocol !== 'https:' ||
    timestamp.username ||
    timestamp.password ||
    timestamp.hash
  )
    throw Error(
      'Configure an Authenticode certificate in the Windows certificate store and an HTTPS timestamp server',
    );
  const tool = process.env.POCKET_NATIVE_SIGNTOOL ?? 'signtool.exe';
  run(tool, ['sign', '/sha1', certificate, '/fd', 'SHA256', '/tr', timestamp.href, '/td', 'SHA256', file]);
  verifyPlatformSignature('win32', file);
}

export function verifyPlatformSignature(platform, file) {
  if (platform === 'linux') return;
  if (process.platform !== platform) throw Error('Verify the signed package on its native release platform');
  if (platform === 'win32') {
    run(process.env.POCKET_NATIVE_SIGNTOOL ?? 'signtool.exe', ['verify', '/pa', '/all', '/tw', file]);
  } else {
    run('codesign', ['--verify', '--strict', file]);
    run('xcrun', ['stapler', 'validate', file]);
  }
}

export async function macSignApp(app, stage) {
  const identity = process.env.POCKET_NATIVE_MAC_SIGN_IDENTITY;
  if (!identity?.startsWith('Developer ID Application:') || !process.env.POCKET_NATIVE_MAC_NOTARY_PROFILE)
    throw Error('Configure the Developer ID Application identity and notarytool Keychain profile');
  const entitlements = join(stage, 'node-entitlements.plist');
  await writeFile(
    entitlements,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>\n`,
  );
  const magic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
  const sign = (file, extra = []) =>
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, ...extra, file]);
  async function signContents(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await signContents(file);
      else if (entry.isFile()) {
        const handle = await open(file, 'r');
        const bytes = Buffer.alloc(8);
        try {
          await handle.read(bytes, 0, bytes.length, 0);
        } finally {
          await handle.close();
        }
        const format = bytes.readUInt32BE();
        // Java class files share the big-endian FAT magic, but their class version is not an architecture count.
        if (magic.has(format) && (format !== 0xcafebabe || bytes.readUInt32BE(4) <= 32))
          sign(file, file.endsWith('/gateway/runtime/node') ? ['--entitlements', entitlements] : []);
      }
    }
  }
  await signContents(join(app, 'Contents'));
  sign(app);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const archive = join(stage, 'notarization.zip');
  run('ditto', ['-c', '-k', '--keepParent', app, archive]);
  notarize(archive, app);
}

export function macSignDmg(dmg) {
  run('codesign', ['--force', '--timestamp', '--sign', process.env.POCKET_NATIVE_MAC_SIGN_IDENTITY, dmg]);
  notarize(dmg, dmg);
  verifyPlatformSignature('darwin', dmg);
}

function notarize(source, stapled) {
  run('xcrun', [
    'notarytool',
    'submit',
    source,
    '--keychain-profile',
    process.env.POCKET_NATIVE_MAC_NOTARY_PROFILE,
    '--wait',
  ]);
  run('xcrun', ['stapler', 'staple', stapled]);
  run('xcrun', ['stapler', 'validate', stapled]);
}
