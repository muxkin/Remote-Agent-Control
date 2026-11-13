<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import {
  DEEPSEEK_TRANSLATION_MODELS,
  type SelectionTranslationProvider,
} from '../shared/selection-translation';
import { Icon } from './Icon';
import type { IconName } from './icon-paths';
import { messaging, useMessaging } from './messaging/context';
import { translateWithService, translationServiceAvailable } from './selection-translation-client';
import {
  clearTranslationApiKey,
  hasTranslationApiKey,
  readTranslationApiKey,
  saveTranslationApiKey,
  translationSettings,
  updateTranslationSettings,
  type CloudTranslationEngine,
  type TranslationEngine,
  type TranslationSettings,
} from './selection-translation-settings';

defineEmits<{ login: [] }>();

const accountState = useMessaging();
const account = computed(() => {
  const { user } = accountState;
  const { secrets } = messaging.account;
  return user?.kind === 'human' && messaging.account.user?.id === user.id && secrets
    ? { id: user.id, secrets }
    : undefined;
});

const engines: { id: TranslationEngine; title: string; detail: string; icon: IconName }[] = [
  { id: 'automatic', title: '自动选择', detail: '优先使用浏览器内置翻译', icon: 'sliders' },
  { id: 'device', title: '浏览器内置', detail: '选中的文字在设备内处理', icon: 'monitor' },
  { id: 'site', title: '站点翻译', detail: '使用站点配置的 LibreTranslate', icon: 'globe' },
  { id: 'niutrans', title: '小牛翻译', detail: '机器翻译 · 使用你的 API Key', icon: 'ox' },
  { id: 'deepseek', title: 'DeepSeek', detail: 'AI 翻译 · 使用你的 API Key', icon: 'sparkles' },
];
const selectedProvider = computed<CloudTranslationEngine | undefined>(() => {
  const { engine } = translationSettings.value;
  if (engine === 'niutrans' || engine === 'deepseek') return engine;
});
const providerName = computed(() => (selectedProvider.value === 'niutrans' ? '小牛翻译' : 'DeepSeek'));
const savedKey = computed(
  () =>
    !!account.value &&
    !!selectedProvider.value &&
    hasTranslationApiKey(account.value.id, selectedProvider.value),
);
const apiKey = ref('');
const reveal = ref(false);
const testing = ref(false);
const saving = ref(false);
const model = ref(translationSettings.value.deepseekModel);
const notice = ref<{ text: string; error?: boolean }>();
const siteStatus = ref<'checking' | 'available' | 'unavailable'>('checking');
let testRequest: AbortController | undefined;

watch([selectedProvider, () => account.value?.id], () => {
  testRequest?.abort();
  testing.value = false;
  apiKey.value = '';
  reveal.value = false;
  model.value = translationSettings.value.deepseekModel;
  notice.value = undefined;
});
watch(
  () => translationSettings.value.deepseekModel,
  (next) => {
    model.value = next;
  },
);
watch(
  [() => translationSettings.value.engine, () => account.value?.id],
  ([engine, accountId], _, cleanup) => {
    if (engine !== 'site' || !accountId) return;
    const request = new AbortController();
    cleanup(() => request.abort());
    siteStatus.value = 'checking';
    void translationServiceAvailable(request.signal)
      .then((available) => {
        if (!request.signal.aborted) siteStatus.value = available ? 'available' : 'unavailable';
      })
      .catch(() => {});
  },
  { immediate: true },
);
onScopeDispose(() => testRequest?.abort());

function setPreference(change: Partial<TranslationSettings>) {
  notice.value = undefined;
  try {
    updateTranslationSettings({ ...translationSettings.value, ...change });
  } catch {
    notice.value = { text: '无法保存设置，请检查浏览器存储权限。', error: true };
  }
}

function toggleTranslation(event: Event) {
  const input = event.target as HTMLInputElement;
  setPreference({ enabled: input.checked });
  input.checked = translationSettings.value.enabled;
}

function chooseEngine(event: Event, engine: TranslationEngine) {
  const input = event.target as HTMLInputElement;
  setPreference({ engine });
  if (translationSettings.value.engine !== engine) {
    input.checked = false;
    const active = input
      .closest('fieldset')
      ?.querySelector<HTMLInputElement>('label[data-selected="true"] input');
    if (active) active.checked = true;
  }
}

