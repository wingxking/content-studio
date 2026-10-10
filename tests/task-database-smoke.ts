// Explicit local Supabase acceptance. Never run against a hosted database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { dbRequest, dbRpc } from '../src/core/database.ts';
import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';
import { listModels } from '../src/core/models.ts';
import { createTask, updateTask, getTask, enqueueTaskRun, getTaskRun, retryTaskRun, cancelTaskRun, configureTaskRuntime, enqueueWork, processTaskRun } from '../src/core/tasks.ts';
import { runWorkerOnce } from '../src/server/worker.ts';
import { taskInputSchema, type TaskInput } from '../src/core/task-model.ts';

await loadRuntimeEnvironment();
const base = new URL(process.env.SUPABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('This smoke test requires the local Supabase endpoint.');
const originalEnvironment = { ...process.env }; const workspace = randomUUID(); const directory = await mkdtemp(join(tmpdir(), 'studio-db-smoke-'));
process.env.STUDIO_WORKSPACE_ID = workspace; process.env.STUDIO_DATA_DIR = directory;
const model = (await listModels())[0]?.id; assert.ok(model);
const source = { title: 'Fixture software evidence', url: 'https://example.org/fixture', excerpt: 'Explicit acceptance fixture; never claim this is a real researched article.' };
let fail = false; let researchCalls = 0; let masterCalls = 0;
configureTaskRuntime({
  resolveImagePaths: async () => [],
  research: async () => { researchCalls++; return { sources: [source], warnings: [] }; },
  generateMaster: async () => { masterCalls++; return { title: 'Fixture master', body: 'Fixture master for durable local database validation.' }; },
  adaptMaster: async (_brief, _master, platform) => { if (fail && platform === 'youtube') throw new Error('Intentional smoke adapter failure.'); return { platform, title: 'Fixture variant', text: 'Fixture text.', tags: [], mediaPaths: [] }; },
});
function config(frequency: TaskInput['frequency'] = { type: 'once', time: '09:00', timezone: 'Asia/Singapore' }): TaskInput {
  return taskInputSchema.parse({ title: 'Database acceptance fixture', prompt: 'Use fixture evidence to verify durable workflow.', model, platforms: ['x', 'youtube'], kind: 'content', frequency, enabled: true });
}
async function drainUntil(id: string, status: string): Promise<void> {
  for (let index = 0; index < 100; index++) { if ((await getTaskRun(id)).status === status) return; await runWorkerOnce(); }
  throw new Error(`Fixture run did not reach ${status}.`);
}
const claimSchema = z.object({ msgId: z.number(), token: z.uuid(), message: z.object({ id: z.uuid() }) });
async function fixtureClaim(id: string) {
  for (let index = 0; index < 100; index++) { const input = await dbRpc('studio_claim_work', { p_workspace: workspace }); if (input) { const claim = claimSchema.parse(input); if (claim.message.id === id) return claim; await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token }); } }
  throw new Error('No fixture queue delivery available.');
}
try {
  const manual = await createTask(config()); assert.equal(manual.nextRunAt, null);
  const first = await enqueueTaskRun(manual.id, { manual: true }); const doubleClick = await enqueueTaskRun(manual.id, { manual: true }); assert.equal(first.id, doubleClick.id);
  await drainUntil(first.id, 'succeeded'); assert.equal((await getTaskRun(first.id)).draftId, first.id);
  assert.equal((await getTask(manual.id)).nextRunAt, null);
  console.log('PASS manual once, active-run deduplication, queue execution, stable draft');

  const retryTask = await createTask(config()); const retryRun = await enqueueTaskRun(retryTask.id, { manual: true }); fail = true;
  await drainUntil(retryRun.id, 'failed'); const partial = await getTaskRun(retryRun.id); assert.ok(partial.master); assert.equal(partial.variants.length, 1); assert.ok(partial.outputPaths);
  const beforeRetry = { researchCalls, masterCalls }; fail = false; await retryTaskRun(retryRun.id); await drainUntil(retryRun.id, 'succeeded');
  assert.deepEqual({ researchCalls, masterCalls }, beforeRetry); assert.equal((await getTaskRun(retryRun.id)).attempt, 2);
  console.log('PASS persisted master/platform checkpoints, failure history, retry without duplicate generation');

  const cancelTask = await createTask(config()); const cancelled = await enqueueTaskRun(cancelTask.id, { manual: true }); await cancelTaskRun(cancelled.id);
  await runWorkerOnce(); assert.equal((await getTaskRun(cancelled.id)).status, 'cancelled'); await retryTaskRun(cancelled.id); await drainUntil(cancelled.id, 'succeeded');
  console.log('PASS queued cancellation and explicit continuation');

  const runningCancelTask = await createTask(config()); const runningCancel = await enqueueTaskRun(runningCancelTask.id, { manual: true });
  let enterMaster: () => void = () => undefined; const entered = new Promise<void>(resolve => { enterMaster = resolve; });
  configureTaskRuntime({ generateMaster: async (_brief, _instruction, options) => {
    enterMaster(); return new Promise((_resolve, reject) => {
      const stop = () => reject(new Error('Fixture generation cancelled.'));
      if (options.signal?.aborted) stop(); else options.signal?.addEventListener('abort', stop, { once: true });
    });
  } });
  // A mock pending promise has no child-process handle to keep Node alive for the worker heartbeat.
  const cancellationKeepAlive = setInterval(() => undefined, 1000);
  try {
    const inFlight = runWorkerOnce();
    await Promise.race([entered, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Running cancellation fixture did not start.')), 15000); timer.unref(); })]);
    await cancelTaskRun(runningCancel.id); await inFlight;
  } finally { clearInterval(cancellationKeepAlive); }
  assert.equal((await getTaskRun(runningCancel.id)).status, 'cancelled'); assert.equal((await getTaskRun(runningCancel.id)).draftId, null);
  configureTaskRuntime({ generateMaster: async () => { masterCalls++; return { title: 'Fixture master', body: 'Fixture master for durable local database validation.' }; } });
  console.log('PASS running cancellation aborts generation and produces no draft');

  const recoveryTask = await createTask(config()); const recoveryRun = await enqueueTaskRun(recoveryTask.id, { manual: true }); const abandoned = await fixtureClaim(recoveryRun.id);
  await dbRpc('studio_claim_task_run', { p_workspace: workspace, p_run: recoveryRun.id, p_token: abandoned.token });
  await dbRpc('studio_patch_task_run', { p_workspace: workspace, p_run: recoveryRun.id, p_token: abandoned.token, p_patch: { sources: [source], master: { title: 'Recovered master', body: 'Saved before worker interruption.' }, phase: 'master_saved', progress: 50 } });
  await dbRequest(`studio_task_runs?id=eq.${recoveryRun.id}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { lease_expires_at: '2020-01-01T00:00:00Z' } });
  await dbRequest(`studio_queue_leases?msg_id=eq.${abandoned.msgId}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { expires_at: '2020-01-01T00:00:00Z' } });
  assert.equal(await dbRpc('studio_renew_work', { p_workspace: workspace, p_msg: abandoned.msgId, p_token: abandoned.token }), false);
  await enqueueWork('task_run', recoveryRun.id); const replacement = await fixtureClaim(recoveryRun.id);
  await processTaskRun(recoveryRun.id, replacement.token, new AbortController().signal);
  const fenced = await dbRpc('studio_patch_task_run', { p_workspace: workspace, p_run: recoveryRun.id, p_token: abandoned.token, p_patch: { phase: 'stale_owner' } });
  assert.ok(fenced === null || z.object({ id: z.string().nullable() }).parse(fenced).id === null);
  assert.equal((await getTaskRun(recoveryRun.id)).status, 'succeeded'); assert.equal((await getTaskRun(recoveryRun.id)).master?.title, 'Recovered master');
  for (const claim of [abandoned, replacement]) await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token });
  console.log('PASS expired lease recovery and stale-worker fencing');

  const day = config({ type: 'daily', time: '09:00', timezone: 'Asia/Singapore' });
  assert.equal(new Date(z.string().parse(await dbRpc('studio_next_task_time', { p_config: day, p_after: '2026-10-10T00:30:00Z' }))).toISOString(), '2026-10-10T01:00:00.000Z');
  const week = config({ type: 'weekly', time: '09:00', timezone: 'Asia/Singapore', weekdays: [1] });
  assert.equal(new Date(z.string().parse(await dbRpc('studio_next_task_time', { p_config: week, p_after: '2026-10-10T00:30:00Z' }))).toISOString(), '2026-10-12T01:00:00.000Z');
  const changed = await updateTask(manual.id, day); assert.ok(changed.nextRunAt); const weekly = await updateTask(manual.id, week); assert.ok(weekly.nextRunAt);
  const scheduled = await createTask(config({ type: 'once', time: '09:00', timezone: 'Asia/Singapore', onceAt: new Date(Date.now() - 1000).toISOString() }));
  await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace }); await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace });
  const scheduledRows = z.array(z.object({ id: z.uuid() })).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspace}&task_id=eq.${scheduled.id}&select=id`)); assert.equal(scheduledRows.length, 1);
  assert.equal((await getTask(scheduled.id)).nextRunAt, null); await drainUntil(scheduledRows[0]!.id, 'succeeded');
  const consumed = await updateTask(scheduled.id, config(scheduled.frequency)); assert.equal(consumed.nextRunAt, null);
  console.log('PASS daily/weekly timezone calculation, frequency edits, once dispatch uniqueness and consumed schedule');
  for (const recurring of [day, week]) {
    const task = await createTask(recurring);
    await dbRequest(`studio_tasks?id=eq.${task.id}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { next_run_at: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString() } });
    await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace }); await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace });
    const runs = z.array(z.object({ id: z.uuid(), slot: z.string() })).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspace}&task_id=eq.${task.id}&select=id,slot`));
    assert.equal(runs.length, 1); assert.match(runs[0]!.slot, /^scheduled:/);
    const next = (await getTask(task.id)).nextRunAt; assert.ok(next); assert.ok(new Date(next).getTime() > Date.now());
    await drainUntil(runs[0]!.id, 'succeeded');
  }
  const dst = config({ type: 'daily', time: '02:30', timezone: 'America/New_York' });
  assert.equal(new Date(z.string().parse(await dbRpc('studio_next_task_time', { p_config: dst, p_after: '2026-03-08T00:00:00Z' }))).toISOString(), '2026-03-09T06:30:00.000Z');
  console.log('PASS recurring cron dispatch deduplication/latest-slot catchup and daylight-saving gap');
  console.log('Local Supabase task acceptance passed. Generation was deterministic fixture execution; no publication or actual model research ran.');
} finally {
  const cleanupFailures: string[] = [];
  for (let index = 0; index < 100; index++) {
    const input = await dbRpc('studio_claim_work', { p_workspace: workspace }).catch(() => null); if (!input) break;
    const claim = claimSchema.parse(input); await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token }).catch(() => { cleanupFailures.push('fixture_queue'); });
  }
  for (const table of ['studio_run_events', 'studio_task_runs', 'studio_tasks', 'studio_queue_leases', 'content_studio_workspaces']) await dbRequest(`${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspace}`, { method: 'DELETE' }).catch(() => { cleanupFailures.push(table); });
  if (cleanupFailures.length) { console.error(JSON.stringify({ fixtureCleanupFailed: cleanupFailures, workspace })); process.exitCode = 1; }
  process.env = originalEnvironment; await rm(directory, { recursive: true, force: true });
}
