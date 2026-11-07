import type { BackendAppearance, BackendInfo } from './backends.js';

export function backendAppearanceDefaults(
  info: Pick<BackendInfo, 'name' | 'product' | 'presentation'>,
): BackendAppearance {
  return {
    name: info.name,
    description: info.presentation?.description ?? info.product,
    icon: {
      kind: 'builtin',
      value: info.product === 'codex' ? 'code' : info.product === 'dsh' ? 'terminal' : 'puzzle',
    },
  };
}
