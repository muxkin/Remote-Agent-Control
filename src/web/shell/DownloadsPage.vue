<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import SvgIcon from '../SvgIcon.vue';
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
const signedBase = '/downloads/desktop/native/linux/x64/';
const signedLinux = shallowRef<{ version: string; file: string; size: number }>();
const releaseKey = 'MCowBQYDK2VwAyEA8sqXWWd6moWnpeBJiNk9yHRDApRW/+Qbm6yUwCSA/F8=';
const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

async function loadSignedLinux(signal: AbortSignal) {
  const response = await fetch(signedBase + 'latest.json', { signal, cache: 'no-cache' });
  if (!response.ok) return;
  const envelope = await response.json();
  if (
    typeof envelope.payload !== 'string' ||
    envelope.payload.length > 16384 ||
    typeof envelope.signature !== 'string' ||
    envelope.signature.length !== 88
  )
    return;
  const payload = bytes(envelope.payload);
  const key = await crypto.subtle.importKey('spki', bytes(releaseKey), 'Ed25519', false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', key, bytes(envelope.signature), payload)) || signal.aborted)
    return;
  const release = JSON.parse(new TextDecoder().decode(payload));
  if (
    release.format === 1 &&
    release.platform === 'linux' &&
    release.arch === 'x64' &&
    typeof release.version === 'string' &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(release.version) &&
    release.file === `AgentSpace-Native-${release.version}-linux-x64.deb` &&
    Number.isSafeInteger(release.size) &&
    release.size > 0
  )
    signedLinux.value = { version: release.version, file: release.file, size: release.size };
}
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
    void loadSignedLinux(controller.signal).catch(() => {});
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
    <section v-if="signedLinux" class="donation-card">
      <h3>Linux x64 签名安装版 v{{ signedLinux.version }}</h3>
      <p>内置 Agent 插件和独立 Agent 的消息与通话接入。更新下载后由系统授权安装。</p>
      <p>
        <a :href="signedBase + signedLinux.file" download>下载签名 DEB</a>
        <small> · {{ Math.ceil(signedLinux.size / 1024 / 1024) }} MB</small>
      </p>
      <p><a :href="signedBase + 'latest.json'">签名更新清单</a></p>
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
