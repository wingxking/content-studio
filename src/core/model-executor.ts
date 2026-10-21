import { setTimeout as delay } from 'node:timers/promises';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { parseStructuredOutput } from './structured-output.ts';
import { codexOutputSchema, type GenerationOptions } from './generation-engine.ts';
export function modelExecutorOrigin(): string {
  const url = new URL(process.env.STUDIO_MODEL_EXECUTOR_URL ?? 'http://model-runner:8910');
  const allowed = (process.env.STUDIO_INTERNAL_ORIGINS ?? '').split(',').filter(Boolean);
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname) && !allowed.includes(url.origin)) || url.username || url.password || url.pathname !== '/') throw new Error('Model executor must use an explicitly allowed internal origin.');
  return url.origin;
}
export async function executeRemoteModel<T>(schema: z.ZodType<T>, prompt: string, options: GenerationOptions): Promise<T> {
  const images: string[] = []; let bytes = 0;
  for (const path of options.imagePaths ?? []) {
    const info = await stat(path); bytes += info.size;
    if (!info.isFile() || info.size > 24 * 1024 * 1024 || bytes > 48 * 1024 * 1024) throw new Error('Selected model images exceed the 48 MiB request budget.');
    images.push((await readFile(path)).toString('base64'));
  }
  await options.onProgress?.({ phase: 'model_started', message: 'The isolated model runner is processing this revision.' });
  const requestBody = JSON.stringify({ prompt, schema: codexOutputSchema(schema), images, model: options.model, search: options.search ?? false, timeoutMs: options.timeoutMs ?? 240000 });
  const deadline = Date.now() + (options.timeoutMs ?? 240000);
  let response: Response;
  for (;;) {
    options.signal?.throwIfAborted();
    response = await fetch(`${modelExecutorOrigin()}/execute`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: requestBody, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout((options.timeoutMs ?? 240000) + 30000)]) : AbortSignal.timeout((options.timeoutMs ?? 240000) + 30000) });
    if (response.status !== 429) break;
    await response.body?.cancel();
    if (Date.now() + 5000 >= deadline) throw new Error('Shared model admission timed out. Retry this preserved operation when the active generation completes.');
    await options.onProgress?.({ phase: 'waiting_model', message: 'Waiting for the shared model budget; this revision is preserved.' });
    await delay(5000, undefined, { signal: options.signal });
  }
  const value: unknown = await response.json();
  if (!response.ok) { const error = z.object({ error: z.string() }).safeParse(value); throw new Error(error.success ? error.data.error : 'Model runner needs attention. Inspect container authorization and connectivity.'); }
  const result = z.object({ result: z.unknown(), usage: z.object({ inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), cachedInputTokens: z.number().nullable(), observedSearchEvents: z.number(), cost: z.null() }).optional() }).parse(value); options.signal?.throwIfAborted();
  if (result.usage) await options.onUsage?.(result.usage);
  await options.onProgress?.({ phase: 'model_completed', message: 'Validating isolated model output.' });
  return parseStructuredOutput(schema, result.result);
}
