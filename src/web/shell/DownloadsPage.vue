<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import SvgIcon from '../SvgIcon.vue';
import './donation.css';

const version = __POCKET_NATIVE_VERSION__;
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
