import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { emptyState } from '../src/core/model.ts';
import { runtimeActivity, runtimeKnowledgeSummary } from '../src/server/runtime-api.ts';
import { KnowledgeStore } from '../src/core/knowledge.ts';

const environment = { ...process.env }; const originalFetch = globalThis.fetch;
let directory = ''; let workspace = '';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'runtime-summary-')); workspace = randomUUID(); process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_WORKSPACE_ID = workspace; process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'private-fixture-key'; });
afterEach(async () => { globalThis.fetch = originalFetch; process.env = { ...environment }; await rm(directory, { recursive: true, force: true }); });
test('activity selects scoped summaries and survives a failing dependency without raw errors', async () => {
  const requests: URL[] = []; const operationId = randomUUID(); const subjectId = randomUUID(); const at = '2026-10-14T00:00:00+00:00';
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); requests.push(url); assert.ok(!options?.method || options.method === 'GET');
    if (url.pathname.endsWith('content_studio_workspaces')) return Response.json([{ id: workspace, state: { ...emptyState(), paused: true }, revision: 0 }]);
    assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`);
    if (url.pathname.endsWith('studio_operations')) { assert.match(url.searchParams.get('select') ?? '', /job_id:input->>jobId/u); assert.doesNotMatch(url.searchParams.get('select') ?? '', /\boutput\b|\binput\b(?!->>(?:jobId|action))/u); return Response.json([{ id: operationId, draft_id: null, subject_kind: 'video', subject_id: subjectId, kind: 'video_render', status: 'running', phase: '/private/prompt output token=secret', updated_at: at, error: null, job_id: null }]); }
    if (url.pathname.endsWith('studio_task_runs')) throw new Error('/Users/owner/secret raw source body');
    return Response.json([]);
  };
  const activity = await runtimeActivity(); assert.equal(activity.publishingPaused, true); assert.equal(activity.items[0]?.id, operationId); assert.equal(activity.items[0]?.updatedAt, '2026-10-14T00:00:00.000Z');
  assert.ok(activity.warnings.includes('任务运行摘要暂不可读取。')); assert.equal(requests.length, 5); assert.doesNotMatch(JSON.stringify(activity), /private|secret|source body|\/Users/u);
});
test('unconfigured workspaces return a safe setup warning without accessing the database', async () => {
  delete process.env.STUDIO_WORKSPACE_ID; globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  const activity = await runtimeActivity(); assert.equal(activity.items.length, 0); assert.equal(activity.publishingPaused, null); assert.deepEqual(activity.warnings, ['工作区尚未配置，请先检查 Docker 配置。']);
});
test('an unavailable optional mount preserves the usable uploaded knowledge library', async () => {
  const missingMount = join(directory, 'disconnected-mount');
  process.env.STUDIO_KNOWLEDGE_IMPORT_DIR = missingMount;
  const store = new KnowledgeStore(join(directory, 'knowledge'), missingMount);
  const source = await store.upload('brand-guide.md', Buffer.from('Use clear descriptions and cite primary sources.'));
  const summary = await runtimeKnowledgeSummary(store);
  assert.deepEqual(summary, { configured: true, available: false, importedSources: 1, mountFiles: 0 });
  assert.match((await store.excerpt(source.id)).excerpt, /primary sources/u);
  assert.doesNotMatch(JSON.stringify(summary), /disconnected-mount|brand-guide/u);
});
