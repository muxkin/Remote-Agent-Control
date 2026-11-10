<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { nativeInstallerTargets } from '../../shared/desktop-releases.js';
import SvgIcon from '../SvgIcon.vue';
import { loadNativeInstaller, type NativeInstaller } from './native-installers.js';
import './donation.css';

const version = '0.2.7'; // Last GitHub release with both portable packages.
const nativeRelease = 'https://github.com/muxkin/Remote-Agent-Control/releases/download/native-v' + version;
const nativeDownloads = [
  { name: 'Windows x64', suffix: 'windows-x64.zip' },
  { name: 'Linux x64', suffix: 'linux-x64.tar.xz' },
];
const platforms = [
  { id: 'win32', label: 'Windows' },
  { id: 'darwin', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
];
interface Download {
  platform: string;
  arch: string;
  version: string;
  file: string;
  size: number;
}
const files = shallowRef<Download[]>([]);
const previewBase = '/downloads/desktop/native/preview/linux/x64/';
const preview = shallowRef<{ version: string; files: { name: string; size: number }[] }>();
const signedLinux = shallowRef<NativeInstaller>();
const nativeNames = {
  'windows-x64-setup.exe': 'Windows x64',
  'macos-arm64.dmg': 'macOS Apple Silicon',
  'macos-x64.dmg': 'macOS Intel',
  'linux-x64.deb': 'Linux x64',
} as const;
type NativeResult = NativeInstaller | 'loading' | 'unpublished' | 'error';
const nativeResults = shallowRef<NativeResult[]>([]);
const nativeRows = computed(() =>
  nativeInstallerTargets.map((target, index) => ({
    name: nativeNames[target.suffix],
    target,
    result: nativeResults.value[index] ?? 'loading',
  })),
);

const sections = computed(() =>
  platforms.map((platform) => ({
    ...platform,
    files: files.value.filter((file) => file.platform === platform.id),
  })),
);
const state = ref<'loading' | 'ready' | 'error'>('loading');
const attempt = ref(0);

watch(
  attempt,
  async (_attempt, _previous, onCleanup) => {
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    state.value = 'loading';
    nativeResults.value = nativeInstallerTargets.map(() => 'loading');
    nativeInstallerTargets.forEach((target, index) => {
      const set = (result: NativeResult) => {
        if (controller.signal.aborted) return;
        nativeResults.value = nativeResults.value.map((value, current) =>
          current === index ? result : value,
        );
      };
      void loadNativeInstaller(target, 'rust', controller.signal)
        .then((release) => set(release ?? 'unpublished'))
        .catch(() => set('error'));
      if (target.platform === 'linux') {
        void loadNativeInstaller(target, 'hybrid', controller.signal)
          .then((release) => {
            if (!controller.signal.aborted) signedLinux.value = release ?? undefined;
          })
          .catch(() => {
            if (!controller.signal.aborted) signedLinux.value = undefined;
          });
      }
    });
    void fetch(previewBase + 'preview.json', { signal: controller.signal, cache: 'no-cache' })
      .then(async (response) => (response.ok ? response.json() : undefined))
      .then((manifest) => {
        if (controller.signal.aborted || !manifest || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(manifest.version))
          return;
        if (!Array.isArray(manifest.files)) return;
        const expected = ['deb', 'tar.xz'].map(
          (suffix) => `AgentSpace-Native-${manifest.version}-linux-x64.${suffix}`,
        );
        const files = manifest.files.filter(
          (file: { name?: string; size?: number }) =>
            file && expected.includes(file.name ?? '') && Number.isFinite(file.size) && Number(file.size) > 0,
        );
        if (files.length === 2 && new Set(files.map((file: { name: string }) => file.name)).size === 2)
          preview.value = { version: manifest.version, files };
      })
      .catch(() => {});

    try {
      const response = await fetch('/downloads/desktop/releases.json', {
        signal: controller.signal,
        cache: 'no-cache',
      });
      if (!response.ok && response.status !== 404) throw new Error('Release manifest unavailable');
      const data = response.status === 404 ? { files: [] } : await response.json();
      if (!Array.isArray(data.files)) throw new Error('Invalid release manifest');
      if (controller.signal.aborted) return;

      files.value = data.files.filter(
        (file: Download) =>
          ['linux', 'darwin', 'win32'].includes(file.platform) &&
          ['x64', 'arm64'].includes(file.arch) &&
          /^AgentSpace-[0-9][A-Za-z0-9._-]*\.(exe|dmg|AppImage)$/.test(file.file) &&
          typeof file.version === 'string' &&
          Number.isFinite(file.size),
      );
      state.value = 'ready';
    } catch {
      if (!controller.signal.aborted) state.value = 'error';
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="donation-page">
    <section class="donation-intro">
      <span class="donation-mark">
        <SvgIcon name="monitor" :size="32" />
      </span>
      <h2>连接你的电脑</h2>
      <p>安装适配器，打开已有的 Codex / Agent，<br />再用手机扫码配对。</p>
    </section>
    <section class="donation-card">
      <h3>纯 Rust 安装版</h3>
      <p>支持自动更新。Codex 和 DSH 插件可独立安装和升级。Linux 安装更新时需要系统授权。</p>
      <p v-for="{ name, target, result } in nativeRows" :key="target.suffix" class="native-release-row">
        <template v-if="typeof result !== 'string'">
          <a :href="result.href" download>{{ name }} · 下载 v{{ result.version }}</a>
          <span class="native-release-meta">
            <small>{{ Math.ceil(result.size / 1024 / 1024) }} MiB</small>
            <small v-if="result.releaseKeyOnly">发布密钥验签</small>
            <small><a :href="result.manifest" :aria-label="name + ' 签名清单'">签名清单</a></small>
          </span>
        </template>
        <template v-else-if="result === 'loading'">{{ name }} · 正在检查…</template>
        <template v-else-if="result === 'unpublished'">{{ name }} · 待发布</template>
        <template v-else>{{ name }} · 暂时无法验证安装包</template>
      </p>
      <button v-if="nativeResults.includes('error')" class="secondary" @click="attempt++">
        重试纯 Rust 安装包
      </button>
    </section>
    <h3>旧版与便携包</h3>
    <section v-if="signedLinux" class="donation-card">
      <h3>Linux x64 旧签名安装版 v{{ signedLinux.version }}</h3>
      <p>内置 Agent 插件和独立 Agent 的消息与通话接入。更新下载后由系统授权安装。</p>
      <p>
        <a :href="signedLinux.href" download>下载签名 DEB</a>
        <small> · {{ Math.ceil(signedLinux.size / 1024 / 1024) }} MB</small>
      </p>
      <p><a :href="signedLinux.manifest">签名更新清单</a></p>
    </section>
    <section v-if="preview" class="donation-card">
      <h3>Linux x64 插件版预览 v{{ preview.version }}</h3>
      <p>内置 Codex 和 DSH 插件。预览包的自动更新暂未启用。</p>
      <p v-for="file in preview.files" :key="file.name">
        <a :href="previewBase + file.name" download>{{
          file.name.endsWith('.deb') ? '下载 DEB 安装包' : '下载便携包'
        }}</a>
        <small> · {{ Math.ceil(file.size / 1024 / 1024) }} MB</small>
      </p>
      <p><a :href="previewBase + 'preview.json'">SHA-256 校验清单</a></p>
    </section>
    <section class="donation-card">
      <h3>原生托盘版 v{{ version }}</h3>
      <p>解压即可运行，无需安装 Node 或 Python。关闭窗口后继续在托盘运行，可在托盘菜单退出。</p>
      <p v-for="{ name, suffix } in nativeDownloads" :key="suffix">
        <a :href="nativeRelease + '/AgentSpace-Native-' + version + '-' + suffix">{{ name }} · 下载便携包</a>
      </p>
    </section>
    <h3>原有安装版</h3>
    <p v-if="state === 'loading'" role="status">正在读取安装包…</p>
    <div v-else-if="state === 'error'" role="status">
      <p>暂时无法读取安装包。</p>
      <button class="secondary" @click="attempt++">重试</button>
    </div>
    <template v-else>
      <section v-for="section in sections" :key="section.id" class="donation-card">
        <h3>{{ section.label }}</h3>
        <template v-if="section.files.length">
          <p v-for="file in section.files" :key="file.arch">
            <a :href="'/downloads/desktop/' + file.platform + '/' + file.arch + '/' + file.file" download>
              {{ file.arch === 'arm64' ? 'ARM64 / Apple Silicon' : 'Intel / AMD 64 位' }} · 下载 v{{
                file.version
              }}
            </a>
            <small> · {{ Math.ceil(file.size / 1024 / 1024) }} MB</small>
          </p>
        </template>
        <p v-else>此平台的正式安装包尚未发布。</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.native-release-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 12px;
  margin-block: 6px;
}
.native-release-meta {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0 8px;
}
.native-release-row a {
  color: var(--accent);
}
</style>
