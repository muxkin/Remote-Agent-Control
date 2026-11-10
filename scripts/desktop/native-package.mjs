import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';
import { buildInstaller, refreshPluginHashes } from './native-installer.mjs';
import { nativeNotices } from './native-notices.mjs';
import { windowsSign } from './native-signing.mjs';

const args = process.argv.slice(2);
const installer = args.includes('--installer');
const signed = args.includes('--signed');
assert(!process.env.POCKET_NATIVE_GATEWAY_PAYLOAD, 'The Rust adapter cannot bundle a gateway runtime');
const positional = args.filter((arg) => !['--installer', '--signed'].includes(arg));
const [platform, binary, triple, pluginDirectory] = positional;
const targets = {
  win32: ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnullvm', 'x86_64-pc-windows-gnu'],
  linux: ['x86_64-unknown-linux-gnu'],
  darwin: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
};
assert(
  Object.hasOwn(targets, platform) && binary && triple && pluginDirectory && positional.length === 4 &&
    (platform !== 'darwin' || installer),
  'Usage: native-package.mjs <linux|win32|darwin> <binary> <rust-target> <official-plugin-directory> [--installer] [--signed]',
);
if (signed)
  assert(installer && process.platform === platform, 'Sign native installers on the target platform');
const native = resolve('desktop/native');
const name = platform === 'win32' ? 'agent-space-native.exe' : 'agent-space-native';
const target = triple;
assert(targets[platform].includes(target), 'Rust target does not match the package platform');
const arch = target.startsWith('aarch64-') ? 'arm64' : 'x64';
const cargo = await readFile(join(native, 'Cargo.toml'), 'utf8');
const version = cargo.match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1];
assert(version, 'Cannot read native desktop version');
const executable = await readFile(binary);
checkBinary(binary, executable);

const output = resolve(process.env.POCKET_NATIVE_PACKAGE_OUT ?? 'dist/desktop-native-preview');
const platformName = { win32: 'windows', linux: 'linux', darwin: 'macos' }[platform];
const folder = `AgentSpace-Native-${version}-${platformName}-${arch}`;
const stage = await mkdtemp(join(tmpdir(), 'agent-space-native-package-'));
try {
  const dir = join(stage, folder);
  await mkdir(dir);
  await mkdir(output, { recursive: true });
  await writeFile(join(dir, name), executable);
  if (platform !== 'win32') await chmod(join(dir, name), 0o755);
  const bundled = join(dir, 'official-plugins');
  for (const product of ['codex', 'dsh']) {
    const source = join(pluginDirectory, product);
    const entry = 'agent-space-adapter-' + product + (platform === 'win32' ? '.exe' : '');
    const manifest = JSON.parse(await readFile(join(source, 'adapter.json'), 'utf8'));
    assert.equal(manifest.sdk, 1);
    assert.equal(manifest.name, '@agent-remote/adapter-' + product);
    assert.equal(manifest.product, product);
    assert.equal(manifest.version, version);
    assert.equal(manifest.entry, entry);
    const binary = join(source, entry);
    const bytes = await readFile(binary);
    checkBinary(binary, bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
    const destination = join(bundled, product);
    await mkdir(destination, { recursive: true });
    for (const file of ['adapter.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'])
      await copyFile(join(source, file), join(destination, file));
    await writeFile(join(destination, entry), bytes);
    if (platform !== 'win32') await chmod(join(destination, entry), 0o755);
    if (signed && platform === 'win32') windowsSign(join(destination, entry));
  }
  await copyFile('LICENSE', join(dir, 'LICENSE'));
  await writeFile(
    join(dir, 'README.txt'),
    `Agent 空间电脑适配器 ${version} · Rust + Ely 预览

${platform === 'darwin' ? '将 Agent Space Adapter 拖到 Applications 后打开' : `安装后从应用菜单打开，便携包也可直接解包运行 ${name}`}，在设置中填写服务地址。
关闭窗口后保持托盘运行。点击托盘图标可打开界面，菜单可退出适配器。
启动时可用 --configure 重新设置服务地址。
预览使用独立状态目录。打开本机 Codex 会话后，可从手机查看和控制。
${platform === 'linux' ? '需要 glibc 2.39 或更新版本，以及桌面环境的 XCB 和 XKB 运行库。\n' : ''}详见仓库 docs/DESKTOP_ADAPTER.md。
`,
  );
  let thirdParty = await nativeNotices(native, target);
  if (target === 'x86_64-pc-windows-gnullvm') {
    const toolchainNotice = process.env.POCKET_NATIVE_LLVM_MINGW_LICENSE;
    assert(toolchainNotice, 'Set POCKET_NATIVE_LLVM_MINGW_LICENSE to the llvm-mingw LICENSE.TXT');
    thirdParty += `\nllvm-mingw\n\n${await readFile(toolchainNotice, 'utf8')}`;
  }
  await writeFile(join(dir, 'THIRD-PARTY-NOTICES.txt'), thirdParty);
  if (signed && platform === 'win32') {
    windowsSign(join(dir, name));
    await refreshPluginHashes(bundled);
  }
  if (platform !== 'darwin') {
    const path = join(output, `${folder}.${platform === 'win32' ? 'zip' : 'tar.xz'}`);
    if (platform === 'win32') {
      const contents = {};
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = join(entry.parentPath, entry.name);
        contents[`${folder}/${relative(dir, file).split(sep).join('/')}`] = await readFile(file);
      }
      await writeFile(path, zipSync(contents, { level: 9 }));
    } else {
      execFileSync('tar', ['-C', stage, '-cJf', path, folder], { stdio: 'inherit' });
    }
    await checksum(path);
  }
  if (installer) {
    const suffix = { win32: '-setup.exe', linux: '.deb', darwin: '.dmg' }[platform];
    const path = join(output, folder + suffix);
    await rm(path, { force: true });
    await rm(path + '.sha256', { force: true });
    await buildInstaller(platform, dir, version, path, signed);
    await checksum(path);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}

function checkBinary(path, bytes) {
  if (platform === 'darwin') {
    const cpu = execFileSync('lipo', ['-archs', resolve(path)], { encoding: 'utf8' }).trim();
    assert.equal(cpu, arch === 'arm64' ? 'arm64' : 'x86_64', 'Mach-O architecture does not match the target');
  } else if (platform === 'win32') {
    assert(bytes.subarray(0, 2).equals(Buffer.from('MZ')), 'Expected a Windows PE binary');
    const header = bytes.readUInt32LE(0x3c);
    assert(bytes.subarray(header, header + 4).equals(Buffer.from([0x50, 0x45, 0, 0])));
    assert.equal(bytes.readUInt16LE(header + 4), 0x8664, 'Expected a Windows x64 binary');
  } else {
    assert(bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
    assert.equal(bytes.readUInt16LE(18), 62, 'Expected a Linux x64 binary');
  }
  if (platform === 'linux') {
    const symbols = execFileSync('readelf', ['--version-info', resolve(path)], { encoding: 'utf8' });
    const versions = [...symbols.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)];
    assert(
      versions.length > 0 && versions.every(([, major, minor]) => Number(major) === 2 && Number(minor) <= 39),
      'Build the Linux preview with glibc 2.39 or older, as in the Ubuntu 24.04 CI job',
    );
  }
}

async function checksum(path) {
  const data = await readFile(path);
  await writeFile(
    `${path}.sha256`,
    `${createHash('sha256').update(data).digest('hex')}  ${basename(path)}\n`,
  );
  console.log(`${path} · ${(data.length / 2 ** 20).toFixed(2)} MiB`);
}
