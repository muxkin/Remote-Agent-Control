<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue';
import { nativeInstallerTargets, type NativeInstallerTarget } from '../../shared/desktop-releases.js';
import SvgIcon from '../SvgIcon.vue';
import { loadNativeInstaller, type NativeInstaller } from './native-installers.js';

const releases = 'https://github.com/muxkin/Remote-Agent-Control/releases';
const portableVersion = '0.2.7';
const portableBase = `${releases}/download/native-v${portableVersion}/AgentSpace-Native-${portableVersion}-`;
const portableDownloads = [
  { name: 'Windows x64', suffix: 'windows-x64.zip' },
  { name: 'Linux x64', suffix: 'linux-x64.tar.xz' },
];
const platforms = [
  { id: 'win32', label: 'Windows' },
  { id: 'darwin', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
];
const installerLabels = {
  'windows-x64-setup.exe': { name: 'Windows x64', icon: 'windows', format: 'EXE' },
  'macos-arm64.dmg': { name: 'macOS Apple Silicon', icon: 'apple', format: 'DMG' },
  'macos-x64.dmg': { name: 'macOS Intel', icon: 'apple', format: 'DMG' },
  'linux-x64.deb': { name: 'Linux x64', icon: 'linux', format: 'DEB' },
} as const;

type NativeResult = NativeInstaller | 'loading' | 'unpublished' | 'error';
type InstallerSuffix = NativeInstallerTarget['suffix'];
interface ArchiveDownload {
  platform: string;
  arch: string;
  version: string;
  file: string;
  size: number;
}

const nativeResults = shallowRef<Partial<Record<InstallerSuffix, NativeResult>>>({});
const nativeRows = computed(() =>
  nativeInstallerTargets.map((target) => ({
    target,
    ...installerLabels[target.suffix],
    result: nativeResults.value[target.suffix] ?? 'loading',
  })),
);
const verifiedRows = computed(() =>
  nativeRows.value.flatMap(({ name, result }) =>
    typeof result === 'string' ? [] : [{ name, release: result }],
  ),
);
const checkingInstallers = computed(() => nativeRows.value.some(({ result }) => result === 'loading'));
const installerRequests = new AbortController();
const archiveAttempt = ref(0);
const archiveOpen = ref(false);
const archiveStatus = ref<'loading' | 'ready' | 'error'>('loading');
const files = shallowRef<ArchiveDownload[]>([]);
const previewBase = '/downloads/desktop/native/preview/linux/x64/';
const preview = shallowRef<{ version: string; files: { name: string; size: number }[] }>();
const signedLinux = shallowRef<NativeInstaller>();
const archiveSections = computed(() =>
  platforms
    .map(({ id, label }) => ({ label, files: files.value.filter((file) => file.platform === id) }))
    .filter((section) => section.files.length),
);
const sizeLabel = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MiB`;

function checkInstaller(target: NativeInstallerTarget) {
  const { signal } = installerRequests;
  const setResult = (result: NativeResult) => {
    if (!signal.aborted) {
      nativeResults.value = { ...nativeResults.value, [target.suffix]: result };
    }
  };
  setResult('loading');
  void loadNativeInstaller(target, 'rust', signal)
    .then((release) => setResult(release ?? 'unpublished'))
    .catch(() => setResult('error'));
}

for (const target of nativeInstallerTargets) checkInstaller(target);
onUnmounted(() => installerRequests.abort());

watch([archiveOpen, archiveAttempt], async ([open], _previous, onCleanup) => {
  if (!open) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const { signal } = controller;
  archiveStatus.value = 'loading';

  const linux = nativeInstallerTargets.find(({ platform }) => platform === 'linux');
  if (linux) {
    void loadNativeInstaller(linux, 'hybrid', signal)
      .then((release) => {
        if (!signal.aborted) signedLinux.value = release ?? undefined;
      })
      .catch(() => {
        if (!signal.aborted) signedLinux.value = undefined;
      });
  }

  void fetch(previewBase + 'preview.json', { signal, cache: 'no-cache' })
    .then(async (response) => (response.ok ? response.json() : undefined))
    .then((manifest) => {
      if (signal.aborted || !manifest || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(manifest.version)) return;
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
    const response = await fetch('/downloads/desktop/releases.json', { signal, cache: 'no-cache' });
    if (!response.ok && response.status !== 404) throw new Error('Release manifest unavailable');
    const data = response.status === 404 ? { files: [] } : await response.json();
    if (!Array.isArray(data.files)) throw new Error('Invalid release manifest');
    if (signal.aborted) return;
    files.value = data.files.filter(
      (file: ArchiveDownload) =>
        file &&
        ['linux', 'darwin', 'win32'].includes(file.platform) &&
        ['x64', 'arm64'].includes(file.arch) &&
        /^AgentSpace-[0-9][A-Za-z0-9._-]*\.(exe|dmg|AppImage)$/.test(file.file) &&
        typeof file.version === 'string' &&
        Number.isFinite(file.size),
    );
    archiveStatus.value = 'ready';
  } catch {
    if (!signal.aborted) archiveStatus.value = 'error';
  }
});

function onArchiveToggle(event: Event) {
  archiveOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}
</script>

<template>
  <div class="adapter-downloads">
    <header class="adapter-intro">
      <h2>连接你的电脑</h2>
      <p>在电脑上安装并打开适配器，再用手机扫码配对。</p>
    </header>

    <section aria-labelledby="adapter-installer-title">
      <div class="installer-heading">
        <h3 id="adapter-installer-title">下载安装器</h3>
        <span>支持自动更新</span>
      </div>

      <ul class="installer-list" :aria-busy="checkingInstallers" aria-live="polite">
        <li
          v-for="{ target, name, icon, format, result } in nativeRows"
          :key="target.suffix"
          class="installer-row"
        >
          <span class="platform-icon">
            <SvgIcon :name="icon" :size="22" />
          </span>
          <div class="installer-info">
            <strong>{{ name }}</strong>
            <small v-if="typeof result !== 'string'">
              v{{ result.version }} · {{ format }} · {{ sizeLabel(result.size) }}
            </small>
            <small v-else-if="result === 'loading'">正在验证安装包…</small>
            <small v-else-if="result === 'unpublished'">暂未发布</small>
            <small v-else>暂时无法验证安装包</small>
          </div>
          <a
            v-if="typeof result !== 'string'"
            class="installer-download"
            :href="result.href"
            :aria-label="'下载 ' + name"
            download
          >
            <SvgIcon name="download" :size="17" />
            下载
          </a>
          <button
            v-else-if="result === 'error'"
            type="button"
            class="installer-retry"
            :aria-label="'重新检查 ' + name"
            @click="checkInstaller(target)"
          >
            重试
          </button>
        </li>
      </ul>
      <p class="installer-note">Linux 安装更新时需要系统授权。</p>
    </section>

    <div class="download-details">
      <details v-if="verifiedRows.length">
        <summary>
          签名清单
          <SvgIcon name="chevron" :size="18" />
        </summary>
        <ul class="download-links">
          <li v-for="{ name, release } in verifiedRows" :key="name">
            <a :href="release.manifest" :aria-label="name + ' 签名清单'">{{ name }}</a>
            <small v-if="release.releaseKeyOnly">发布密钥验签</small>
          </li>
        </ul>
      </details>
      <details @toggle="onArchiveToggle">
        <summary>
          旧版本与便携包
          <SvgIcon name="chevron" :size="18" />
        </summary>
        <div class="archive-downloads">
          <p><a :href="releases">GitHub 发行记录与独立插件</a></p>

          <section v-if="signedLinux">
            <h4>Linux x64 旧签名安装版 v{{ signedLinux.version }}</h4>
            <ul class="download-links">
              <li>
                <a :href="signedLinux.href" download>下载签名 DEB</a>
                <small>{{ sizeLabel(signedLinux.size) }}</small>
              </li>
              <li><a :href="signedLinux.manifest">签名更新清单</a></li>
            </ul>
          </section>

          <section v-if="preview">
            <h4>Linux x64 插件版预览 v{{ preview.version }}</h4>
            <p>自动更新暂未启用。</p>
            <ul class="download-links">
              <li v-for="file in preview.files" :key="file.name">
                <a :href="previewBase + file.name" download>{{ file.name.endsWith('.deb') ? '下载 DEB 安装包' : '下载便携包' }}</a>
                <small>{{ sizeLabel(file.size) }}</small>
              </li>
              <li><a :href="previewBase + 'preview.json'">SHA-256 校验清单</a></li>
            </ul>
          </section>

          <section>
            <h4>原生便携版 v{{ portableVersion }}</h4>
            <ul class="download-links">
              <li v-for="{ name, suffix } in portableDownloads" :key="suffix">
                <a :href="portableBase + suffix">{{ name }} · 下载便携包</a>
              </li>
            </ul>
          </section>

          <p v-if="archiveStatus === 'loading'" role="status">正在读取归档安装包…</p>
          <div v-else-if="archiveStatus === 'error'" role="status">
            <p>暂时无法读取归档安装包。</p>
            <button type="button" class="installer-retry" @click="archiveAttempt++">重试</button>
          </div>
          <section v-for="section in archiveSections" :key="section.label">
            <h4>{{ section.label }} 旧安装包</h4>
            <ul class="download-links">
              <li v-for="file in section.files" :key="file.file">
                <a :href="'/downloads/desktop/' + file.platform + '/' + file.arch + '/' + file.file" download>
                  {{ file.arch === 'arm64' ? 'ARM64 / Apple Silicon' : 'Intel / AMD 64 位' }} · 下载 v{{ file.version }}
                </a>
                <small>{{ sizeLabel(file.size) }}</small>
              </li>
            </ul>
          </section>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.adapter-downloads {
  --download-divider: color-mix(in srgb, var(--outline) 55%, transparent);
  width: min(100%, 640px);
  margin-inline: auto;
  padding: clamp(24px, 5vw, 44px) 24px 40px;
  color: var(--text);
}

.adapter-intro {
  margin-bottom: 30px;
}

.adapter-intro h2 {
  margin: 0 0 8px;
  font-size: clamp(26px, 4vw, 34px);
  line-height: 1.25;
}

.adapter-intro p,
.installer-heading span,
.installer-note,
.installer-info small,
.download-links small,
.archive-downloads p {
  color: var(--muted);
  line-height: 1.5;
}

.adapter-intro p {
  margin: 0;
  font-size: 14px;
}

.installer-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.installer-heading h3 {
  margin: 0;
  font-size: 18px;
}

.installer-heading span,
.installer-note {
  font-size: 13px;
}

.installer-list {
  margin: 0 -6px;
  padding: 0 14px;
  list-style: none;
  border: 1px solid var(--outline);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 88%, var(--surface-subtle));
}

.installer-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding-block: 11px;
}

.installer-row + .installer-row {
  border-top: 1px solid var(--download-divider);
}

.platform-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 13%, var(--surface));
  color: var(--accent);
}

.installer-info {
  display: grid;
  gap: 4px;
  overflow-wrap: anywhere;
}

.installer-info strong {
  font-size: 16px;
  line-height: 1.25;
  font-weight: 650;
}

.installer-info small,
.download-links small {
  font-size: 12px;
}

.installer-download,
.installer-retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 42px;
  border-radius: 10px;
  padding: 0 12px;
  font-size: 14px;
  font-weight: 650;
  white-space: nowrap;
}

.installer-download {
  background: var(--accent);
  color: var(--on-accent);
  text-decoration: none;
}

.installer-download:hover {
  background: color-mix(in srgb, var(--accent) 88%, var(--text));
  color: var(--on-accent);
}

.installer-retry {
  border: 1px solid var(--outline);
  background: var(--surface);
  color: var(--accent);
  cursor: pointer;
}

.installer-note {
  margin: 12px 0 24px;
}

.download-details {
  border-top: 1px solid var(--download-divider);
}

.download-details details {
  border-bottom: 1px solid var(--download-divider);
}

.download-details summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding-block: 8px;
  font-size: 16px;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}

.download-details summary::-webkit-details-marker {
  display: none;
}

.download-details details[open] > summary svg {
  transform: rotate(90deg);
}

.download-details summary:hover {
  color: var(--accent);
}

.adapter-downloads :is(a, button, summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.download-links {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0 0 12px;
  list-style: none;
  font-size: 14px;
}

.download-links li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
}

.download-links a,
.archive-downloads a {
  color: var(--accent);
}

.download-links a {
  padding-block: 5px;
}

.archive-downloads {
  display: grid;
  gap: 14px;
  padding-bottom: 16px;
}

.archive-downloads h4,
.archive-downloads p {
  margin: 0;
  font-size: 14px;
}

.archive-downloads h4 {
  margin-bottom: 5px;
}

.archive-downloads .download-links {
  padding-bottom: 0;
}

@media (max-width: 420px) {
  .adapter-downloads {
    padding-inline: 20px;
  }
}

@media (max-width: 360px) {
  .installer-list {
    padding-inline: 10px;
  }

  .installer-row {
    gap: 8px;
  }

  .platform-icon {
    width: 36px;
    height: 36px;
  }

  .installer-download,
  .installer-retry {
    padding-inline: 9px;
  }
}
</style>
