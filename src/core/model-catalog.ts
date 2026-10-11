import { spawn } from 'node:child_process';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LocalModel } from './models.ts';
const pageSchema = z.object({ data: z.array(z.object({ model: z.string(), displayName: z.string(), description: z.string(), hidden: z.boolean() })), nextCursor: z.string().nullable().optional() });
let refresh: Promise<LocalModel[]> | undefined;
export function refreshModelCatalog(cacheFile: string): Promise<LocalModel[]> {
  if (refresh) return refresh;
  refresh = readCatalog(cacheFile).finally(() => { refresh = undefined; }); return refresh;
}
async function readCatalog(cacheFile: string): Promise<LocalModel[]> {
  const { codexExecutable } = await import('./generator.ts'); const binary = await codexExecutable();
  const models = await new Promise<LocalModel[]>((accept, reject) => {
    const child = spawn(binary, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = ''; let bytes = 0; let completed = false; let requestId = 2; const collected: LocalModel[] = [];
    const finish = (error?: Error): void => { if (completed) return; completed = true; clearTimeout(timer); child.kill('SIGTERM'); if (error) reject(error); else accept(collected); };
    const send = (value: unknown): void => { child.stdin.write(`${JSON.stringify(value)}\n`); };
    const timer = setTimeout(() => finish(new Error('Model catalog refresh timed out. Check container authentication and network.')), 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { finish(new Error('Model catalog exceeded its limit.')); return; }
      pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        let value: unknown; try { value = JSON.parse(line) as unknown; } catch { continue; }
        const reply = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() }).safeParse(value); if (!reply.success) continue;
        if (reply.data.error && reply.data.id) { finish(new Error('Authorize the model container before refreshing its catalog.')); return; }
        if (reply.data.id === 1) { send({ method: 'initialized' }); send({ id: requestId, method: 'model/list', params: { limit: 100, includeHidden: false } }); }
        else if (reply.data.id === requestId) {
          const parsed = pageSchema.safeParse(reply.data.result); if (!parsed.success) { finish(new Error('Model catalog protocol is unsupported.')); return; }
          collected.push(...parsed.data.data.filter(model => !model.hidden && model.model !== 'codex-auto-review').map(model => ({ id: model.model, name: model.displayName, description: model.description })));
          if (parsed.data.nextCursor && collected.length < 500) { requestId++; send({ id: requestId, method: 'model/list', params: { cursor: parsed.data.nextCursor, limit: 100, includeHidden: false } }); } else finish();
        }
      }
    });
    child.stderr.on('data', () => undefined); child.stdin.on('error', () => undefined);
    child.once('error', () => finish(new Error('Could not start container model catalog service.'))); child.once('close', () => { if (!completed) finish(new Error('Model catalog service stopped before completion.')); });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'content-studio-catalog', version: '1.0' }, capabilities: { experimentalApi: false } } });
  });
  if (!models.length) throw new Error('No available models were returned for this account.');
  await mkdir(dirname(cacheFile), { recursive: true, mode: 0o700 }); const temporary = `${cacheFile}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify({ models: models.map(model => ({ slug: model.id, display_name: model.name, description: model.description })) }), { mode: 0o600, flag: 'wx' }); await rename(temporary, cacheFile); } finally { await rm(temporary, { force: true }); }
  return models;
}
