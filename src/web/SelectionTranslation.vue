<script setup lang="ts">
import { onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { SELECTION_TRANSLATION_MAX_LENGTH } from '../shared/selection-translation';
import { Icon } from './Icon';
import { messaging, useMessaging } from './messaging/context';
import {
  defaultTranslationTarget,
  externalTranslationUrl,
  translateOnDevice,
  translateWithService,
  translationServiceAvailable,
  type TranslationTarget,
} from './selection-translation-client';
import {
  hasTranslationApiKey,
  readTranslationApiKey,
  translationSettings,
  type CloudTranslationEngine,
} from './selection-translation-settings';

defineEmits<{ settings: [] }>();

type TranslationMethod = 'device' | 'site' | CloudTranslationEngine;
const providerLabel = { niutrans: '小牛翻译', deepseek: 'DeepSeek' } as const;
const methodLabel: Record<TranslationMethod, string> = {
  device: '设备内翻译',
  site: '站点翻译',
  niutrans: '由小牛翻译提供技术支持',
  deepseek: 'DeepSeek AI 翻译',
};
const accountState = useMessaging();

function currentTranslationAccount() {
  const { user } = accountState;
  const { secrets } = messaging.account;
  if (user?.kind === 'human' && messaging.account.user?.id === user.id && secrets)
    return { id: user.id, secrets };
}

interface SelectionAnchor {
  text: string;
  range: Range;
  source: Element;
  left: number;
  top: number;
  below: boolean;
}

type TranslationState =
  | { status: 'loading' }
  | { status: 'fallback'; site: boolean; error?: string }
  | { status: 'cloud'; provider: CloudTranslationEngine; configured: boolean; error?: string }
  | { status: 'result'; text: string; method: TranslationMethod }
  | { status: 'too-long' };

const anchor = shallowRef<SelectionAnchor>();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLDialogElement>();
const panelBody = ref<HTMLElement>();
const activeSelection = shallowRef<SelectionAnchor>();
const titleId = useId();
const narrow = matchMedia('(max-width: 700px)');
const sheet = ref(narrow.matches);
const original = ref('');
const target = ref<TranslationTarget>('zh');
const translation = shallowRef<TranslationState>({ status: 'loading' });
const copyStatus = ref('');
let request: AbortController | undefined;
let frame = 0;
let pointerDown = false;
let touchSelection = false;
let previousFocus: Element | null = null;
let sheetScroll: { element: HTMLElement; previousTop: number; appliedTop: number } | undefined;
const highlightName = 'selection-translation';

watch([() => translationSettings.value.engine, () => translationSettings.value.deepseekModel], () => {
  if (activeSelection.value) close(false);
});

function sourceOf(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  if (element?.closest('button, input, textarea, [contenteditable], [role="textbox"]')) return null;
  return element?.closest('[data-selection-translation]');
}

function viewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function visibleSelection(range: Range, source: Element, viewport: ReturnType<typeof viewportBounds>) {
  if (!source.isConnected || !source.contains(range.commonAncestorContainer)) return;
  const scroll = source.closest('.transcript, .im-transcript')?.getBoundingClientRect();
  const left = Math.max(viewport.left, scroll?.left ?? viewport.left);
  const top = Math.max(viewport.top, scroll?.top ?? viewport.top);
  const right = Math.min(viewport.right, scroll?.right ?? viewport.right);
  const bottom = Math.min(viewport.bottom, scroll?.bottom ?? viewport.bottom);
  const lines = [...range.getClientRects()].filter(
    (line) =>
      line.width > 0 && line.right > left && line.left < right && line.bottom > top && line.top < bottom,
  );
  if (!lines.length) return;
  const bounds = range.getBoundingClientRect();
  return {
    top: Math.max(top, bounds.top),
    bottom: Math.min(bottom, bounds.bottom),
    first: lines[0],
    last: lines[lines.length - 1],
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

function readAnchor(): SelectionAnchor | undefined {
  if (activeSelection.value || document.querySelector('dialog[open]')) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const source = sourceOf(selection.anchorNode);
  if (!source || source !== sourceOf(selection.focusNode)) return;
  const text = selection.toString().trim();
  if (!/\p{L}/u.test(text)) return;
  const range = selection.getRangeAt(0);
  const viewport = viewportBounds();
  const visible = visibleSelection(range, source, viewport);
  if (!visible) return;

  const height = 44;
  const aboveTop = visible.top - height - 10;
  const belowTop = visible.bottom + 10;
  const below = aboveTop < viewport.top + 8 || (touchSelection && belowTop + height <= viewport.bottom - 8);
  const line = below ? visible.last : visible.first;
  return {
    text,
    range,
    source,
    below,
    left: clamp((line.left + line.right) / 2, viewport.left + 55, viewport.right - 55),
    top: clamp(below ? belowTop : aboveTop, viewport.top + 8, viewport.bottom - height - 8),
  };
}

function revealSelectionAboveSheet(element: HTMLDialogElement, selected: SelectionAnchor) {
  const scroll = selected.source.closest<HTMLElement>('.transcript, .im-transcript');
  if (!scroll || !scroll.contains(selected.range.commonAncestorContainer)) return;
  const scrollBounds = scroll.getBoundingClientRect();
  const selection = selected.range.getBoundingClientRect();
  const visibleBottom = Math.min(scrollBounds.bottom, element.getBoundingClientRect().top);
  if (selection.bottom <= visibleBottom - 14 || visibleBottom <= scrollBounds.top + 32) return;
  const current = scroll.scrollTop;
  const next = current + selection.bottom - visibleBottom + 14;
  if (!sheetScroll) sheetScroll = { element: scroll, previousTop: current, appliedTop: current };
  const extra = next - (scroll.scrollHeight - scroll.clientHeight);
  if (extra > 0) {
    const existing = Number.parseFloat(scroll.style.getPropertyValue('--translation-scroll-space')) || 0;
    scroll.style.setProperty('--translation-scroll-space', `${Math.ceil(existing + extra)}px`);
  }
  scroll.scrollTo({ top: next, behavior: 'instant' });
  sheetScroll.appliedTop = scroll.scrollTop;
}

function restoreSheetScroll() {
  if (!sheetScroll) return;
  const { element, appliedTop, previousTop } = sheetScroll;
  sheetScroll = undefined;
  const shouldRestore = Math.abs(element.scrollTop - appliedTop) < 2;
  element.style.removeProperty('--translation-scroll-space');
  if (shouldRestore) element.scrollTo({ top: previousTop, behavior: 'instant' });
}

function positionPanel() {
  const element = panel.value;
  const selected = activeSelection.value;
  if (!element?.open || !selected) return;
  const viewport = viewportBounds();
  const style = element.style;
  if (sheet.value) {
    style.setProperty('--translation-left', `${viewport.left}px`);
    style.setProperty('--translation-width', `${viewport.width}px`);
    style.setProperty('--translation-bottom', `${window.innerHeight - viewport.bottom}px`);
    style.setProperty('--translation-max-height', `${viewport.height * 0.8}px`);
    revealSelectionAboveSheet(element, selected);
    return;
  }
  const visible = visibleSelection(selected.range, selected.source, viewport);
  if (!visible) {
    close(false);
    return;
  }
  const inset = 12;
  const gap = 11;
  const below = viewport.bottom - visible.bottom - inset - gap;
  const above = visible.top - viewport.top - inset - gap;
  style.setProperty('--translation-width', `${Math.min(420, viewport.width - inset * 2)}px`);
  const body = panelBody.value;
  const naturalHeight = element.offsetHeight + (body ? body.scrollHeight - body.clientHeight : 0);
  const transcriptBottom = selected.source
    .closest('.transcript, .im-transcript')
    ?.getBoundingClientRect().bottom;
  const roomBeforeComposer = (transcriptBottom ?? viewport.bottom) - visible.bottom - gap;
  const placeBelow = below >= naturalHeight && (roomBeforeComposer >= naturalHeight || above < naturalHeight);
  const preferBelow = placeBelow || (above < naturalHeight && below > above);
  style.setProperty('--translation-max-height', `${Math.max(116, preferBelow ? below : above)}px`);
  const { width, height } = element.getBoundingClientRect();
  const line = preferBelow ? visible.last : visible.first;
  const center = (line.left + line.right) / 2;
  const left = clamp(center - width / 2, viewport.left + inset, viewport.right - inset - width);
  const top = clamp(
    preferBelow ? visible.bottom + gap : visible.top - height - gap,
    viewport.top + inset,
    viewport.bottom - inset - height,
  );
  style.setProperty('--translation-left', `${left}px`);
  style.setProperty('--translation-top', `${top}px`);
  style.setProperty('--translation-caret', `${clamp(center - left, 22, width - 22)}px`);
  element.dataset.side = preferBelow ? 'below' : 'above';
}

function refreshAnchor() {
  if (pointerDown || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (activeSelection.value) positionPanel();
    else if (!pointerDown) anchor.value = readAnchor();
  });
}

function startPointer(event: PointerEvent) {
  pointerDown = true;
  if (event.target instanceof Node && trigger.value?.contains(event.target)) return;
  if (
    activeSelection.value &&
    !sheet.value &&
    event.target instanceof Node &&
    !panel.value?.contains(event.target)
  )
    close(false);
  touchSelection = event.pointerType === 'touch';
  anchor.value = undefined;
}

function endPointer() {
  pointerDown = false;
  refreshAnchor();
}

function dismissOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const focusedDialog = event.target instanceof Element && event.target.closest('dialog[open]');
  if (focusedDialog && focusedDialog !== panel.value) return;
  if (activeSelection.value && !sheet.value) {
    event.preventDefault();
    close();
  } else anchor.value = undefined;
}

const listeners = new AbortController();
onMounted(() => {
  const options = { signal: listeners.signal };
  document.addEventListener('selectionchange', refreshAnchor, options);
  document.addEventListener('pointerdown', startPointer, { ...options, capture: true });
  window.addEventListener('pointerup', endPointer, { ...options, capture: true });
  window.addEventListener('pointercancel', endPointer, { ...options, capture: true });
  document.addEventListener('keydown', dismissOnEscape, options);
  document.addEventListener('scroll', refreshAnchor, { ...options, capture: true, passive: true });
  window.addEventListener('resize', refreshAnchor, options);
  window.visualViewport?.addEventListener('resize', refreshAnchor, options);
  window.visualViewport?.addEventListener('scroll', refreshAnchor, options);
  narrow.addEventListener('change', (event) => (sheet.value = event.matches), options);
});
onScopeDispose(() => {
  listeners.abort();
  request?.abort();
  cancelAnimationFrame(frame);
  restoreSheetScroll();
  if (activeSelection.value) CSS.highlights?.delete(highlightName);
});

watch(
  [panel, sheet],
  ([element, mobile], _, cleanup) => {
    if (!element) return;
    if (mobile) element.showModal();
    else element.show();
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    observer.observe(element);
    cleanup(() => {
      observer.disconnect();
      element.close();
      if (mobile) restoreSheetScroll();
    });
  },
  { flush: 'post' },
);

function close(restoreFocus = true) {
  request?.abort();
  CSS.highlights?.delete(highlightName);
  panel.value?.close();
  restoreSheetScroll();
  activeSelection.value = undefined;
  original.value = '';
  translation.value = { status: 'loading' };
  copyStatus.value = '';
  if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.isConnected)
    previousFocus.focus({ preventScroll: true });
  previousFocus = null;
}

