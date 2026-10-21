// Real isolated Supabase/pgmq + HTTP + worker; every model reply and source is a fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';

if (!process.argv.includes('--confirm-isolated-database')) throw new Error('Use --confirm-isolated-database.');
if (process.env.STUDIO_CONTAINER !== 'true' || new URL(process.env.SUPABASE_URL ?? '').hostname !== 'kong') throw new Error('Use an isolated local Docker Supabase network.');
const environment = { ...process.env }; const actualFetch = globalThis.fetch;
const workspace = randomUUID(); const taskId = randomUUID(); const draftId = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'studio-refresh-worker-'));
process.env.STUDIO_WORKSPACE_ID = workspace; process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_LOCALFS_DIR = directory; process.env.STUDIO_WORKER_ROLE = 'article';
const { dbRequest, dbRpc } = await import('../src/core/database.ts');
const { readState, mutateState } = await import('../src/core/store.ts');
const { draftSchema } = await import('../src/core/model.ts');
const { taskSchema } = await import('../src/core/task-model.ts');
const { evidenceDocumentSchema, claimSchema, qualityReportSchema } = await import('../src/contracts/research.ts');
const { evidenceApi } = await import('../src/server/evidence-api.ts');
const { configureTaskRuntime, createTask, getTask, getTaskRun, retryTaskRun, updateTask } = await import('../src/core/tasks.ts');
const { runWorkerOnce } = await import('../src/server/worker.ts');
const { approveDraft, replaceDraft, verifyDraftApproval } = await import('../src/core/pipeline.ts');
const { assertDraftQuality, draftQuality } = await import('../src/core/quality.ts');
const { EvidenceFiles, evidenceHash, documentChunks } = await import('../src/core/evidence.ts');
const { productionContentHash } = await import('../src/core/production.ts');
const timestamp = new Date().toISOString(); const files = new EvidenceFiles();
const task = taskSchema.parse({ id: taskId, createdAt: timestamp, updatedAt: timestamp, nextRunAt: null, title: 'Isolated refresh fixture', prompt: 'Explain immutable software revisions from supplied sources.', pipelineVersion: 2, model: 'fixture-never-executed', platforms: ['zhihu'], kind: 'content', enabled: false, frequency: { type: 'once', time: '09:00', timezone: 'UTC' } });
const text = 'Software revisions preserve prior bytes. A new edit creates a distinct immutable version. This permits restoration to the previous version.';
const questions = ['How do immutable software revisions support recovery?']; const documentId = evidenceHash('isolated-refresh-worker-document');
const document = evidenceDocumentSchema.parse({ id: documentId, sourceId: 'fixture', url: 'https://example.org/revisions', title: 'Synthetic revision reference', publisher: 'Fixture only', publishedAt: timestamp, fetchedAt: timestamp, sha256: await files.put({ text }), parserVersion: 'fixture', access: 'full', category: 'primary', chunks: documentChunks(documentId, text) });
const claim = claimSchema.parse({ id: 'revision', text: 'Software revisions preserve prior bytes.', critical: true, kind: 'fact', status: 'supported', evidence: [{ documentId, chunkId: document.chunks[0]!.id, quote: 'Software revisions preserve prior bytes.' }], caveat: '' });
const body = `${claim.text}\n${document.url}`; const bundle = { documents: [document], warnings: [], queries: questions }; const bundleRef = await files.put(bundle);
const draft = draftSchema.parse({ id: draftId, revision: 1, createdAt: timestamp, approvedHash: null, title: 'Synthetic revision fixture', body, generationEvidenceRunId: draftId, brief: { topic: task.title, audience: 'Acceptance operator', angle: 'Check revision-bound research requests.', sources: [{ title: document.title, url: document.url, excerpt: claim.evidence[0]!.quote }], evidenceDocumentIds: [documentId], platforms: ['zhihu'] }, variants: [{ platform: 'zhihu', title: 'Synthetic revision fixture', text: body, tags: [], mediaPaths: [], format: 'article' }] });
const report = qualityReportSchema.parse({ status: 'passed', contentHash: productionContentHash(draft, draft.variants), evidenceHash: evidenceHash(bundle.documents), draftRevision: 1, checkedAt: timestamp, claims: [claim], issues: [], checks: [], model: task.model, guidanceVersion: 'fixture', judgement: 'model_assisted' });
let mockModelCalls = 0; let editDuringGeneration: (() => Promise<void>) | null = null; let interruptLinkForRun: string | null = null;
const check = { assessment: { status: 'allowed', reasons: ['Synthetic evidence supports the synthetic claim.'] }, claims: [claim], issues: [], contribution: true, titleFulfilled: true, originality: true };
configureTaskRuntime({
  resolveImagePaths: async () => [],
  research: async () => { throw new Error('External source research is forbidden in this fixture.'); },
  structured: async (schema, prompt) => {
    mockModelCalls++;
    if (prompt.startsWith('Plan a useful')) return schema.parse({ assessment: check.assessment, questions, contribution: 'A synthetic recovery checklist.', kind: 'explanation' });
    if (prompt.startsWith('Build atomic')) return schema.parse({ claims: [claim], gaps: [] });
    if (prompt.startsWith('Independently extract') || prompt.startsWith('Check this platform')) return schema.parse(check);
    throw new Error('Unexpected model phase in the isolated fixture.');
  },
  generateMaster: async () => { mockModelCalls++; if (editDuringGeneration) { const edit = editDuringGeneration; editDuringGeneration = null; await edit(); } return { title: 'Regenerated synthetic revision', body }; },
  adaptMaster: async () => { mockModelCalls++; return { platform: 'zhihu', title: 'Regenerated synthetic revision', text: body, tags: [], mediaPaths: [], format: 'article' }; },
});
const app = express(); app.use(express.json()); app.use('/api', evidenceApi);
let fixtureCatalogReads = 0; app.get('/models', (_req, res) => { fixtureCatalogReads++; res.sendStatus(503); });
const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => { const message = error instanceof Error ? error.message : 'Request failed.'; res.status(/revision|changed/iu.test(message) ? 409 : 400).json({ error: message }); }; app.use(errors);
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`; const databaseOrigin = new URL(process.env.SUPABASE_URL!).origin;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (![origin, databaseOrigin].includes(url.origin)) throw new Error('External network access is forbidden in this fixture.');
  if (url.pathname.endsWith('/rpc/studio_patch_task_run') && interruptLinkForRun) {
    const request = z.object({ p_run: z.string(), p_patch: z.record(z.string(), z.unknown()) }).parse(JSON.parse(String(init?.body)));
    if (request.p_run === interruptLinkForRun && request.p_patch.draftId) { interruptLinkForRun = null; return Response.json(null); }
  }
  return actualFetch(input, init);
};
const acceptedSchema = z.object({ runId: z.uuid(), draftId: z.uuid(), expectedRevision: z.number().int().positive(), accepted: z.literal(true) });
async function currentDraft() { const current = (await readState()).drafts.find(item => item.id === draftId); assert.ok(current); return current; }
async function refresh(revision: number) {
  const response = await fetch(`${origin}/api/drafts/${draftId}/quality/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision }) });
  assert.equal(response.status, 202); const accepted = acceptedSchema.parse(await response.json()); assert.equal(accepted.expectedRevision, revision); return accepted;
}
async function prepareBundle(runId: string) {
  const run = await getTaskRun(runId);
  await dbRequest('studio_research_steps', { method: 'POST', body: { workspace_id: workspace, run_id: runId, stage: 'evidence_bundle', input_hash: evidenceHash({ task: run.taskSnapshot, questions }), status: 'completed', attempts: 1, artifact_ref: bundleRef } });
}
async function finish(runId: string) {
  for (let index = 0; index < 30; index++) {
    const run = await getTaskRun(runId); if (!['queued', 'researching', 'generating'].includes(run.status)) return run;
    assert.equal(await runWorkerOnce(), true, 'Fixture research must have runnable durable work.');
  }
  throw new Error('Isolated research did not reach a terminal status.');
}
async function editVariant(note: string) {
  const current = await currentDraft();
  return replaceDraft(draftId, { title: current.title, body: current.body, ...(current.document ? { document: current.document } : {}), variants: current.variants.map(variant => ({ ...variant, text: `${variant.text}\n${note}` })) }, current.revision);
}
try {
  await mutateState(state => { state.paused = true; });
  await dbRequest('studio_tasks', { method: 'POST', body: { id: taskId, workspace_id: workspace, config: task } });
  await dbRequest('studio_task_runs', { method: 'POST', body: { id: draftId, workspace_id: workspace, task_id: taskId, slot: 'fixture-succeeded-lineage', task_snapshot: task, status: 'succeeded', draft_id: draftId } });
  await prepareBundle(draftId);
  await dbRequest('studio_research_steps', { method: 'POST', body: { workspace_id: workspace, run_id: draftId, stage: 'quality_final', input_hash: 'a'.repeat(64), status: 'completed', attempts: 1, artifact_ref: await files.put(report) } });
  await dbRpc('studio_commit_article', { p_workspace: workspace, p_command: randomUUID(), p_expected_revision: 0, p_content: draft });
  await assertDraftQuality(workspace, await currentDraft()); assert.ok((await approveDraft(draftId, 1)).approvedHash);
  const edited = await editVariant('An operator editorial note.'); assert.equal(edited.revision, 2); assert.equal(edited.approvedHash, null);
  assert.equal((await draftQuality(workspace, edited)).current, false); await assert.rejects(assertDraftQuality(workspace, edited), /changed/);
  const accepted = await refresh(2); for (const value of await Promise.all([refresh(2), refresh(2)])) assert.deepEqual(value, accepted);
  assert.deepEqual((await getTaskRun(accepted.runId)).refreshTarget, { draftId, expectedRevision: 2, reason: 'review_requested' }); assert.deepEqual(await currentDraft(), edited);
  await prepareBundle(accepted.runId);
  // Fault after the actual revision commit: recovery must reuse the same model/checkpoint results.
  interruptLinkForRun = accepted.runId; assert.equal((await finish(accepted.runId)).status, 'failed');
  const committed = await currentDraft(); assert.equal(committed.revision, 3); assert.equal(committed.generationEvidenceRunId, accepted.runId); assert.equal(committed.createdAt, draft.createdAt); assert.equal(committed.approvedHash, null);
  const callsAtCommit = mockModelCalls; assert.equal(callsAtCommit, 6); assert.equal((await draftQuality(workspace, committed)).current, false);
  await retryTaskRun(accepted.runId); assert.equal((await finish(accepted.runId)).status, 'succeeded'); assert.equal(mockModelCalls, callsAtCommit); assert.deepEqual(await currentDraft(), committed);
  const quality = await draftQuality(workspace, committed); assert.equal(quality.current, true); assert.equal(quality.report?.draftRevision, 3); assert.equal('runId' in quality ? quality.runId : null, accepted.runId);
  await assertDraftQuality(workspace, committed); await assert.rejects(verifyDraftApproval(committed), /approve|approval/u);
  const history = z.array(z.object({ revision: z.number(), content: draftSchema })).parse(await dbRequest(`studio_revisions?workspace_id=eq.${workspace}&draft_id=eq.${draftId}&order=revision.asc&select=revision,content`));
  assert.deepEqual(history.map(item => item.revision), [1, 2, 3]); assert.equal(history[1]?.content.variants[0]?.text, edited.variants[0]?.text);
  await dbRpc('studio_enqueue_work', { p_workspace: workspace, p_type: 'task_run', p_id: accepted.runId });
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Exports and duplicate delivery only. */ }
  assert.equal(mockModelCalls, callsAtCommit); assert.deepEqual(await currentDraft(), committed);
  // A target already stale before execution must not spend new model budget.
  const stale = await refresh(3); await prepareBundle(stale.runId); const newer = await editVariant('A newer operator note before execution.');
  assert.equal((await finish(stale.runId)).status, 'failed'); assert.equal(mockModelCalls, callsAtCommit); assert.deepEqual(await currentDraft(), newer);
  // An edit during execution must still survive the final compare-and-swap boundary.
  const race = await refresh(newer.revision); await prepareBundle(race.runId); let during = newer;
  editDuringGeneration = async () => { during = await editVariant('An operator note during generation.'); };
  assert.equal((await finish(race.runId)).status, 'failed'); assert.equal(mockModelCalls, callsAtCommit + 6); assert.deepEqual(await currentDraft(), during); assert.equal((await draftQuality(workspace, during)).current, false);
  const recovered = await refresh(during.revision); await prepareBundle(recovered.runId); assert.equal((await finish(recovered.runId)).status, 'succeeded');
  const final = await currentDraft(); assert.equal(final.revision, during.revision + 1); assert.equal(final.generationEvidenceRunId, recovered.runId); assert.equal(final.approvedHash, null); await assertDraftQuality(workspace, final);
  const finalHistory = z.array(z.object({ revision: z.number() })).parse(await dbRequest(`studio_revisions?workspace_id=eq.${workspace}&draft_id=eq.${draftId}&order=revision.asc&select=revision`)); assert.deepEqual(finalHistory.map(item => item.revision), [1, 2, 3, 4, 5, 6]);
  // A model outage must not prevent stopping or preserving an already configured task.
  await dbRequest(`studio_tasks?workspace_id=eq.${workspace}&id=eq.${taskId}`, { method: 'PATCH', body: { config: { ...task, enabled: true }, next_run_at: null } });
  process.env.STUDIO_MODEL_EXECUTOR_URL = origin;
  const paused = await updateTask(taskId, { ...task, enabled: false }); assert.equal(paused.enabled, false);
  const schedule = { type: 'daily' as const, time: '11:20', timezone: 'UTC' };
  const maintained = await updateTask(taskId, { ...paused, frequency: schedule }); assert.deepEqual(maintained.frequency, schedule); assert.equal(fixtureCatalogReads, 0);
  await assert.rejects(updateTask(taskId, { ...maintained, enabled: true }), /model-runner/);
  await assert.rejects(updateTask(taskId, { ...maintained, model: 'unavailable-other-model' }), /model-runner/);
  await assert.rejects(createTask({ ...maintained, enabled: false }, randomUUID()), /model-runner/);
  const persisted = await getTask(taskId); assert.equal(persisted.enabled, false); assert.equal(persisted.model, task.model); assert.deepEqual(persisted.frequency, schedule); assert.equal(fixtureCatalogReads, 3);
  const state = await readState(); assert.equal(state.jobs.length, 0); assert.equal(state.accounts.length, 0); assert.equal(state.paused, true);
  console.log(JSON.stringify({ realSupabase: true, realPgmqWorker: true, actualHttpRoute: true, duplicateRequests: 2, editedRevision: 2, refreshedRevision: 3, recoveredRevision: final.revision, historyPreserved: true, sameRunPostCommitRecovery: true, duplicateDeliveryNoModelReplay: true, staleBeforeExecutionNoModelCalls: true, concurrentEditPreserved: true, offlineMaintenancePersisted: true, newAdmissionsRejected: fixtureCatalogReads, fixtureModelCalls: mockModelCalls, liveModelCalls: 0, livePlatformCalls: 0, publicPosts: 0 }));
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  for (let index = 0; index < 30; index++) {
    const claim = z.object({ msgId: z.number(), token: z.uuid() }).nullable().parse(await dbRpc('studio_claim_role_work', { p_workspace: workspace, p_role: 'all' })); if (!claim) break;
    await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token });
  }
  for (const table of ['studio_research_steps', 'studio_run_events', 'studio_task_runs', 'studio_tasks', 'studio_operations', 'studio_revisions', 'studio_editor_state', 'studio_queue_leases', 'studio_article_commands', 'content_studio_workspaces']) {
    const path = `${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspace}`; await dbRequest(path, { method: 'DELETE' }); assert.deepEqual(await dbRequest(path), []);
  }
  globalThis.fetch = actualFetch; process.env = environment; await rm(directory, { recursive: true, force: true });
}
