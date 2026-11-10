import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { macSignApp, macSignDmg, windowsSign } from './native-signing.mjs';

const appId = 'org.agent-space.adapter';
const appName = 'Agent Space Adapter';
const icon = resolve('src/web/public/app-icon-512.png');
const program = 'agent-space-native';

export async function buildInstaller(platform, source, version, output, signed = false) {
  const stage = await mkdtemp(join(tmpdir(), 'agent-space-native-installer-'));
  try {
    if (platform === 'linux') {
      await buildDeb(stage, source, version, output);
    } else if (platform === 'win32') {
      const installed = join(
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        'NSIS',
        'makensis.exe',
      );
      const compiler = process.platform === 'win32' && existsSync(installed) ? installed : 'makensis';
      const define = process.platform === 'win32' ? '/D' : '-D';
      run(compiler, [
        `${define}PACKAGE_DIR=${source}`,
        `${define}OUTPUT_FILE=${output}`,
        `${define}VERSION=${version}`,
        `${define}APP_ICON=${resolve('assets/branding/agent-space.ico')}`,
        resolve('desktop/native/installer.nsi'),
      ]);
      if (signed) windowsSign(output);
    } else {
      await buildDmg(stage, source, version, output, signed);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function buildDeb(stage, source, version, output) {
  const locations = {
    DEBIAN: [],
    'usr/bin': [program],
    'usr/share/doc/agent-space-native': ['README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'],
  };
  for (const [directory, files] of Object.entries(locations)) {
    await mkdir(join(stage, directory), { recursive: true });
    for (const file of files) await cp(join(source, file), join(stage, directory, file));
  }
  await writeFile(
    join(stage, 'DEBIAN/control'),
    `Package: agent-space-native
Version: ${version}
Architecture: amd64
Maintainer: Agent Space contributors
Section: utils
Priority: optional
Depends: libc6 (>= 2.39), libgcc-s1, libxcb1, libxkbcommon0, libxkbcommon-x11-0, libfontconfig1
Recommends: libvulkan1, mesa-vulkan-drivers, pkexec
Description: Agent Space native desktop adapter
 Connects local Codex sessions to the Agent Space workbench.
`,
  );
  const icons = 'usr/share/icons/hicolor/512x512/apps';
  await mkdir(join(stage, icons), { recursive: true });
  await cp(icon, join(stage, icons, appId + '.png'));
  const applications = join(stage, 'usr/share/applications');
  await mkdir(applications, { recursive: true });
  await writeFile(
    join(applications, appId + '.desktop'),
    `[Desktop Entry]
Type=Application
Name=${appName}
Name[zh_CN]=Agent 空间适配器
Exec=/usr/bin/${program}
Icon=${appId}
StartupWMClass=${appId}
Terminal=false
Categories=Utility;
`,
  );
  run('dpkg-deb', ['--root-owner-group', '--build', stage, output]);
}

async function buildDmg(stage, source, version, output, signed) {
  const volume = join(stage, 'volume');
  const app = join(volume, appName + '.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(resources);
  await cp(join(source, program), join(contents, 'MacOS', program));
  for (const file of ['README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'])
    await cp(join(source, file), join(resources, file));
  const iconset = join(stage, 'AgentSpace.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      run('sips', [
        '-z',
        pixels,
        pixels,
        icon,
        '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      ]);
    }
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(resources, 'AgentSpace.icns')]);
  await writeFile(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${appId}</string>
  <key>CFBundleName</key><string>${appName}</string>
  <key>CFBundleExecutable</key><string>${program}</string>
  <key>CFBundleIconFile</key><string>AgentSpace.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
  );
  run('plutil', ['-lint', join(contents, 'Info.plist')]);
  if (signed) await macSignApp(app, stage);
  else run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
  await symlink('/Applications', join(volume, 'Applications'));
  run('hdiutil', ['create', '-volname', appName, '-srcfolder', volume, '-format', 'UDZO', output]);
  if (signed) macSignDmg(output);
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}
