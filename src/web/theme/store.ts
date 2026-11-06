import { useSyncExternalStore } from 'react';
import {
  defaults,
  parseAppearance,
  selectedTheme,
  STORAGE_KEY,
  themeTokens,
  type Appearance,
  type ColorMode,
} from './palette';

function read(): Appearance {
  try {
    return parseAppearance(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return { ...defaults, customThemes: [] };
  }
}
const system = window.matchMedia('(prefers-color-scheme: dark)');
let settings = read();
let snapshot = { settings, resolved: resolveMode(settings) };
const listeners = new Set<() => void>();
function resolveMode(value: Appearance): ColorMode {
  return value.mode === 'system' ? (system.matches ? 'dark' : 'light') : value.mode;
}
function apply() {
  const mode = resolveMode(settings);
  const theme = selectedTheme(settings, mode);
  for (const [key, value] of Object.entries(themeTokens(theme)))
    document.documentElement.style.setProperty(key, value);
  document.documentElement.dataset.colorMode = mode;
  document.documentElement.dataset.theme = theme.id;
  document.documentElement.style.colorScheme = mode;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', themeTokens(theme)['--surface']);
  snapshot = { settings, resolved: mode };
  listeners.forEach((listener) => listener());
}
export function updateAppearance(next: Appearance) {
  const clean = parseAppearance(next);
  // Save first: a storage failure leaves the selected theme unchanged and can be reported by the UI.
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...clean,
      paint: {
        light: themeTokens(selectedTheme(clean, 'light')),
        dark: themeTokens(selectedTheme(clean, 'dark')),
      },
    }),
  );
  settings = clean;
  apply();
}
export function initializeAppearance() {
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      settings = read();
      apply();
    }
  });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => snapshot;
export function useAppearance() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
