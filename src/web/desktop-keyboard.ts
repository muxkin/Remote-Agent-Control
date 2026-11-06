import { useSyncExternalStore } from 'react';

// A small desktop window is still a desktop. Touch-first devices keep native Enter behavior.
const desktop = window.matchMedia('(hover: hover) and (pointer: fine)');
const subscribe = (listener: () => void) => {
  desktop.addEventListener('change', listener);
  return () => desktop.removeEventListener('change', listener);
};
export function useDesktopKeyboard() {
  return useSyncExternalStore(subscribe, () => desktop.matches);
}
