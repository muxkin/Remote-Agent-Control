import { describe, expect, it } from 'vitest';
import {
  defaults,
  exportThemes,
  importThemes,
  parseAppearance,
  presets,
  selectedTheme,
  themeTokens,
} from '../src/web/theme/palette';

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe('shared appearance system', () => {
  it('keeps light and dark selections independent and repairs a removed selection', () => {
    const custom = { id: 'custom-violet', name: '紫色', mode: 'dark' as const, seed: '#7453ac' };
    const state = parseAppearance({
      ...defaults,
      light: 'blue-light',
      dark: custom.id,
      customThemes: [custom],
    });
    expect(selectedTheme(state, 'light').id).toBe('blue-light');
    expect(selectedTheme(state, 'dark').id).toBe(custom.id);
    expect(parseAppearance({ ...state, customThemes: [] })).toMatchObject({
      light: 'blue-light',
      dark: defaults.dark,
    });
    expect(parseAppearance({ ...state, light: custom.id }).light).toBe(defaults.light);
  });
  it('rejects corrupted storage, duplicate IDs, preset replacement and invalid color payloads', () => {
    for (const data of [null, 'broken', [], { version: 99 }]) expect(parseAppearance(data)).toEqual(defaults);
    const custom = { id: 'custom-a', name: 'A', mode: 'light', seed: '#123456' };
    const data = parseAppearance({
      ...defaults,
      mode: 'invalid',
      customThemes: [
        custom,
        custom,
        presets[0],
        { ...custom, id: 'custom-b', seed: 'url(https://invalid)' },
        null,
      ],
    });
    expect(data.customThemes).toEqual([custom]);
    expect(data.mode).toBe('system');
  });
  it('exports and imports only portable theme data', () => {
    expect(importThemes(exportThemes(presets))).toEqual(
      presets.map(({ name, mode, seed }) => ({ name, mode, seed })),
    );
    const file = JSON.parse(exportThemes(presets));
    file.themes[0].css = 'body { display: none }';
    file.themes[0].id = 'jade-light';
    expect(importThemes(JSON.stringify(file))[0]).not.toHaveProperty('css');
    expect(importThemes(JSON.stringify(file))[0]).not.toHaveProperty('id');
    for (const bad of ['null', '{}', 'not json', JSON.stringify({ ...file, version: 2 }), 'x'.repeat(32769)])
      expect(() => importThemes(bad)).toThrow();
  });
  it('provides readable foreground/background pairs for presets and extreme custom seeds', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const seed of [
        '#197b66',
        '#4263a8',
        '#ffffff',
        '#000000',
        '#ffff00',
        '#ff00ff',
        '#ff0000',
        '#00ffff',
      ]) {
        const t = themeTokens({ mode, seed });
        for (const [foreground, background] of [
          ['--ink', '--surface'],
          ['--muted', '--surface'],
          ['--muted', '--surface-subtle'],
          ['--on-accent', '--accent'],
          ['--on-soft', '--soft'],
          ['--on-danger-soft', '--danger-soft'],
        ])
          expect(
            contrast(t[foreground], t[background]),
            `${mode} ${seed} ${foreground}`,
          ).toBeGreaterThanOrEqual(4.5);
        if (mode === 'light') expect(luminance(t['--surface'])).toBeGreaterThan(0.9);
        if (mode === 'dark') expect(luminance(t['--surface'])).toBeLessThan(0.03);
      }
    }
  });
});
