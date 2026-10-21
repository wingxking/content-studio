// Explicit isolated Supabase/pgmq + HTTP route acceptance. Never invokes a worker or model.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

if (!process.argv.includes('--confirm-isolated-database')) throw new Error('Use --confirm-isolated-database.');
if (process.env.STUDIO_CONTAINER !== 'true' || new URL(process.env.SUPABASE_URL ?? '').hostname !== 'kong') throw new Error('Use an isolated local Docker Supabase network.');
const environment = { ...process.env }; const workspace = randomUUID(); const taskId = randomUUID(); const draftId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'studio-refresh-'));
process.env.STUDIO_WORKSPACE_ID = workspace; process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_LOCALFS_DIR = directory;
const { dbRequest, dbRpc } = await import('../src/core/database.ts');
const { readState, mutateState } = await import('../src/core/store.ts');
const { draftSchema } = await import('../src/core/model.ts');
const { taskSchema } = await import('../src/core/task-model.ts');
const { evidenceApi } = await import('../src/server/evidence-api.ts');
const timestamp = new Date().toISOString();
const task = taskSchema.parse({ id: taskId, createdAt: timestamp, updatedAt: timestamp, nextRunAt: null, title: 'Isolated refresh fixture', prompt: 'Explain immutable software revisions from supplied sources.', pipelineVersion: 2, model: 'fixture-never-executed', platforms: ['zhihu'], kind: 'content', enabled: false, frequency: { type: 'once', time: '09:00', timezone: 'UTC' } });
const draft = draftSchema.parse({ id: draftId, revision: 1, createdAt: timestamp, approvedHash: null, title: 'Isolated software revision', body: 'Synthetic route fixture. No publishable factual claims.', generationEvidenceRunId: draftId, brief: { topic: 'Software revisions', audience: 'Acceptance operator', angle: 'Check revision-bound research requests.', sources: [{ title: 'Synthetic reference', url: 'https://example.org/revisions', excerpt: 'Fixture only; no network request.' }], platforms: ['zhihu'] }, variants: [{ platform: 'zhihu', title: 'Isolated software revision', text: 'Synthetic route fixture.', tags: [], mediaPaths: [] }] });
const app = express(); app.use(express.json()); app.use('/api', evidenceApi);
const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Request failed.';
  res.status(/revision|changed|already running|active.*submission|reconcile.*before/iu.test(message) ? 409 : 400).json({ error: message });
};
app.use(errors);
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}/api`;
const request = (id: string, body: unknown) => fetch(`${origin}/drafts/${id}/quality/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const acceptedSchema = z.object({ runId: z.uuid(), draftId: z.uuid(), expectedRevision: z.literal(1), accepted: z.literal(true) });
let queuedResearch = 0;
try {
  await mutateState(state => { state.paused = true; });
  await dbRequest('studio_tasks', { method: 'POST', body: { id: taskId, workspace_id: workspace, config: task } });
  await dbRequest('studio_task_runs', { method: 'POST', body: { id: draftId, workspace_id: workspace, task_id: taskId, slot: 'fixture-succeeded-lineage', task_snapshot: task, status: 'succeeded', draft_id: draftId } });
  await dbRequest('studio_research_steps', { method: 'POST', body: { workspace_id: workspace, run_id: draftId, stage: 'quality_final', input_hash: 'a'.repeat(64), status: 'completed', attempts: 1, artifact_ref: 'b'.repeat(64) } });
  await dbRpc('studio_commit_article', { p_workspace: workspace, p_command: randomUUID(), p_expected_revision: 0, p_content: draft });
  const initial = await request(draftId, { expectedRevision: 1 }); assert.equal(initial.status, 202);
  const accepted = acceptedSchema.parse(await initial.json()); assert.equal(accepted.draftId, draftId);
  const duplicates = await Promise.all([request(draftId, { expectedRevision: 1 }), request(draftId, { expectedRevision: 1 })]);
  for (const response of duplicates) { assert.equal(response.status, 202); assert.deepEqual(acceptedSchema.parse(await response.json()), accepted); }
  assert.equal(await dbRpc('studio_request_evidence_refresh', { p_workspace: workspace, p_draft: draftId, p_revision: 1, p_reason: 'source_changed' }), accepted.runId);
  const rows = z.array(z.object({ id: z.uuid(), status: z.string(), refresh_draft_id: z.uuid().nullable(), refresh_revision: z.number().nullable(), refresh_reason: z.string().nullable() })).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspace}&select=id,status,refresh_draft_id,refresh_revision,refresh_reason`));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(row => row.id === accepted.runId), { id: accepted.runId, status: 'queued', refresh_draft_id: draftId, refresh_revision: 1, refresh_reason: 'review_requested' });
  assert.deepEqual((await readState()).drafts, [draft]);
  assert.equal((await request(draftId, { expectedRevision: 1, automatic: true })).status, 400);
  assert.equal((await request(randomUUID(), { expectedRevision: 1 })).status, 404);
  const legacy = { ...draft, id: randomUUID(), generationEvidenceRunId: undefined };
  await dbRpc('studio_commit_article', { p_workspace: workspace, p_command: randomUUID(), p_expected_revision: 0, p_content: legacy });
  assert.equal((await request(legacy.id, { expectedRevision: 1 })).status, 400);
  const edited = { ...draft, revision: 2, body: 'Operator edit retained while a previous research request exists.' };
  await dbRpc('studio_commit_article', { p_workspace: workspace, p_command: randomUUID(), p_expected_revision: 1, p_content: edited });
  assert.equal((await request(draftId, { expectedRevision: 1 })).status, 409);
  await assert.rejects(dbRpc('studio_request_evidence_refresh', { p_workspace: workspace, p_draft: draftId, p_revision: 1, p_reason: 'review_requested' }), /revision|ownership changed/u);
  assert.deepEqual((await readState()).drafts.find(item => item.id === draftId), edited);
  assert.equal(z.array(z.unknown()).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspace}`)).length, 2);
  const state = await readState(); assert.equal(state.jobs.length, 0); assert.equal(state.accounts.length, 0); assert.equal(state.paused, true);
  // Inspect and acknowledge this random workspace's queue only; no work handler executes.
  for (let index = 0; index < 20; index++) {
    const claim = z.object({ msgId: z.number(), token: z.uuid(), message: z.object({ type: z.string(), id: z.uuid() }) }).nullable().parse(await dbRpc('studio_claim_role_work', { p_workspace: workspace, p_role: 'all' }));
    if (!claim) break;
    if (claim.message.type === 'task_run') { queuedResearch++; assert.equal(claim.message.id, accepted.runId); }
    assert.equal(await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token }), true);
  }
  assert.equal(queuedResearch, 1);
  console.log(JSON.stringify({ workspace, realSupabase: true, actualHttpRoute: true, duplicateRequests: 2, queuedResearch, sameDraftAndRevisionPreserved: true, staleHttpRejected: true, staleDatabaseCasRejected: true, missingAndLegacyRejected: true, workersInvoked: 0, modelCalls: 0, publicPosts: 0 }));
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  for (let index = 0; index < 20; index++) {
    const claim = z.object({ msgId: z.number(), token: z.uuid() }).nullable().parse(await dbRpc('studio_claim_role_work', { p_workspace: workspace, p_role: 'all' }));
    if (!claim) break;
    await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token });
  }
  for (const table of ['studio_research_steps', 'studio_task_runs', 'studio_tasks', 'studio_operations', 'studio_revisions', 'studio_editor_state', 'studio_queue_leases', 'studio_article_commands', 'content_studio_workspaces']) {
    const path = `${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspace}`;
    await dbRequest(path, { method: 'DELETE' }); assert.deepEqual(await dbRequest(path), []);
  }
  process.env = environment; await rm(directory, { recursive: true, force: true });
}
