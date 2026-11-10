import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { zipSync } from 'fflate';

const [platform, binary, triple] = process.argv.slice(2);
assert(
  ['linux', 'win32'].includes(platform) && binary,
  'Usage: native-package.mjs <linux|win32> <binary> [rust-target]',
);
const native = resolve('desktop/native');
const name = platform === 'win32' ? 'agent-space-native.exe' : 'agent-space-native';
const target = triple ?? (platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu');
assert(target.startsWith('x86_64-'), 'This preview packages x64 builds');
const cargo = await readFile(join(native, 'Cargo.toml'), 'utf8');
const version = cargo.match(/^version = "([0-9.]+)"$/m)?.[1];
assert(version, 'Cannot read native desktop version');
const executable = await readFile(binary);
assert(
  executable
    .subarray(0, platform === 'win32' ? 2 : 4)
    .equals(platform === 'win32' ? Buffer.from('MZ') : Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
  'Executable does not match the requested platform',
);
if (platform === 'linux') {
  const symbols = execFileSync('readelf', ['--version-info', resolve(binary)], { encoding: 'utf8' });
  const versions = [...symbols.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)];
  assert(
    versions.length > 0 && versions.every(([, major, minor]) => Number(major) === 2 && Number(minor) <= 39),
    'Build the Linux preview with glibc 2.39 or older, as in the Ubuntu 24.04 CI job',
  );
}

const output = resolve('dist/desktop-native-preview');
const folder = `AgentSpace-Native-${version}-${platform === 'win32' ? 'windows' : 'linux'}-x64`;
const stage = await mkdtemp(join(tmpdir(), 'agent-space-native-package-'));
try {
  const dir = join(stage, folder);
  await mkdir(dir);
  await mkdir(output, { recursive: true });
  await writeFile(join(dir, name), executable);
  if (platform === 'linux') await chmod(join(dir, name), 0o755);
  await copyFile('LICENSE', join(dir, 'LICENSE'));
  await writeFile(
    join(dir, 'README.txt'),
    `Agent 空间电脑适配器 ${version} · Rust + Ely 预览

解包并运行 ${name}，在设置中填写服务地址。
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
  const path = join(output, `${folder}.${platform === 'win32' ? 'zip' : 'tar.xz'}`);
  if (platform === 'win32') {
    const contents = {};
    for (const entry of await readdir(dir)) contents[`${folder}/${entry}`] = await readFile(join(dir, entry));
    await writeFile(path, zipSync(contents, { level: 9 }));
  } else {
    execFileSync('tar', ['-C', stage, '-cJf', path, folder], { stdio: 'inherit' });
  }
  const data = await readFile(path);
  await writeFile(
    `${path}.sha256`,
    `${createHash('sha256').update(data).digest('hex')}  ${basename(path)}\n`,
  );
  console.log(`${path} · ${(data.length / 2 ** 20).toFixed(2)} MiB`);
} finally {
  await rm(stage, { recursive: true, force: true });
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