async function save() {
  const current = account.value;
  const provider = selectedProvider.value;
  if (!current || !provider || saving.value) return;
  const replacement = apiKey.value.trim();
  const nextModel = model.value;
  const changedModel = provider === 'deepseek' && nextModel !== translationSettings.value.deepseekModel;
  if (!replacement && !savedKey.value) return;
  saving.value = true;
  notice.value = undefined;
  let savedReplacement = false;
  try {
    if (replacement) {
      await saveTranslationApiKey(current, provider, replacement);
      savedReplacement = true;
    }
    if (current.id !== account.value?.id || provider !== selectedProvider.value) return;
    if (changedModel) updateTranslationSettings({ ...translationSettings.value, deepseekModel: nextModel });
    apiKey.value = '';
    reveal.value = false;
    notice.value = { text: '配置已保存。' };
  } catch {
    if (savedReplacement) {
      apiKey.value = '';
      reveal.value = false;
    }
    notice.value = {
      text: savedReplacement
        ? 'API Key 已保存。模型设置未能写入，请重试。'
        : '无法保存配置，请检查密钥和浏览器存储权限。',
      error: true,
    };
  } finally {
    saving.value = false;
  }
}

function removeKey() {
  const current = account.value;
  const provider = selectedProvider.value;
  if (!current || !provider) return;
  try {
    clearTranslationApiKey(current.id, provider);
    notice.value = { text: 'API Key 已清除。' };
  } catch {
    notice.value = { text: '无法清除 API Key，请检查浏览器存储权限。', error: true };
  }
}

async function testConnection() {
  const current = account.value;
  const id = selectedProvider.value;
  if (!current || !id || testing.value) return;
  const { signal } = (testRequest = new AbortController());
  const chosenModel = model.value;
  notice.value = undefined;
  testing.value = true;
  try {
    const key = apiKey.value.trim() || (await readTranslationApiKey(current, id));
    signal.throwIfAborted();
    if (!key) throw Error('请输入 API Key。');
    const provider: SelectionTranslationProvider =
      id === 'deepseek' ? { id, apiKey: key, model: chosenModel } : { id, apiKey: key };
    const result = await translateWithService(
      'The lattice parameter increases with temperature.',
      'zh',
      signal,
      provider,
    );
    if (!signal.aborted) notice.value = { text: '连接成功 · ' + result };
  } catch (error) {
    if (!signal.aborted)
      notice.value = { text: error instanceof Error ? error.message : '测试失败，请重试。', error: true };
  } finally {
    if (testRequest?.signal === signal) testing.value = false;
  }
}

const canSave = computed(
  () =>
    !!apiKey.value.trim() ||
    (savedKey.value &&
      selectedProvider.value === 'deepseek' &&
      model.value !== translationSettings.value.deepseekModel),
);
</script>