function open() {
  const selected = anchor.value;
  if (!selected) return;
  previousFocus = document.activeElement;
  const range = selected.range.cloneRange();
  activeSelection.value = { ...selected, range };
  if (typeof Highlight === 'function') CSS.highlights?.set(highlightName, new Highlight(range));
  original.value = selected.text;
  target.value = defaultTranslationTarget(selected.text);
  anchor.value = undefined;
  window.getSelection()?.removeAllRanges();
  void prepareTranslation();
}

function onBackdrop(event: MouseEvent) {
  if (!sheet.value || event.target !== panel.value) return;
  const { left, right, top, bottom } = panel.value.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) close();
}

async function prepareTranslation() {
  request?.abort();
  copyStatus.value = '';
  const text = original.value;
  if (text.length > SELECTION_TRANSLATION_MAX_LENGTH) {
    translation.value = { status: 'too-long' };
    return;
  }
  const { engine } = translationSettings.value;
  if (engine === 'niutrans' || engine === 'deepseek') {
    const account = currentTranslationAccount();
    translation.value = {
      status: 'cloud',
      provider: engine,
      configured: !!account && hasTranslationApiKey(account.id, engine),
    };
    return;
  }
  const language = target.value;
  const { signal } = (request = new AbortController());
  translation.value = { status: 'loading' };
  if (engine !== 'site') {
    try {
      const result = await translateOnDevice(text, language, signal);
      if (signal.aborted) return;
      if (result) {
        translation.value = { status: 'result', text: result, method: 'device' };
        return;
      }
    } catch {
      if (signal.aborted) return;
    }
  }
  const site = engine !== 'device' && (await translationServiceAvailable(signal).catch(() => false));
  if (!signal.aborted)
    translation.value = {
      status: 'fallback',
      site,
      ...(engine === 'site' && !site && { error: '站点翻译暂不可用。' }),
    };
}

