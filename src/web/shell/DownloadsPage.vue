<script setup lang="ts">
import { computed, onUnmounted, shallowRef } from 'vue';
import { linuxMuslInstallerTarget, nativeInstallerTargets, type NativeInstallerTarget } from '../../shared/desktop-releases.js';
import SvgIcon from '../SvgIcon.vue';
import { loadNativeInstaller, type NativeInstaller } from './native-installers.js';

const sourceVersion = __POCKET_NATIVE_VERSION__;
const sourceArchive = `https://github.com/muxkin/Remote-Agent-Control/releases/download/native-rust-v${sourceVersion}/AgentSpace-Native-${sourceVersion}-source.tar.gz`;
const installerLabels = {
  'windows-x64-setup.exe': { name: 'Windows x64', icon: 'windows', format: 'EXE' },
  'macos-arm64.dmg': { name: 'macOS Apple Silicon', icon: 'apple', format: 'DMG' },
  'macos-x64.dmg': { name: 'macOS Intel', icon: 'apple', format: 'DMG' },
  'linux-x64.deb': { name: 'Linux x64（glibc）', icon: 'linux', format: 'DEB' },
  'linux-x64-musl-desktop.tar.zst': { name: 'Linux x64（musl）', icon: 'linux', format: 'TAR.ZST' },
} as const;

type NativeResult = NativeInstaller | 'loading' | 'unpublished' | 'error';
type InstallerSuffix = NativeInstallerTarget['suffix'];
const nativeResults = shallowRef<Partial<Record<InstallerSuffix, NativeResult>>>({});
const targets = [...nativeInstallerTargets, linuxMuslInstallerTarget];
const nativeRows = computed(() =>
  targets
    .map((target) => ({
      target,
      ...installerLabels[target.suffix],
      result: nativeResults.value[target.suffix] ?? 'loading',
    }))
    .filter(({ target, result }) => target !== linuxMuslInstallerTarget || result !== 'unpublished'),
);
const verifiedRows = computed(() =>
  nativeRows.value.flatMap(({ name, result }) =>
    typeof result === 'string' ? [] : [{ name, release: result }],
  ),
);
const checkingInstallers = computed(() => nativeRows.value.some(({ result }) => result === 'loading'));
const installerRequests = new AbortController();
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

for (const target of targets) checkInstaller(target);
onUnmounted(() => installerRequests.abort());
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
      <p class="installer-note">Linux 便携包的启动方式见包内说明。DEB 安装更新时需要系统授权。</p>
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
      <a class="source-download" :href="sourceArchive" :aria-label="'下载源码包 v' + sourceVersion">
        <span>源码包 <small>v{{ sourceVersion }} · TAR.GZ</small></span>
        <SvgIcon name="download" :size="18" />
      </a>
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
.source-download small {
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
.download-links small,
.source-download small {
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

.download-details details,
.source-download {
  border-bottom: 1px solid var(--download-divider);
}

.download-details summary,
.source-download {
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

.source-download {
  text-decoration: none;
  color: var(--text);
}

.source-download small {
  margin-inline-start: 5px;
  font-weight: 400;
}

.download-details summary:hover,
.source-download:hover {
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

.download-links a {
  color: var(--accent);
  padding-block: 5px;
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
