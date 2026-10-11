import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { initializeJournalPresence } from '../core/publication-journal.ts';
import { dbRpc } from '../core/database.ts';
import { loadRuntimeEnvironment } from '../core/runtime-env.ts';
import { resolveAssetImagePaths } from '../core/assets.ts';
import { handleStudioOperation } from '../core/editor.ts';
import { runDueJobs } from '../core/pipeline.ts';
import { dataDirectory } from '../core/store.ts';
import { configureTaskRuntime, getTaskRun, processTaskRun, taskRunOwnership, taskWorkspaceId } from '../core/tasks.ts';

type WorkerHandler = (id: string, signal: AbortSignal) => Promise<void>;
const handlers = new Map<string, WorkerHandler>();
export function registerWorkerHandler(type: string, handler: WorkerHandler): void {
  handlers.set(z.string().regex(/^[a-z][a-z0-9_]{0,49}$/u).parse(type), handler);
}
registerWorkerHandler('studio_operation', handleStudioOperation);
registerWorkerHandler('legacy_publish', async (_id, signal) => { signal.throwIfAborted(); await runDueJobs(); });
const claimSchema = z.object({ msgId: z.number().int().positive(), token: z.uuid(), message: z.object({ type: z.string(), id: z.uuid(), workspaceId: z.uuid() }) });
export async function runWorkerOnce(parentSignal?: AbortSignal): Promise<boolean> {
  parentSignal?.throwIfAborted(); const workspace = await taskWorkspaceId();
  const role = z.enum(['article', 'video', 'delivery', 'all']).parse(process.env.STUDIO_WORKER_ROLE ?? 'all');
  const input = await dbRpc(process.env.STUDIO_WORKER_ROLE ? 'studio_claim_role_work' : 'studio_claim_work', { p_workspace: workspace, ...(process.env.STUDIO_WORKER_ROLE ? { p_role: role } : {}) }); if (!input) return false;
  const claim = claimSchema.parse(input); const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let ticking = false; let leaseError: Error | null = null;
  const heartbeat = setInterval(() => {
    if (ticking || signal.aborted) return; ticking = true;
    void (async () => {
      const renewed = await dbRpc('studio_renew_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token });
      if (renewed !== true) throw new Error('Worker queue lease expired or ownership changed.');
      if (claim.message.type === 'task_run') {
        const ownership = await taskRunOwnership(claim.message.id, claim.token);
        if (ownership.status === 'cancelled' || (!ownership.owned && ['queued', 'researching', 'generating'].includes(ownership.status))) controller.abort(new Error('Task cancelled or ownership changed.'));
      }
    })().catch(() => { leaseError = new Error('Worker lost its durable queue lease; work will resume after service recovery.'); controller.abort(leaseError); }).finally(() => { ticking = false; });
  }, 10000);
  heartbeat.unref();
  try {
    if (claim.message.type === 'task_run') await processTaskRun(claim.message.id, claim.token, signal);
    else {
      const handler = handlers.get(claim.message.type); if (!handler) throw new Error('No worker handler is registered for this queued work type.');
      await handler(claim.message.id, signal);
    }
    if (leaseError || parentSignal?.aborted) throw leaseError ?? new Error('Worker stopping.');
    // A confirmed cancellation is terminal and can be acknowledged after its child process stops.
    if (signal.aborted && claim.message.type === 'task_run' && (await getTaskRun(claim.message.id)).status !== 'cancelled') throw new Error('Worker interrupted.');
    const acknowledged = await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token });
    if (acknowledged !== true) throw new Error('Queue acknowledgement lost its lease.');
    return true;
  } catch (error) {
    if (!leaseError && !parentSignal?.aborted && claim.message.type === 'task_run' && (await getTaskRun(claim.message.id)).status === 'cancelled') {
      await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token }); return true;
    }
    if (!leaseError && !parentSignal?.aborted && process.env.STUDIO_WORKER_ROLE) await dbRpc('studio_fail_role_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token, p_error: error instanceof Error ? error.message : 'Worker stage failed.' }).catch(() => undefined);
    throw error;
  } finally { clearInterval(heartbeat); controller.abort(); }
}
export async function initializeWorker(): Promise<void> {
  await loadRuntimeEnvironment(); if (process.env.STUDIO_WORKER_ROLE === 'delivery') await initializeJournalPresence(); configureTaskRuntime({ resolveImagePaths: resolveAssetImagePaths });
  const health = z.object({ database: z.literal(true), pgmq: z.literal(true), pg_cron: z.literal(true) }).safeParse(await dbRpc('studio_runtime_health'));
  if (!health.success) throw new Error('The worker requires a healthy local database, Queues and Cron runtime.');
  const directory = dataDirectory(); await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = { pid: process.pid, workspaceId: await taskWorkspaceId(), readyAt: new Date().toISOString() };
  const temporary = join(directory, `.worker-ready.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, process.env.STUDIO_WORKER_ROLE ? `worker-${process.env.STUDIO_WORKER_ROLE}-ready.json` : 'worker-ready.json'));
  } finally { await rm(temporary, { force: true }); }
}
export async function runWorker(signal: AbortSignal = new AbortController().signal): Promise<void> {
  await initializeWorker();
  while (!signal.aborted) {
    try {
      const processed = await runWorkerOnce(signal);
      if (!processed) await delay(1500, undefined, { signal });
    } catch {
      if (signal.aborted) break;
      console.error('Content worker needs attention; durable work and checkpoints are preserved.');
      await delay(3000, undefined, { signal }).catch(() => undefined);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => controller.abort());
  await runWorker(controller.signal);
}
