import type { BackendAppearance, BackendInfo } from './backends.js';

/** Product identities are defaults; instance names, descriptions and icons remain editable. */
export function backendStyle(product: string) {
  const key = product.toLowerCase().replace(/[\s_-]/g, '');
  if (key === 'codex' || key === 'dsh' || key === 'openclaw') return key;
  if (key === 'claude' || key === 'claudecode') return 'claude';
  return 'generic';
}

export function backendAppearanceDefaults(
  info: Pick<BackendInfo, 'name' | 'product' | 'presentation'>,
): BackendAppearance {
  const style = backendStyle(info.product);
  return {
    name: info.name,
    description: info.presentation?.description ?? info.product,
    icon: {
      kind: 'builtin',
      value:
        style === 'codex' ? 'code' : style === 'dsh' ? 'terminal' : style === 'claude' ? 'sun' : 'puzzle',
    },
  };
}
