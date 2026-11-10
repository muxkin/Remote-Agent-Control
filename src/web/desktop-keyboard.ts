import { onMounted, onScopeDispose, shallowRef } from 'vue';

// A small desktop window is still a desktop. Touch-first devices keep native Enter behavior.
const desktop = window.matchMedia('(hover: hover) and (pointer: fine)');
export function useDesktopKeyboard() {
  const matches = shallowRef(desktop.matches);
  const update = () => {
    matches.value = desktop.matches;
  };
  onMounted(() => {
    desktop.addEventListener('change', update);
    update();
  });
  onScopeDispose(() => desktop.removeEventListener('change', update));
  return matches;
}
