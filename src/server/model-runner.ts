import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { refreshModelCatalog } from '../core/model-catalog.ts';
import type { GenerationUsage } from '../core/generation-engine.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { codexExecutable } from '../core/generator.ts';
import { runStructuredGeneration } from '../core/generation-engine.ts';
import { listModels } from '../core/models.ts';
// This container alone owns Codex auth and the shared model concurrency budget.
delete process.env.STUDIO_MODEL_EXECUTOR_URL;
const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '70mb' }));
const inputSchema = z.object({ prompt: z.string().min(1).max(500000), schema: z.record(z.string(), z.unknown()), images: z.array(z.string().max(34 * 1024 * 1024)).max(12), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).optional(), search: z.boolean(), timeoutMs: z.number().int().min(1000).max(600000) }).strict();
let active = false;
app.get('/healthz', (_req, res) => res.json({ ready: true, active }));
app.get('/readyz', async (_req, res) => {
  try { await promisify(execFile)(await codexExecutable(), ['login', 'status'], { timeout: 10000, maxBuffer: 8192 }); res.json({ ready: true, active }); }
  catch { res.status(503).json({ ready: false, action: 'Run docker compose run --rm model-runner codex login --device-auth, then complete authorization for this machine.' }); }
});
app.get('/models', async (_req, res) => { try { res.json(await listModels()); } catch { res.status(503).json({ error: 'Authorize the model-runner container and refresh its model catalog.' }); } });
app.post('/models/refresh', async (_req, res) => { try { res.json(await refreshModelCatalog(join(process.env.CODEX_HOME ?? '/auth', 'studio-models.json'))); } catch { res.status(503).json({ error: 'Authorize the model container and retry catalog refresh.' }); } });
app.post('/execute', async (req, res) => {
  if (active) { res.status(429).json({ error: 'The shared model runner is busy. The durable operation can be retried.' }); return; }
  let directory: string | undefined;
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const input = inputSchema.parse(req.body); active = true;
    directory = await mkdtemp(join(tmpdir(), 'studio-model-input-')); const paths: string[] = []; let total = 0;
    for (const [index, image] of input.images.entries()) {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) throw new Error('Reference image encoding is invalid.');
      const bytes = Buffer.from(image, 'base64'); total += bytes.length;
      if (bytes.length > 24 * 1024 * 1024 || total > 48 * 1024 * 1024) throw new Error('Reference image budget exceeded.');
      const path = join(directory, `image-${index}`); await writeFile(path, bytes, { mode: 0o600 }); paths.push(path);
    }
    let usage: GenerationUsage | undefined;
    const result = await runStructuredGeneration(z.unknown(), input.prompt, { model: input.model, outputSchema: input.schema, imagePaths: paths, search: input.search, timeoutMs: input.timeoutMs, signal: controller.signal, onUsage: async value => { usage = value; } });
    res.json({ result, usage });
  } catch (error) { if (!res.headersSent) res.status(400).json({ error: error instanceof Error ? error.message : 'Model execution failed.' }); }
  finally { active = false; if (directory) await rm(directory, { recursive: true, force: true }); }
});
app.listen(8910, '0.0.0.0');
