import { argbFromHex, hexFromArgb, Hct, SchemeTonalSpot } from '@material/material-color-utilities';

export type ColorMode = 'light' | 'dark';
export type AppearanceMode = ColorMode | 'system';
export interface Theme {
  id: string;
  name: string;
  mode: ColorMode;
  seed: string;
}
export interface Appearance {
  version: 1;
  mode: AppearanceMode;
  light: string;
  dark: string;
  customThemes: Theme[];
}
export const STORAGE_KEY = 'pocket-appearance-v1';
export const MAX_CUSTOM_THEMES = 40;
export const presets: readonly Theme[] = [
  { id: 'jade-light', name: '青竹', mode: 'light', seed: '#197b66' },
  { id: 'blue-light', name: '晴空', mode: 'light', seed: '#4263a8' },
  { id: 'jade-dark', name: '墨绿', mode: 'dark', seed: '#197b66' },
  { id: 'blue-dark', name: '深海', mode: 'dark', seed: '#4263a8' },
];
export const defaults: Appearance = {
  version: 1,
  mode: 'system',
  light: 'jade-light',
  dark: 'jade-dark',
  customThemes: [],
};
const hex = /^#[0-9a-f]{6}$/i;
export function validTheme(value: unknown): value is Theme {
  if (!value || typeof value !== 'object') return false;
  const t = value as Theme;
  return (
    typeof t.id === 'string' &&
    /^[a-z0-9-]{1,80}$/.test(t.id) &&
    typeof t.name === 'string' &&
    t.name.trim().length > 0 &&
    t.name.length <= 32 &&
    !/[\x00-\x1f]/.test(t.name) &&
    (t.mode === 'light' || t.mode === 'dark') &&
    typeof t.seed === 'string' &&
    hex.test(t.seed)
  );
}
function cleanTheme(t: Theme): Theme {
  return { id: t.id, name: t.name.trim(), mode: t.mode, seed: t.seed.toLowerCase() };
}
export function parseAppearance(value: unknown): Appearance {
  if (!value || typeof value !== 'object' || (value as Appearance).version !== 1)
    return { ...defaults, customThemes: [] };
  const data = value as Appearance;
  const ids = new Set(presets.map((t) => t.id));
  const customThemes = (Array.isArray(data.customThemes) ? data.customThemes : [])
    .filter((t) => {
      if (!validTheme(t) || ids.has(t.id)) return false;
      ids.add(t.id);
      return true;
    })
    .slice(0, MAX_CUSTOM_THEMES)
    .map(cleanTheme);
  const themes = [...presets, ...customThemes];
  return {
    version: 1,
    mode: ['system', 'light', 'dark'].includes(data.mode) ? data.mode : 'system',
    light: themes.some((t) => t.id === data.light && t.mode === 'light') ? data.light : defaults.light,
    dark: themes.some((t) => t.id === data.dark && t.mode === 'dark') ? data.dark : defaults.dark,
    customThemes,
  };
}
export function selectedTheme(settings: Appearance, mode: ColorMode): Theme {
  return (
    [...presets, ...settings.customThemes].find((t) => t.mode === mode && t.id === settings[mode]) ??
    presets.find((t) => t.id === defaults[mode])!
  );
}
const palettes = new Map<string, Record<string, string>>();
/** Material 3 color roles, shared by every screen, preset and custom theme. */
export function themeTokens(theme: Pick<Theme, 'seed' | 'mode'>): Record<string, string> {
  const key = theme.seed + theme.mode;
  const cached = palettes.get(key);
  if (cached) return cached;
  const dark = theme.mode === 'dark';
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(theme.seed)), dark, 0);
  const success = new SchemeTonalSpot(Hct.fromInt(argbFromHex('#238457')), dark, 0);
  const warning = new SchemeTonalSpot(Hct.fromInt(argbFromHex('#ab7000')), dark, 0);
  const info = new SchemeTonalSpot(Hct.fromInt(argbFromHex('#4263a8')), dark, 0);
  const h = hexFromArgb;
  const tokens = {
    '--canvas': h(scheme.surface),
    '--surface': h(dark ? scheme.surface : scheme.surfaceContainerLowest),
    '--surface-raised': h(dark ? scheme.surfaceContainerHigh : scheme.surfaceContainerLowest),
    '--surface-subtle': h(scheme.surfaceContainerLow),
    '--surface-hover': h(scheme.surfaceContainer),
    '--surface-active': h(scheme.surfaceContainerHigh),
    '--ink': h(scheme.onSurface),
    '--muted': h(scheme.onSurfaceVariant),
    '--line': h(scheme.outlineVariant),
    '--border': h(scheme.outlineVariant),
    '--outline': h(scheme.outline),
    '--accent': h(scheme.primary),
    '--on-accent': h(scheme.onPrimary),
    '--accent-hover': h(scheme.primaryPalette.tone(dark ? 85 : 35)),
    '--soft': h(scheme.secondaryContainer),
    '--on-soft': h(scheme.onSecondaryContainer),
    '--danger': h(scheme.error),
    '--danger-soft': h(scheme.errorContainer),
    '--on-danger-soft': h(scheme.onErrorContainer),
    '--success': h(success.primary),
    '--success-soft': h(success.primaryContainer),
    '--on-success-soft': h(success.onPrimaryContainer),
    '--warning': h(warning.primary),
    '--warning-soft': h(warning.primaryContainer),
    '--on-warning-soft': h(warning.onPrimaryContainer),
    '--info': h(info.primary),
    '--info-soft': h(info.primaryContainer),
    '--on-info-soft': h(info.onPrimaryContainer),
    '--shadow': dark ? '#00000066' : '#17211c1a',
    '--scrim': dark ? '#00000099' : '#11191466',
    '--switch-thumb': h(dark ? scheme.onPrimary : scheme.surfaceContainerLowest),
  };
  palettes.set(key, tokens);
  if (palettes.size > 100) palettes.delete(palettes.keys().next().value!);
  return tokens;
}
/** Portable, data-only format; imported IDs and extra CSS are never applied. */
export function importThemes(text: string): Omit<Theme, 'id'>[] {
  if (text.length > 32768) throw Error('主题文件过大（最多 32 KB）');
  let file: { format?: string; version?: number; themes?: Theme[] };
  try {
    file = JSON.parse(text);
  } catch {
    throw Error('无法读取主题文件，请选择导出的 JSON 文件');
  }
  if (
    !file ||
    file.format !== 'agent-space-themes' ||
    file.version !== 1 ||
    !Array.isArray(file.themes) ||
    !file.themes.length ||
    file.themes.length > MAX_CUSTOM_THEMES ||
    !file.themes.every((t) => validTheme({ ...t, id: 'import' }))
  )
    throw Error('主题格式不正确，需要名称、亮暗类型和有效的主色');
  return file.themes.map((t) => ({ name: t.name.trim(), mode: t.mode, seed: t.seed.toLowerCase() }));
}
export function exportThemes(themes: readonly Theme[]): string {
  return JSON.stringify(
    {
      format: 'agent-space-themes',
      version: 1,
      themes: themes.map(({ name, mode, seed }) => ({ name, mode, seed })),
    },
    null,
    2,
  );
}
