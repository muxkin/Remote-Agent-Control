import { shallowRef, watch } from 'vue';

export function useVisible() {
  const ref = shallowRef<HTMLDivElement | null>(null);
  const visible = shallowRef(false);
  watch(
    ref,
    (element, _, onCleanup) => {
      if (!element || visible.value) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            visible.value = true;
            observer.disconnect();
          }
        },
        { rootMargin: '200px' },
      );
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    },
    { flush: 'post' },
  );
  return { ref, visible };
}
