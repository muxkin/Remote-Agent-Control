import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { buildInstaller, stageGateway } from './native-installer.mjs';

const args = process.argv.slice(2);
const installer = args.includes('--installer');
const [platform, binary, triple] = args.filter((arg) => arg !== '--installer');
const targets = {
  win32: ['x86_64-pc-windows-msvc', 'x86_64-pc-windows-gnullvm', 'x86_64-pc-windows-gnu'],
  linux: ['x86_64-unknown-linux-gnu'],
  darwin: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
};
assert(
  Object.hasOwn(targets, platform) && binary && (platform !== 'darwin' || installer),
  'Usage: native-package.mjs <linux|win32|darwin> <binary> [rust-target] [--installer]',
);
const native = resolve('desktop/native');
const name = platform === 'win32' ? 'agent-space-native.exe' : 'agent-space-native';
const target = triple ?? targets[platform][0];
assert(targets[platform].includes(target), 'Rust target does not match the package platform');
const arch = target.startsWith('aarch64-') ? 'arm64' : 'x64';
const cargo = await readFile(join(native, 'Cargo.toml'), 'utf8');
const version = cargo.match(/^version = "(\d+\.\d+\.\d+)"$/m)?.[1];
assert(version, 'Cannot read native desktop version');
const executable = await readFile(binary);
if (platform === 'darwin') {
  const cpu = execFileSync('lipo', ['-archs', resolve(binary)], { encoding: 'utf8' }).trim();
  assert.equal(cpu, arch === 'arm64' ? 'arm64' : 'x86_64', 'Mach-O architecture does not match the target');
} else if (platform === 'win32') {
  assert(executable.subarray(0, 2).equals(Buffer.from('MZ')), 'Expected a Windows PE binary');
  const header = executable.readUInt32LE(0x3c);
  assert(executable.subarray(header, header + 4).equals(Buffer.from([0x50, 0x45, 0, 0])));
  assert.equal(executable.readUInt16LE(header + 4), 0x8664, 'Expected a Windows x64 binary');
} else {
  assert(executable.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
  assert.equal(executable.readUInt16LE(18), 62, 'Expected a Linux x64 binary');
}
if (platform === 'linux') {
  const symbols = execFileSync('readelf', ['--version-info', resolve(binary)], { encoding: 'utf8' });
  const versions = [...symbols.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)];
  assert(
    versions.length > 0 && versions.every(([, major, minor]) => Number(major) === 2 && Number(minor) <= 39),
    'Build the Linux preview with glibc 2.39 or older, as in the Ubuntu 24.04 CI job',
  );
}

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
  let thirdParty = await notices();
  if (target === 'x86_64-pc-windows-gnullvm') {
    const toolchainNotice = process.env.POCKET_NATIVE_LLVM_MINGW_LICENSE;
    assert(toolchainNotice, 'Set POCKET_NATIVE_LLVM_MINGW_LICENSE to the llvm-mingw LICENSE.TXT');
    thirdParty += `\nllvm-mingw\n\n${await readFile(toolchainNotice, 'utf8')}`;
  }
  await writeFile(join(dir, 'THIRD-PARTY-NOTICES.txt'), thirdParty);
  const hasGateway = await stageGateway(dir);
  if (platform !== 'darwin') {
    const path = join(output, `${folder}.${platform === 'win32' ? 'zip' : 'tar.xz'}`);
    if (platform === 'win32' && hasGateway) {
      if (process.platform === 'win32')
        execFileSync('tar.exe', ['-a', '-cf', path, '-C', stage, folder], { stdio: 'inherit' });
      else execFileSync('zip', ['-qr', path, folder], { cwd: stage, stdio: 'inherit' });
    } else if (platform === 'win32') {
      const contents = {};
      for (const entry of await readdir(dir))
        contents[`${folder}/${entry}`] = await readFile(join(dir, entry));
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
    await buildInstaller(platform, dir, version, path);
    await checksum(path);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}

async function checksum(path) {
  const data = await readFile(path);
  await writeFile(
    `${path}.sha256`,
    `${createHash('sha256').update(data).digest('hex')}  ${basename(path)}\n`,
  );
  console.log(`${path} · ${(data.length / 2 ** 20).toFixed(2)} MiB`);
}

async function notices() {
  const graph = execFileSync(
    'cargo',
    ['tree', '--locked', '--target', target, '--edges', 'normal', '--prefix', 'none', '--format', '{p}'],
    { cwd: native, encoding: 'utf8' },
  );
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry', 'src');
  const registries = (await readdir(registry)).map((entry) => join(registry, entry));
  const packages = new Set(
    [...graph.matchAll(/^([A-Za-z0-9_-]+) v(\S+)/gm)].map(([, name, version]) => `${name}-${version}`),
  );
  const texts = [];
  for (const pkg of [...packages].sort()) {
    for (const root of registries) {
      const dir = join(root, pkg);
      const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      if (!entries.length) continue;
      for (const entry of entries) {
        if (entry.isFile() && /^(licen[cs]e|copying|notice|ofl)/i.test(entry.name))
          texts.push(`\n${pkg} · ${entry.name}\n\n${await readFile(join(dir, entry.name), 'utf8')}`);
      }
      if (pkg.startsWith('ely-core-')) {
        const assets = join(dir, 'assets');
        for (const file of await readdir(assets, { recursive: true }).catch(() => [])) {
          if (/^(licen[cs]e|copying|notice|ofl)/i.test(basename(file)))
            texts.push(`\n${pkg} · ${file}\n\n${await readFile(join(assets, file), 'utf8')}`);
        }
      }
      break;
    }
  }
  assert(texts.length > 0, 'Cannot locate any dependency notices');
  return texts.join('\n');
}