async function runCloudTranslation(method: 'site' | CloudTranslationEngine) {
  request?.abort();
  const { signal } = (request = new AbortController());
  const text = original.value;
  const language = target.value;
  const model = translationSettings.value.deepseekModel;
  const previous = translation.value;
  translation.value = { status: 'loading' };
  try {
    let provider;
    if (method !== 'site') {
      const account = currentTranslationAccount();
      if (!account) throw Error('请先登录个人账户。');
      const apiKey = await readTranslationApiKey(account, method);
      signal.throwIfAborted();
      if (!apiKey) throw Error('请先在设置中保存 API Key。');
      provider =
        method === 'deepseek' ? ({ id: method, apiKey, model } as const) : ({ id: method, apiKey } as const);
    }
    const result = await translateWithService(text, language, signal, provider);
    if (!signal.aborted) translation.value = { status: 'result', text: result, method };
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof Error ? error.message : '翻译失败，请重试。';
    translation.value =
      previous.status === 'cloud'
        ? { ...previous, error: message }
        : { status: 'fallback', site: true, error: message };
  }
}

function changeTarget(event: Event) {
  target.value = (event.target as HTMLSelectElement).value as TranslationTarget;
  void prepareTranslation();
}

async function copyTranslation() {
  const result = translation.value;
  if (result.status !== 'result') return;
  try {
    await navigator.clipboard.writeText(result.text);
    if (translation.value === result) copyStatus.value = '已复制';
  } catch {
    if (translation.value === result) copyStatus.value = '请选中译文手动复制';
  }
}
</script>

