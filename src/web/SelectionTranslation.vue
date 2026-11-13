<script setup lang="ts">
import { onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { SELECTION_TRANSLATION_MAX_LENGTH } from '../shared/selection-translation';
import { Icon } from './Icon';
import { Dialog } from './shell/Dialog';
import {
  defaultTranslationTarget,
  externalTranslationUrl,
  translateOnDevice,
  translateWithService,
  translationServiceAvailable,
  type TranslationTarget,
} from './selection-translation-client';

interface SelectionAnchor {
  text: string;
  left: number;
  top: number;
}

type TranslationState =
  | { status: 'loading' }
  | { status: 'fallback'; service: boolean; error?: string }
  | { status: 'result'; text: string }
  | { status: 'too-long' };

const anchor = shallowRef<SelectionAnchor>();
const trigger = ref<HTMLButtonElement>();
const original = ref('');
const target = ref<TranslationTarget>('zh');
const translation = shallowRef<TranslationState>({ status: 'loading' });
const copyStatus = ref('');
let request: AbortController | undefined;
let frame = 0;
let pointerDown = false;
let touchSelection = false;

function sourceOf(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement;
  if (element?.closest('button, input, textarea, [contenteditable], [role="textbox"]')) return null;
  return element?.closest('[data-selection-translation]');
}

function readAnchor(): SelectionAnchor | undefined {
  if (original.value || document.querySelector('dialog[open]')) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const source = sourceOf(selection.anchorNode);
  if (!source || source !== sourceOf(selection.focusNode)) return;
  const text = selection.toString().trim();
  if (!/\p{L}/u.test(text)) return;

  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
  const scroller = source.closest('.transcript, .im-transcript')?.getBoundingClientRect();
  const left = Math.max(viewportLeft, scroller?.left ?? viewportLeft);
  const top = Math.max(viewportTop, scroller?.top ?? viewportTop);
  const right = Math.min(viewportRight, scroller?.right ?? viewportRight);
  const bottom = Math.min(viewportBottom, scroller?.bottom ?? viewportBottom);
  const range = selection.getRangeAt(0);
  const lines = [...range.getClientRects()].filter(
    (line) =>
      line.width > 0 && line.right > left && line.left < right && line.bottom > top && line.top < bottom,
  );
  if (!lines.length) return;
  const backwards =
    selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
  const line = backwards ? lines[0] : lines[lines.length - 1];
  const bounds = range.getBoundingClientRect();
  const above = Math.max(top, bounds.top) - 52;
  const below = Math.min(bottom, bounds.bottom) + 9;
  const y =
    touchSelection && below + 44 <= viewportBottom - 8 ? below : above >= viewportTop + 8 ? above : below;
  return {
    text,
    left: Math.max(viewportLeft + 50, Math.min(viewportRight - 50, (line.left + line.right) / 2)),
    top: Math.max(viewportTop + 8, Math.min(viewportBottom - 52, y)),
  };
}

function refreshAnchor() {
  if (pointerDown || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!pointerDown) anchor.value = readAnchor();
  });
}

function startPointer(event: PointerEvent) {
  pointerDown = true;
  if (event.target instanceof Node && trigger.value?.contains(event.target)) return;
  touchSelection = event.pointerType === 'touch';
  anchor.value = undefined;
}

function endPointer() {
  pointerDown = false;
  refreshAnchor();
}

function dismissTrigger(event: KeyboardEvent) {
  if (event.key === 'Escape') anchor.value = undefined;
}

const listeners = new AbortController();
onMounted(() => {
  const options = { signal: listeners.signal };
  document.addEventListener('selectionchange', refreshAnchor, options);
  document.addEventListener('pointerdown', startPointer, { ...options, capture: true });
  window.addEventListener('pointerup', endPointer, { ...options, capture: true });
  window.addEventListener('pointercancel', endPointer, { ...options, capture: true });
  document.addEventListener('keydown', dismissTrigger, options);
  document.addEventListener('scroll', refreshAnchor, { ...options, capture: true, passive: true });
  window.addEventListener('resize', refreshAnchor, options);
  window.visualViewport?.addEventListener('resize', refreshAnchor, options);
  window.visualViewport?.addEventListener('scroll', refreshAnchor, options);
});
onScopeDispose(() => {
  listeners.abort();
  request?.abort();
  cancelAnimationFrame(frame);
});