<template>
  <div class="translation-settings">
    <section class="translation-settings-intro" aria-labelledby="translation-settings-title">
      <div>
        <span class="translation-settings-icon" aria-hidden="true"><Icon name="translate" :size="28" /></span>
        <h2 id="translation-settings-title">翻译设置</h2>
      </div>
      <p>选择消息中的文字，即可翻译为中文或英语。</p>
    </section>

    <label class="translation-settings-toggle">
      <span class="translation-settings-icon"><Icon name="translate" :size="22" /></span>
      <span class="translation-settings-copy">
        <strong id="translation-settings-enabled">启用划词翻译</strong>
        <small id="translation-settings-enabled-description">在工作台和即时消息中显示翻译入口</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-labelledby="translation-settings-enabled"
        aria-describedby="translation-settings-enabled-description"
        :checked="translationSettings.enabled"
        @change="toggleTranslation"
      />
    </label>

    <fieldset class="translation-settings-engines">
      <legend>翻译引擎</legend>
      <div class="translation-settings-list">
        <label
          v-for="engine in engines"
          :key="engine.id"
          :data-selected="translationSettings.engine === engine.id"
        >
          <span class="translation-settings-icon"><Icon :name="engine.icon" :size="21" /></span>
          <span class="translation-settings-copy">
            <strong :id="'translation-engine-' + engine.id">{{ engine.title }}</strong>
            <small :id="'translation-engine-help-' + engine.id">{{ engine.detail }}</small>
          </span>
          <input
            type="radio"
            name="translation-engine"
            :value="engine.id"
            :aria-labelledby="'translation-engine-' + engine.id"
            :aria-describedby="'translation-engine-help-' + engine.id"
            :checked="translationSettings.engine === engine.id"
            @change="chooseEngine($event, engine.id)"
          />
        </label>
      </div>
    </fieldset>

    <form v-if="selectedProvider && account" class="translation-settings-form" @submit.prevent="save">
      <section class="translation-settings-config" aria-labelledby="translation-settings-provider">
        <header>
          <h3 id="translation-settings-provider">{{ providerName }} 配置</h3>
          <span v-if="savedKey" class="translation-settings-saved"
            ><Icon name="check" :size="14" /> API Key 已保存</span
          >
        </header>
        <div class="translation-settings-fields" :class="{ 'has-model': selectedProvider === 'deepseek' }">
          <div class="translation-settings-field">
            <label for="translation-settings-api-key">API Key</label>
            <span class="translation-settings-password">
              <input
                id="translation-settings-api-key"
                v-model="apiKey"
                :type="reveal ? 'text' : 'password'"
                :placeholder="savedKey ? '输入新密钥以替换' : '输入 API Key'"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                maxlength="512"
                :disabled="testing || saving"
              />
              <button
                type="button"
                :aria-label="reveal ? '隐藏 API Key' : '显示 API Key'"
                @click="reveal = !reveal"
              >
                <Icon :name="reveal ? 'eyeOff' : 'eye'" :size="18" />
              </button>
            </span>
          </div>
          <div v-if="selectedProvider === 'deepseek'" class="translation-settings-field">
            <label for="translation-settings-model">模型</label>
            <span class="translation-settings-select">
              <select id="translation-settings-model" v-model="model" :disabled="testing || saving">
                <option v-for="name in DEEPSEEK_TRANSLATION_MODELS" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
              <Icon name="down" :size="16" />
            </span>
          </div>
        </div>
        <p class="translation-settings-privacy">
          <Icon name="shield" :size="18" />
          <span
            >密钥在当前浏览器按账户加密保存。点击翻译后，所选原文和密钥会经站点发送给
            {{ providerName }}。</span
          >
        </p>
        <p v-if="selectedProvider === 'niutrans'" class="translation-settings-attribution">
          由小牛翻译提供技术支持
        </p>
      </section>
      <div class="translation-settings-actions">
        <button
          v-if="savedKey"
          class="translation-settings-remove"
          type="button"
          :disabled="testing || saving"
          @click="removeKey"
        >
          清除 API Key
        </button>
        <button
          class="secondary"
          type="button"
          :disabled="testing || saving || (!apiKey.trim() && !savedKey)"
          @click="testConnection"
        >
          {{ testing ? '正在测试…' : '测试连接' }}
        </button>
        <button class="primary" type="submit" :disabled="testing || saving || !canSave">
          {{ saving ? '正在保存…' : '保存配置' }}
        </button>
      </div>
    </form>
    <section v-else-if="selectedProvider" class="translation-settings-config translation-settings-login">
      <div>
        <h3>{{ providerName }} 配置</h3>
        <p>登录个人账户后可保存和使用 API Key。</p>
      </div>
      <button type="button" class="secondary" @click="$emit('login')">前往登录</button>
    </section>
    <p v-else-if="translationSettings.engine === 'site'" class="translation-settings-privacy" role="status">
      <Icon name="globe" :size="18" />
      {{
        !account
          ? '登录后可使用站点翻译。'
          : siteStatus === 'checking'
            ? '正在检查站点翻译…'
            : siteStatus === 'available'
              ? '站点翻译可用。'
              : '该站点的 LibreTranslate 暂不可用。'
      }}
    </p>
    <p
      v-if="notice"
      class="translation-settings-notice"
      :class="{ 'is-error': notice.error }"
      :role="notice.error ? 'alert' : 'status'"
    >
      {{ notice.text }}
    </p>
  </div>
</template>

<style src="./translation-settings.css"></style>