<template>
  <Teleport to="body">
    <button
      v-if="anchor"
      ref="trigger"
      type="button"
      class="selection-translation-trigger"
      :data-side="anchor.below ? 'below' : 'above'"
      aria-haspopup="dialog"
      :style="{ left: `${anchor.left}px`, top: `${anchor.top}px` }"
      @mousedown.prevent
      @click="open"
    >
      <Icon name="translate" :size="16" />
      翻译
    </button>
    <dialog
      v-if="original"
      ref="panel"
      class="selection-translation-panel"
      :class="{ 'selection-translation-sheet': sheet }"
      :aria-labelledby="titleId"
      @cancel.prevent="close()"
      @click="onBackdrop"
    >
      <div class="selection-translation-content">
        <header class="selection-translation-header">
          <span class="selection-translation-mark" aria-hidden="true"
            ><Icon name="translate" :size="19"
          /></span>
          <h2 :id="titleId">划词翻译</h2>
          <span v-if="translation.status !== 'too-long'" class="selection-translation-language">
            <select aria-label="目标语言" :value="target" @change="changeTarget">
              <option value="zh">简体中文</option>
              <option value="en">英语</option>
            </select>
            <Icon name="down" :size="14" />
          </span>
          <button
            type="button"
            class="selection-translation-close"
            aria-label="关闭"
            autofocus
            @click="close()"
          >
            <Icon name="close" :size="18" />
          </button>
        </header>
        <div class="selection-translation-original">
          <span>原文</span>
          <p>
            {{ original.length > SELECTION_TRANSLATION_MAX_LENGTH ? `${original.slice(0, 180)}…` : original }}
          </p>
        </div>
        <div ref="panelBody" class="selection-translation-body">
          <p v-if="translation.status === 'loading'" class="selection-translation-status" role="status">
            <span class="selection-translation-spinner" aria-hidden="true"></span>
            正在翻译…
          </p>
          <p v-else-if="translation.status === 'too-long'" class="selection-translation-status" role="status">
            每次最多翻译 {{ SELECTION_TRANSLATION_MAX_LENGTH }} 个字符，请缩小选择范围。
          </p>
          <template v-else-if="translation.status === 'result'">
            <div class="selection-translation-result" role="status">
              <span>译文</span>
              <p :lang="target === 'zh' ? 'zh-CN' : 'en'">{{ translation.text }}</p>
            </div>
            <footer class="selection-translation-footer">
              <span class="selection-translation-source">
                <Icon :name="translation.method === 'device' ? 'shield' : 'globe'" :size="16" />
                {{ methodLabel[translation.method] }}
              </span>
              <button
                type="button"
                class="selection-translation-action"
                aria-label="复制译文"
                @click="copyTranslation"
              >
                <Icon :name="copyStatus === '已复制' ? 'check' : 'copy'" :size="16" />
                {{ copyStatus === '已复制' ? '已复制' : '复制译文' }}
              </button>
              <span
                v-if="copyStatus"
                class="selection-translation-copy-status"
                role="status"
                :data-copied="copyStatus === '已复制'"
              >
                {{ copyStatus }}
              </span>
            </footer>
          </template>
          <template v-else-if="translation.status === 'cloud'">
            <div class="selection-translation-fallback">
              <p v-if="translation.error" role="alert">{{ translation.error }}</p>
              <p v-else-if="!translation.configured">
                请登录并在设置中保存 {{ providerLabel[translation.provider] }} 的 API Key。
              </p>
              <p v-else>使用 {{ providerLabel[translation.provider] }} 翻译</p>
              <p v-if="translation.configured" class="hint">
                继续后，所选原文会发送给 {{ providerLabel[translation.provider] }}。
              </p>
            </div>
            <div class="selection-translation-fallback-actions">
              <button
                v-if="translation.configured"
                type="button"
                class="selection-translation-action"
                @click="runCloudTranslation(translation.provider)"
              >
                使用 {{ providerLabel[translation.provider] }} 翻译
              </button>
              <button v-else type="button" class="selection-translation-action" @click="$emit('settings')">
                打开翻译设置
              </button>
            </div>
          </template>
          <template v-else>
            <div class="selection-translation-fallback">
              <p v-if="translation.error" role="alert">{{ translation.error }}</p>
              <p v-else role="status">
                {{ translationSettings.engine === 'site' ? '使用站点翻译' : '设备内翻译暂不可用' }}
              </p>
              <p class="hint">
                {{
                  translation.site
                    ? '使用站点翻译或打开 Google 翻译会将原文发送给相应的服务。'
                    : '打开 Google 翻译会将原文发送给 Google。'
                }}
              </p>
            </div>
            <div class="selection-translation-fallback-actions">
              <button
                v-if="translation.site"
                type="button"
                class="selection-translation-action"
                @click="runCloudTranslation('site')"
              >
                使用站点翻译
              </button>
              <a :href="externalTranslationUrl(original, target)" target="_blank" rel="noopener noreferrer">
                在 Google 翻译中打开 <Icon name="external" :size="14" />
              </a>
            </div>
          </template>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style src="./selection-translation.css"></style>
