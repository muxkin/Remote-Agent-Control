import type { VNode } from 'vue';

declare module '@vue/runtime-dom' {
  interface HTMLAttributes {
    onVnodeMounted?: (node: VNode) => void;
    popover?: 'auto' | 'manual' | 'hint';
  }
  interface ButtonHTMLAttributes {
    popovertarget?: string;
    popovertargetaction?: 'hide' | 'show' | 'toggle';
  }
}