function close() {
  request?.abort();
  original.value = '';
  translation.value = { status: 'loading' };
  copyStatus.value = '';
}

function open() {
  const text = anchor.value?.text;
  if (!text) return;
  original.value = text;
  target.value = defaultTranslationTarget(text);
  anchor.value = undefined;
  window.getSelection()?.removeAllRanges();
  void runTranslation('device');
}

async function runTranslation(method: 'device' | 'service') {
  request?.abort();
  copyStatus.value = '';
  const text = original.value;
  if (text.length > SELECTION_TRANSLATION_MAX_LENGTH) {
    translation.value = { status: 'too-long' };
    return;
  }
  const language = target.value;
  const { signal } = (request = new AbortController());
  translation.value = { status: 'loading' };
  if (method === 'service') {
    try {
      const result = await translateWithService(text, language, signal);
      if (!signal.aborted) translation.value = { status: 'result', text: result };
    } catch {
      if (!signal.aborted)
        translation.value = { status: 'fallback', service: true, error: '站点翻译暂时失败，请重试。' };
    }
    return;
  }
  try {
    const result = await translateOnDevice(text, language, signal);
    if (signal.aborted) return;
    if (result) {
      translation.value = { status: 'result', text: result };
      return;
    }
  } catch {
    if (signal.aborted) return;
  }
  const service = await translationServiceAvailable(signal).catch(() => false);
  if (!signal.aborted) translation.value = { status: 'fallback', service };
}

function changeTarget(event: Event) {
  target.value = (event.target as HTMLSelectElement).value as TranslationTarget;
  void runTranslation('device');
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
      aria-haspopup="dialog"
      :style="{ left: `${anchor.left}px`, top: `${anchor.top}px` }"
      @mousedown.prevent
      @click="open"
    >
      翻译
    </button>
  </Teleport>
  <Dialog v-if="original" title="划词翻译" @close="close">
    <div class="selection-translation-content">
      <div class="selection-translation-original" aria-label="原文">
        {{ original.length > SELECTION_TRANSLATION_MAX_LENGTH ? `${original.slice(0, 180)}…` : original }}
      </div>
      <label class="selection-translation-language">
        目标语言
        <select :value="target" @change="changeTarget">
          <option value="zh">简体中文</option>
          <option value="en">英语</option>
        </select>
      </label>
      <p v-if="translation.status === 'loading'" role="status">正在翻译…</p>
      <p v-else-if="translation.status === 'too-long'" role="status">
        每次最多翻译 {{ SELECTION_TRANSLATION_MAX_LENGTH }} 个字符，请缩小选择范围。
      </p>
      <template v-else-if="translation.status === 'result'">
        <div class="selection-translation-result" role="status" :lang="target === 'zh' ? 'zh-CN' : 'en'">
          {{ translation.text }}
        </div>
        <div class="selection-translation-actions">
          <button type="button" class="secondary" @click="copyTranslation">
            <Icon name="copy" :size="16" /> 复制译文
          </button>
          <span role="status">{{ copyStatus }}</span>
        </div>
      </template>
      <template v-else>
        <p v-if="translation.error" role="alert">{{ translation.error }}</p>
        <p v-else role="status">设备内翻译暂不可用。</p>
        <p class="hint">
          {{
            translation.service
              ? '使用站点翻译或打开 Google 翻译会将原文发送给相应的服务。'
              : '打开 Google 翻译会将原文发送给 Google。'
          }}
        </p>
        <div class="selection-translation-actions">
          <button
            v-if="translation.service"
            type="button"
            class="secondary"
            @click="runTranslation('service')"
          >
            使用站点翻译
          </button>
          <a :href="externalTranslationUrl(original, target)" target="_blank" rel="noopener noreferrer">
            在 Google 翻译中打开
          </a>
        </div>
      </template>
    </div>
  </Dialog>
</template>

<style src="./selection-translation.css"></style>
