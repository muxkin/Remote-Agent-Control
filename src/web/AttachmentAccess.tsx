import { computed, defineComponent, inject, provide, toRef, type InjectionKey, type Ref } from 'vue';

export interface AttachmentResource {
  url: string;
  blob?: Blob;
  name: string;
  mime: string;
  size: number;
  expiresAt: number;
  downloadUrl?: string;
  width?: number;
  height?: number;
}
/** Presentation stays shared; the owning module supplies its own authorization and transport. */
export interface AttachmentAccess {
  load(threadId: string, path: string, signal?: AbortSignal, fullSize?: boolean): Promise<AttachmentResource>;
}
const attachmentAccessKey: InjectionKey<Readonly<Ref<AttachmentAccess | null>>> = Symbol('attachment-access');

export const AttachmentAccessProvider = defineComponent(
  (props: { value: AttachmentAccess }, { slots }) => {
    provide(
      attachmentAccessKey,
      toRef(() => props.value),
    );
    return () => slots.default?.();
  },
  { props: ['value'] },
);

export function useAttachmentAccess() {
  return inject(attachmentAccessKey, () => computed(() => null), true);
}
