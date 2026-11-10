<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import SvgIcon from '../SvgIcon.vue';
import { themeTokens, type Theme } from './palette';

const props = defineProps<{ theme: Theme; save: (theme: Theme) => void }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const draft = ref({ ...props.theme });
const seedText = ref(props.theme.seed);
const validColor = computed(() => /^#[0-9a-f]{6}$/i.test(seedText.value));
const error = ref('');
const modes = ['light', 'dark'] as const;
let previousFocus: HTMLElement | null = null;

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value!.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  previousFocus?.focus({ preventScroll: true });
});

function changeColor(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  seedText.value = input.value;
  if (validColor.value) draft.value.seed = input.value;
}
function submit() {
  const name = draft.value.name.trim();
  if (!validColor.value || !name) return;
  try {
    props.save({ ...draft.value, name });
  } catch {
    error.value = '无法保存，请检查浏览器存储空间或权限';
  }
}
</script>

<template>
  <dialog
    ref="dialog"
    class="theme-editor"
    aria-labelledby="theme-editor-title"
    @cancel.prevent="emit('close')"
  >
    <form @submit.prevent="submit">
      <header>
        <h2 id="theme-editor-title">{{ theme.name ? '编辑主题' : '添加主题' }}</h2>
        <button type="button" class="icon-button" aria-label="关闭主题编辑" @click="emit('close')">
          <SvgIcon name="close" />
        </button>
      </header>
      <label>
        主题名称
        <input v-model="draft.name" autofocus required maxlength="32" placeholder="例如：暮色" />
      </label>
      <fieldset class="theme-mode-picker">
        <legend>适用模式</legend>
        <div class="appearance-segmented">
          <label v-for="mode in modes" :key="mode">
            <input v-model="draft.mode" type="radio" name="editor-mode" :value="mode" />
            <span>{{ mode === 'light' ? '浅色' : '深色' }}</span>
          </label>
        </div>
      </fieldset>
      <div class="theme-color-field">
        <label for="theme-seed">主色</label>
        <div>
          <input aria-label="选择主色" type="color" :value="draft.seed" @input="changeColor" />
          <input
            id="theme-seed"
            type="text"
            :value="seedText"
            maxlength="7"
            pattern="#[0-9a-fA-F]{6}"
            required
            :spellcheck="false"
            :aria-invalid="!validColor"
            @input="changeColor"
          />
        </div>
        <p class="hint">选一个主色，自动搭配背景、文字与按钮颜色。</p>
      </div>
      <div class="theme-live-sample" :style="themeTokens(draft)">
        <strong>让工作更专注</strong>
        <p>这是一段消息的预览文字。</p>
        <span>已选择的内容</span>
        <button type="button">发送</button>
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" @click="emit('close')">取消</button>
        <button class="primary" :disabled="!validColor || !draft.name.trim()">保存主题</button>
      </footer>
    </form>
  </dialog>
</template>
