import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const cacheSchema = z.object({ models: z.array(z.object({ slug: z.string(), display_name: z.string(), description: z.string() })) });
export type LocalModel = { id: string; name: string; description: string };
export async function listModels(cacheFile = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), process.env.STUDIO_CONTAINER === 'true' ? 'studio-models.json' : 'models_cache.json')): Promise<LocalModel[]> {
  if (process.env.STUDIO_MODEL_EXECUTOR_URL) {
    const { modelExecutorOrigin } = await import('./model-executor.ts');
    const response = await fetch(`${modelExecutorOrigin()}/models`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error('Authorize the model-runner container and refresh its catalog.');
    return z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).parse(await response.json());
  }
  let input: unknown;
  try { input = JSON.parse(await readFile(cacheFile, 'utf8')) as unknown; }
  catch { if (process.env.STUDIO_CONTAINER === 'true') { const { refreshModelCatalog } = await import('./model-catalog.ts'); return refreshModelCatalog(cacheFile); } throw new Error('The local Codex model catalog is unavailable. Authorize the model-runner and execute Codex once to refresh its model list.'); }
  const parsed = cacheSchema.safeParse(input);
  if (!parsed.success) throw new Error('The local Codex model catalog has an unsupported format.');
  return parsed.data.models.filter(model => model.slug !== 'codex-auto-review')
    .map(model => ({ id: model.slug, name: model.display_name, description: model.description }));
}
export async function assertAvailableModel(id: string): Promise<void> {
  if (!(await listModels()).some(model => model.id === id)) throw new Error('Select a model from the current local Codex catalog.');
}
