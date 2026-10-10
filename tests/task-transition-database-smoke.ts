// Explicit isolated SQL regression; never use a hosted database or publish fixture content.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { dbRequest, dbRpc } from '../src/core/database.ts';
import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';
import { listModels } from '../src/core/models.ts';
import { createDraft } from '../src/core/pipeline.ts';
import { taskInputSchema } from '../src/core/task-model.ts';
import { createTask, updateTask, getTask, enqueueTaskRun, getTaskRun, cancelTaskRun, readRunArtifact } from '../src/core/tasks.ts';

await loadRuntimeEnvironment();
const endpoint = new URL(process.env.SUPABASE_URL ?? '');
if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(endpoint.hostname)) throw new Error('This regression requires local Supabase.');
const original = { ...process.env }; const workspace = randomUUID(); const directory = await mkdtemp(join(tmpdir(), 'studio-transition-smoke-'));
process.env.STUDIO_WORKSPACE_ID = workspace; process.env.STUDIO_DATA_DIR = directory;
const model = (await listModels())[0]?.id; assert.ok(model);
const input = taskInputSchema.parse({ title: 'Task transition fixture', prompt: 'Only validate isolated task transition recovery.', audience: 'AI', angle: '科普', model, platforms: ['x'], sources: [], assetIds: [], kind: 'content', topicOrigin: 'editorial', enabled: true, frequency: { type: 'daily', time: '09:00', timezone: 'Asia/Singapore' } });
const claimSchema = z.object({ msgId: z.number(), token: z.uuid(), message: z.object({ id: z.uuid() }) });
const source = { title: 'Fixture source', url: 'https://example.org/fixture', excerpt: 'Explicit fixture evidence for transition acceptance only.' };
const content = { title: 'Fixture master', body: 'Isolated transition test master.', variants: [{ platform: 'x' as const, title: 'Fixture variant', text: 'Isolated fixture.', tags: [], mediaPaths: [] }] };
async function claim(id: string) {
  for (let index = 0; index < 100; index++) {
    const value = await dbRpc('studio_claim_work', { p_workspace: workspace }); if (!value) continue;
    const delivery = claimSchema.parse(value); if (delivery.message.id === id) return delivery;
    await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: delivery.msgId, p_token: delivery.token });
  }
  throw new Error('Fixture queue delivery not found.');
}
async function begin(id: string) {
  const delivery = await claim(id);
  await dbRpc('studio_claim_task_run', { p_workspace: workspace, p_run: id, p_token: delivery.token });
  return delivery;
}
try {
  const task = await createTask(input); const oldRun = await enqueueTaskRun(task.id, { manual: true }); const old = await begin(oldRun.id);
  const onceAt = new Date(Date.now() - 1000).toISOString();
  await updateTask(task.id, { ...input, frequency: { type: 'once', time: '09:00', timezone: 'Asia/Singapore', onceAt } });
  await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace }); await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace });
  assert.equal((await getTask(task.id)).nextRunAt, onceAt);
  assert.equal((await getTaskRun(oldRun.id)).taskSnapshot.frequency.type, 'daily');
  const before = z.array(z.object({ id: z.uuid() })).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspace}&task_id=eq.${task.id}&select=id`)); assert.equal(before.length, 1);
  await dbRpc('studio_patch_task_run', { p_workspace: workspace, p_run: oldRun.id, p_token: old.token, p_patch: { status: 'succeeded', phase: 'sql_fixture_complete', progress: 100 } });
  await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: old.msgId, p_token: old.token });
  await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace }); await dbRpc('studio_dispatch_due_tasks', { p_workspace: workspace });
  const after = z.array(z.object({ id: z.uuid(), slot: z.string() })).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspace}&task_id=eq.${task.id}&select=id,slot`));
  assert.equal(after.length, 2); const once = after.find(run => run.id !== oldRun.id); assert.ok(once); assert.match(once.slot, /^scheduled:/);
  assert.equal((await getTask(task.id)).nextRunAt, null); assert.equal((await getTaskRun(once.id)).taskSnapshot.frequency.type, 'once');
  await cancelTaskRun(once.id);
  console.log('PASS active daily snapshot -> due once deferral -> one dispatch after completion');

  const commitTask = await createTask({ ...input, frequency: { type: 'once', time: '09:00', timezone: 'Asia/Singapore' } });
  const commitRun = await enqueueTaskRun(commitTask.id, { manual: true }); const committing = await begin(commitRun.id);
  await dbRpc('studio_patch_task_run', { p_workspace: workspace, p_run: commitRun.id, p_token: committing.token, p_patch: { status: 'generating', phase: 'saving_draft', sources: [source], master: { title: content.title, body: content.body }, variants: content.variants, progress: 95 } });
  await assert.rejects(cancelTaskRun(commitRun.id), /Supabase request failed/);
  assert.equal((await getTaskRun(commitRun.id)).status, 'generating');
  await createDraft({ topic: 'AI', audience: 'AI', angle: '科普', sources: [source], platforms: ['x'], topicOrigin: 'editorial' }, content, commitRun.id, model);
  await dbRequest(`studio_task_runs?id=eq.${commitRun.id}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { lease_expires_at: '2020-01-01T00:00:00Z', output_paths: null } });
  const reconciled = await cancelTaskRun(commitRun.id);
  assert.equal(reconciled.status, 'succeeded'); assert.equal(reconciled.draftId, commitRun.id); assert.ok(reconciled.outputPaths);
  const exported = JSON.parse((await readRunArtifact(commitRun.id, 'package.json')).content.toString()) as unknown;
  assert.equal(z.object({ status: z.string() }).parse(exported).status, 'succeeded');
  await rm(join(directory, 'runs', commitRun.id), { recursive: true, force: true });
  assert.match((await readRunArtifact(commitRun.id, 'master.md')).content.toString(), /Fixture master/);
  await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: committing.msgId, p_token: committing.token });
  console.log('PASS active commit cancellation guard, expired committed-draft reconciliation and torn export repair');

  const lostTask = await createTask({ ...input, frequency: { type: 'once', time: '09:00', timezone: 'Asia/Singapore' } });
  const lostRun = await enqueueTaskRun(lostTask.id, { manual: true }); const lost = await begin(lostRun.id);
  await dbRpc('studio_patch_task_run', { p_workspace: workspace, p_run: lostRun.id, p_token: lost.token, p_patch: { status: 'generating', phase: 'saving_draft', progress: 95 } });
  await dbRequest(`studio_task_runs?id=eq.${lostRun.id}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { lease_expires_at: '2020-01-01T00:00:00Z' } });
  const cancelled = await cancelTaskRun(lostRun.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.draftId, null);
  await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: lost.msgId, p_token: lost.token });
  const existing = z.array(z.object({ state: z.object({ drafts: z.array(z.object({ id: z.uuid() })) }) })).parse(await dbRequest(`content_studio_workspaces?id=eq.${workspace}&select=state`));
  assert.ok(existing.every(row => row.state.drafts.every(draft => draft.id !== lostRun.id)));
  console.log('PASS expired commit without a draft remains cancellable and creates no orphan');
} finally {
  const leases = z.array(z.object({ msg_id: z.number(), token: z.uuid() })).parse(await dbRequest(`studio_queue_leases?workspace_id=eq.${workspace}&select=msg_id,token`));
  for (const lease of leases) await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: lease.msg_id, p_token: lease.token });
  for (let index = 0; index < 100; index++) { const value = await dbRpc('studio_claim_work', { p_workspace: workspace }); if (!value) break; const delivery = claimSchema.parse(value); await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: delivery.msgId, p_token: delivery.token }); }
  for (const table of ['studio_run_events', 'studio_task_runs', 'studio_tasks', 'studio_queue_leases', 'studio_revisions', 'content_studio_workspaces']) await dbRequest(`${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspace}`, { method: 'DELETE' });
  process.env = original; await rm(directory, { recursive: true, force: true });
}
