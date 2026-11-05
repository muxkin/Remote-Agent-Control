import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SelectionError } from './selection-error.js';
export interface ModelChoice {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort: string | null;
  speeds: { id: string; name: string; description: string }[];
}
export async function modelCatalog(
  codexHome: string,
): Promise<{ models: ModelChoice[]; fetchedAt: string | null; source: string }> {
  // This is Desktop's own catalog, not the independently installed CLI catalog.
  const data = JSON.parse(await readFile(join(codexHome, 'models_cache.codex_work_desktop.json'), 'utf8'));
  return {
    source: 'desktop-cache',
    fetchedAt: data.fetched_at ?? null,
    models: (data.models ?? [])
      .filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string')
      .map((m: any) => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        efforts: (m.supported_reasoning_levels ?? [])
          .map((e: any) => e.effort)
          .filter((e: unknown) => typeof e === 'string'),
        defaultEffort: m.default_reasoning_level ?? null,
        speeds: [
          { id: 'default', name: '标准', description: '标准速度与用量' },
          ...(m.service_tiers ?? [])
            .filter((s: any) => typeof s.id === 'string' && s.id !== 'default')
            .map((s: any) => ({ id: s.id, name: s.name ?? s.id, description: s.description ?? '' })),
        ],
      })),
  };
}
export async function validateModelSettings(
  codexHome: string,
  value: { model: string; effort: string; serviceTier?: string },
) {
  const model = (await modelCatalog(codexHome)).models.find((m) => m.id === value.model);
  if (
    !model ||
    !model.efforts.includes(value.effort) ||
    (value.serviceTier !== undefined && !model.speeds.some((s) => s.id === value.serviceTier))
  )
    throw new SelectionError('模型、推理强度或速度不在桌面目录中，请重新打开设置');
}
