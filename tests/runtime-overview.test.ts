import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { jobSchema, type Job } from '../src/core/model.ts';
import { summarizeRuntimeActivity, summarizeRuntimeSetup, safeRuntimeError, safeRuntimePhase, type RunSummary } from '../src/core/runtime-overview.ts';

const at = '2026-10-14T00:00:00.000Z';
const job = (change: Partial<Job> = {}): Job => jobSchema.parse({ id: randomUUID(), draftId: randomUUID(), platform: 'reddit', accountId: randomUUID(), approvedHash: '', status: 'needs_reconciliation', scheduledAt: at, createdAt: at, provider: 'postiz', remoteId: null, remoteUrl: null, attempts: 1, error: null, history: [], ...change });
const run = (): RunSummary => ({ id: randomUUID(), task_id: randomUUID(), draft_id: randomUUID(), status: 'failed', phase: 'master_saved', progress: 50, attempt: 1, updated_at: at, error: '/private/user/article body with token=secret-value' });
test('setup checks cached model catalog separately from authorization and acceptance', () => {
  const summary = summarizeRuntimeSetup({ readiness: { runtime: 'docker', database: 'supabase', stateReadable: true, localServices: { database: true, pgmq: true, pg_cron: true }, modelCount: 8, codexAvailable: false, modelRunner: { ready: false }, dataDirectory: '/private/owner', stateError: 'secret' }, state: { paused: true, accounts: [] }, bridge: { configured: false, connected: false }, knowledge: { configured: false, available: false, importedSources: 0, mountFiles: 0 }, capabilities: [] }, at);
  assert.equal(summary.scope, 'existing_instance'); assert.equal(summary.steps.find(step => step.id === 'database')?.status, 'ready');
  assert.equal(summary.steps.find(step => step.id === 'model')?.status, 'action_required'); assert.equal(summary.acceptance, 'requires_evidence');
  assert.equal(summary.publishingPaused, true); assert.equal(summary.steps.some(step => step.actions.some(action => action.endpoint === 'pause' || action.endpoint === 'runtime/scheduler')), false);
  assert.doesNotMatch(JSON.stringify(summary), /\/private\/owner|secret/u);
});
test('unavailable dependencies stay blocked and errors disclose no raw values', () => {
  const summary = summarizeRuntimeSetup({ readiness: null, state: null, bridge: null, knowledge: null, capabilities: [] }, at);
  assert.equal(summary.runtime, 'unknown'); assert.equal(summary.publishingPaused, null); assert.equal(summary.schedulerEnabled, null);
  assert.equal(summary.steps.find(step => step.id === 'database')?.status, 'blocked');
  for (const error of ['Bearer sk-secret private body', '/Users/person/file.md source excerpt', 'access_token=secret', 'Supabase failed token=secret']) assert.doesNotMatch(safeRuntimeError(error) ?? '', /secret|Bearer|\/Users|excerpt/u);
  assert.equal(safeRuntimeError(null), null); assert.equal(safeRuntimePhase('randomcredential_saved', 'running'), 'running');
});
test('activity preserves task progress, parent-child relations and independent domains', () => {
  const parent = randomUUID(); const child = run(); const article = job({ draftId: child.draft_id }); const video = job({ draftId: null, subject: { kind: 'video', id: randomUUID(), revision: 2 } });
  const summary = summarizeRuntimeActivity({ runs: [child], operations: [], renders: [], jobs: [article, video], paused: true, promotions: [{ childRunId: child.id, parentRunId: parent }] }, at);
  assert.equal(summary.items.find(item => item.id === child.id)?.parentId, parent); assert.equal(summary.items.find(item => item.id === child.id)?.progress, 50);
  assert.equal(summary.items.find(item => item.id === article.id)?.parentId, child.id);
  assert.equal(summary.items.find(item => item.id === video.id)?.kind, 'video_delivery');
  assert.ok(summary.items.filter(item => item.kind.endsWith('delivery')).every(item => item.progress === null)); assert.doesNotMatch(JSON.stringify(summary), /secret-value|article body|\/private/u);
});
test('uncertain publication exposes reconciliation only, never submission or retry', () => {
  const unknown = job(); const nativeDraft = job({ provider: 'native', platform: 'wechat', deliveryAction: 'save_draft', status: 'failed', attempts: 1 });
  const youtube = job({ provider: 'native', platform: 'youtube', draftId: null, subject: { kind: 'video', id: randomUUID(), revision: 1 } });
  const summary = summarizeRuntimeActivity({ runs: [], operations: [], renders: [], jobs: [unknown, nativeDraft, youtube], paused: true });
  assert.equal(summary.items.find(item => item.id === unknown.id)?.actions.find(action => action.endpoint)?.endpoint, `jobs/${unknown.id}/reconcile`);
  assert.equal(summary.items.find(item => item.id === youtube.id)?.actions.find(action => action.endpoint)?.endpoint, `jobs/${youtube.id}/continue`);
  assert.equal(summary.items.find(item => item.id === nativeDraft.id)?.actions.some(action => action.endpoint), false);
  assert.ok(summary.items.every(item => item.actions.every(action => !action.endpoint?.endsWith('/retry') && !action.label.includes('继续原发布'))));
});
test('safe known failure reuses the original recovery endpoints', () => {
  const failedRun = run(); const failed = job({ status: 'failed', attempts: 0 });
  const summary = summarizeRuntimeActivity({ runs: [failedRun], operations: [], renders: [], jobs: [failed], paused: true });
  assert.equal(summary.items.find(item => item.id === failed.id)?.actions.find(action => action.endpoint)?.endpoint, `jobs/${failed.id}/continue`);
  assert.equal(summary.items.find(item => item.id === failedRun.id)?.actions.find(action => action.endpoint)?.endpoint, `runs/${failedRun.id}/retry`);
});
test('operation and render summaries never invent progress or operation attempts', () => {
  const operationId = randomUUID(); const projectId = randomUUID(); const renderId = randomUUID();
  const summary = summarizeRuntimeActivity({ runs: [], jobs: [], paused: false, operations: [{ id: operationId, draft_id: null, subject_id: projectId, subject_kind: 'video', job_id: null, kind: 'video_render', status: 'running', phase: 'Rendering source /private/name with sk-secret', updated_at: at, error: null }], renders: [{ id: renderId, projectId, operationId, status: 'running', phase: 'rendering', attempt: 2, heartbeatAt: at, finishedAt: null, error: null }] });
  assert.equal(summary.items.find(item => item.id === operationId)?.attempt, null); assert.equal(summary.items.find(item => item.id === renderId)?.attempt, 2); assert.equal(summary.items.find(item => item.id === renderId)?.parentId, operationId);
  assert.ok(summary.items.every(item => item.progress === null)); assert.doesNotMatch(JSON.stringify(summary), /private|sk-secret/u);
});

test('failed channel authorization directs the operator to account setup without a publication action', () => {
  const summary = summarizeRuntimeActivity({ paused: true, jobs: [], runs: [], renders: [], operations: [{ id: randomUUID(), draft_id: null, subject_kind: 'article', subject_id: null, kind: 'delivery_recovery', recovery_action: 'verify_channel', status: 'failed', phase: 'failed', updated_at: at, error: 'YouTube request failed; reconcile the saved upload before any new submission.', job_id: null }] });
  const item = summary.items[0]; assert.ok(item);
  assert.deepEqual(item.actions, [{ label: '查看原工作区', view: 'accounts' }]);
  assert.doesNotMatch(item.error ?? '', /原任务|原提交|重新上传/u);
  assert.equal(item.progress, null);
});
