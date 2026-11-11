<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import SvgIcon from '../SvgIcon.vue';
import ThemeEditor from './ThemeEditor.vue';
import {
  exportThemes,
  importThemes,
  MAX_CUSTOM_THEMES,
  presets,
  themeTokens,
  type Appearance,
  type ColorMode,
  type Theme,
} from './palette';
import { appearanceSnapshot, subscribeAppearance, updateAppearance } from './store';

const snapshot = shallowRef(appearanceSnapshot());
onScopeDispose(
  subscribeAppearance(() => {
    snapshot.value = appearanceSnapshot();
  }),
);

const settings = computed(() => snapshot.value.settings);
const resolved = computed(() => snapshot.value.resolved);
const themes = computed(() => [...presets, ...settings.value.customThemes]);
const displayModes = [
  ['system', '跟随系统', 'monitor'],
  ['light', '浅色', 'sun'],
  ['dark', '深色', 'moon'],
] as const;
const themeModes = ['light', 'dark'] as const;
const editor = shallowRef<Theme>();
const deleting = ref<string>();
const notice = ref('');
const fileInput = ref<HTMLInputElement>();

function save(next: Appearance) {
  try {
    updateAppearance(next);
    notice.value = '';
    return true;
  } catch {
    notice.value = '无法保存，请检查浏览器存储空间或权限';
    return false;
  }
}
function selectMode(event: MouseEvent, mode: Appearance['mode']) {
  if (mode !== settings.value.mode && !save({ ...settings.value, mode })) event.preventDefault();
}
function add(mode: ColorMode) {
  if (settings.value.customThemes.length >= MAX_CUSTOM_THEMES) {
    notice.value = `最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`;
    return;
  }
  editor.value = { id: `custom-${crypto.randomUUID()}`, name: '', mode, seed: '#197b66' };
}
function download(theme: Theme) {
  const url = URL.createObjectURL(new Blob([exportThemes([theme])], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${theme.name.replace(/[\\/:*?"<>|]/g, '_')}.theme.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function deleteTheme(theme: Theme) {
  const customThemes = settings.value.customThemes.filter((item) => item.id !== theme.id);
  if (save({ ...settings.value, customThemes })) deleting.value = undefined;
}
function saveTheme(theme: Theme) {
  const customThemes = settings.value.customThemes.filter((item) => item.id !== theme.id);
  updateAppearance({
    ...settings.value,
    customThemes: [...customThemes, theme],
    [theme.mode]: theme.id,
  });
  editor.value = undefined;
  notice.value = '主题已保存';
}
async function importFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    if (file.size > 32768) throw Error('主题文件过大（最多 32 KB）');
    const imported = importThemes(await file.text());
    const current = settings.value;
    if (current.customThemes.length + imported.length > MAX_CUSTOM_THEMES)
      throw Error(`最多保存 ${MAX_CUSTOM_THEMES} 个自定义主题`);
    if (
      save({
        ...current,
        customThemes: [
          ...current.customThemes,
          ...imported.map((theme) => ({ ...theme, id: `custom-${crypto.randomUUID()}` })),
        ],
      })
    ) {
      notice.value = `已导入 ${imported.length} 个主题，可在对应模式中选择`;
    }
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '主题导入失败';
  }
}
</script>

<template>
  <div class="appearance-settings">
    <section class="appearance-intro">
      <h2>让界面合你心意</h2>
      <p>浅色与深色，各有自己的配色。</p>
    </section>
    <fieldset class="theme-mode-picker">
      <legend>显示模式</legend>
      <div class="appearance-segmented">
        <label v-for="[mode, label, icon] in displayModes" :key="mode">
          <input
            type="radio"
            name="appearance-mode"
            :value="mode"
            :checked="settings.mode === mode"
            @click="selectMode($event, mode)"
          />
          <span><SvgIcon :name="icon" :size="18" />{{ label }}</span>
        </label>
      </div>
      <p class="hint">
        {{
          settings.mode === 'system'
            ? `随设备自动切换，当前为${resolved === 'light' ? '浅色' : '深色'}。`
            : `始终使用${resolved === 'light' ? '浅色' : '深色'}模式。`
        }}
      </p>
    </fieldset>
    <section v-for="mode in themeModes" :key="mode" class="theme-section" :aria-labelledby="`${mode}-themes`">
      <header>
        <div>
          <h2 :id="`${mode}-themes`">{{ mode === 'light' ? '浅色主题' : '深色主题' }}</h2>
          <p class="hint">{{ resolved === mode ? '当前模式' : '切换到此模式时使用' }}</p>
        </div>
        <button
          class="theme-add"
          :aria-label="`添加${mode === 'light' ? '浅色' : '深色'}主题`"
          @click="add(mode)"
        >
          <SvgIcon name="plus" :size="18" />添加主题
        </button>
      </header>
      <div class="theme-grid">
        <article
          v-for="theme in themes.filter((item) => item.mode === mode)"
          :key="theme.id"
          class="theme-card"
        >
          <button
            class="theme-select"
            :aria-label="`选择${theme.name}`"
            :aria-pressed="settings[mode] === theme.id"
            @click="save({ ...settings, [mode]: theme.id })"
          >
            <div class="theme-preview" :style="themeTokens(theme)" aria-hidden="true">
              <div class="theme-preview-rail"><i></i><i></i><i></i></div>
              <div class="theme-preview-chat">
                <span class="theme-preview-bubble"></span>
                <span class="theme-preview-line"></span>
                <span class="theme-preview-line short"></span>
                <span class="theme-preview-input"><i></i></span>
              </div>
            </div>
            <span class="theme-card-label">
              <strong>{{ theme.name }}</strong>
              <span v-if="settings[mode] === theme.id"><SvgIcon name="check" :size="16" />已选择</span>
              <small v-else>{{ theme.id.startsWith('custom-') ? '自定义' : '预设' }}</small>
            </span>
          </button>
          <div class="theme-card-tools">
            <button title="导出主题" :aria-label="`导出${theme.name}`" @click="download(theme)">
              <SvgIcon name="download" :size="16" />
            </button>
            <template v-if="settings.customThemes.some((item) => item.id === theme.id)">
              <button title="编辑主题" :aria-label="`编辑${theme.name}`" @click="editor = theme">
                <SvgIcon name="sliders" :size="16" />
              </button>
              <button title="删除主题" :aria-label="`删除${theme.name}`" @click="deleting = theme.id">
                <SvgIcon name="trash" :size="16" />
              </button>
            </template>
          </div>
          <div v-if="deleting === theme.id" class="theme-delete-confirm">
            <p>删除“{{ theme.name }}”？</p>
            <button class="secondary" @click="deleting = undefined">取消</button>
            <button class="danger" @click="deleteTheme(theme)">确认删除</button>
          </div>
        </article>
      </div>
    </section>
    <div class="theme-import">
      <button class="secondary" @click="fileInput?.click()">
        <SvgIcon name="upload" :size="18" />导入主题
      </button>
      <p class="hint">主题保存在此浏览器。导出后可在其他设备导入。</p>
      <input
        ref="fileInput"
        hidden
        type="file"
        accept=".json,application/json"
        aria-label="导入主题文件"
        @change="importFile"
      />
    </div>
    <p v-if="notice" class="appearance-notice" role="status">{{ notice }}</p>
    <ThemeEditor v-if="editor" :theme="editor" :save="saveTheme" @close="editor = undefined" />
  </div>
</template>
