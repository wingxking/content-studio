import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { contentPage, pageInputSchema, publicArticleOperation, runsPage } from '../src/application/workspace.ts';
import { draftSchema, emptyState } from '../src/core/model.ts';
import { taskSchema } from '../src/core/task-model.ts';
import { workspaceApi } from '../src/server/workspace-api.ts';

const environment = { ...process.env }; const nativeFetch = globalThis.fetch; let root = ''; let workspace = '';
const at = '2026-10-15T01:00:00.000Z';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'studio-workspace-contracts-')); workspace = randomUUID(); process.env.STUDIO_DATA_DIR = root; process.env.STUDIO_WORKSPACE_ID = workspace; process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'isolated-fixture-key'; delete process.env.STUDIO_CONTAINER; });
afterEach(async () => { globalThis.fetch = nativeFetch; process.env = { ...environment }; await rm(root, { recursive: true, force: true }); });
function task() { return taskSchema.parse({ id: randomUUID(), title: 'Editor tips', prompt: 'Research practical editor tips.', model: 'fixture-model', platforms: ['reddit'], kind: 'content', frequency: { type: 'once', time: '09:00', timezone: 'Asia/Singapore' }, enabled: false, createdAt: at, updatedAt: at, nextRunAt: null }); }
function runRow() { const snapshot = task(); return { id: randomUUID(), task_id: snapshot.id, slot: 'manual:fixture', task_snapshot: snapshot, status: 'succeeded', phase: 'completed', progress: 100, attempt: 1, error: null, warnings: [], questions: [], sources: [], master: { title: 'Editor tips', body: 'Save before closing.' }, variants: [{ platform: 'reddit', title: 'Save work', text: 'Save before closing.', tags: [], mediaPaths: [] }], draft_id: randomUUID(), output_paths: { master: 'master.md', package: 'package.json', platforms: { reddit: 'reddit.md' } }, started_at: at, finished_at: at, created_at: at, updated_at: at }; }
async function request(path: string): Promise<Response> {
  const app = express(); app.use('/api', workspaceApi); const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => { res.status(400).json({ error: error instanceof Error ? error.message : 'Request failed.' }); }; app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try { const response = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${path}`); const body = await response.arrayBuffer(); return new Response(body, { status: response.status, headers: response.headers }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('content pages enforce bounded filters and a stable timestamp-plus-ID cursor without exposing backend fields', async () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse(); const requests: Record<string, unknown>[] = [];
  const items = ids.map(id => ({ id, kind: 'article', title: 'Editor tips', revision: 1, platforms: ['reddit'], createdAt: at, updatedAt: at, status: 'draft', taskId: null, runId: null, sourcePath: '/private/raw-worker-file', document: 'raw body must not be in a list' }));
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); assert(url.pathname.endsWith('/rpc/studio_list_content')); assert.equal(init?.method, 'POST');
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body))); requests.push(body); assert.equal(body.p_workspace, workspace); assert.equal(body.p_limit, 3);
    return Response.json(body.p_before ? [items[2]] : items);
  };
  const taskId = randomUUID(); const batchId = randomUUID();
  const first = await contentPage({ limit: '2', platform: 'reddit', taskId, runId: batchId, from: at, to: at });
  assert.equal(first.items.length, 2); assert(first.nextCursor); assert(!JSON.stringify(first).includes('/private')); assert(!JSON.stringify(first).includes('raw body'));
  const second = await contentPage({ limit: 2, cursor: first.nextCursor }); assert.equal(second.items[0]?.id, ids[2]); assert.equal(second.nextCursor, null);
  assert.equal(requests[0]?.p_task, taskId); assert.equal(requests[0]?.p_run, batchId); assert.equal(requests[0]?.p_from, at); assert.equal(requests[0]?.p_to, at);
  assert.equal(requests[1]?.p_before, at); assert.equal(requests[1]?.p_before_id, ids[1]);
  for (const value of [{ limit: 0 }, { limit: 101 }, { platform: 'invented' }, { status: 'draft&limit=1000' }]) assert.throws(() => pageInputSchema.parse(value));
  await assert.rejects(contentPage({ cursor: 'invalid-cursor' })); assert.equal(requests.length, 2);
});

test('execution summaries request bounded projections and drop source bodies, media paths and output paths', async () => {
  const row = runRow(); let calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls++; assert.equal(init?.method, 'GET'); assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`); assert.equal(url.searchParams.get('limit'), '3');
    const selected = (url.searchParams.get('select') ?? '').split(',');
    for (const field of ['sources', 'master', 'variants', 'output_paths']) assert(!selected.includes(field));
    return Response.json([{ ...row, sources: [{ title: 'Raw excerpt', url: 'https://example.com/manual', excerpt: 'raw source excerpt' }], master: { title: 'Raw master', body: 'raw source excerpt' }, variants: [{ ...row.variants[0], mediaPaths: ['/private/raw.mp4'] }], output_paths: { master: '/private/master.md' } }]);
  };
  const summary = await runsPage({ limit: 2, taskId: row.task_id, status: 'succeeded' }); assert.equal(calls, 1);
  assert.deepEqual(summary.items[0]?.sources, []); assert.deepEqual(summary.items[0]?.variants, []); assert.equal(summary.items[0]?.master, null); assert.equal(summary.items[0]?.outputPaths, null);
  assert.doesNotMatch(JSON.stringify(summary), /\/private|raw source excerpt/u);
});

test('opening an article editor uses read requests only and exposes stable media references', async () => {
  const draft = draftSchema.parse({ id: randomUUID(), title: 'Editor tips', body: 'Save before closing.', brief: { topic: 'Editor tips', audience: 'New users', angle: 'Practical steps', sources: [{ title: 'Manual', url: 'https://example.com/manual', excerpt: 'Save first.' }], platforms: ['reddit'] }, variants: [{ platform: 'reddit', title: 'Save work', text: 'Use Save.', tags: [], mediaPaths: ['/private/worker/original.png'] }], revision: 1, createdAt: at, approvedHash: null });
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname); assert(!init?.method || init.method === 'GET');
    if (url.pathname.endsWith('/content_studio_workspaces')) return Response.json([{ id: workspace, revision: 1, state: { ...emptyState(), drafts: [draft] } }]);
    if (url.pathname.endsWith('/studio_revisions')) return Response.json([{ content: draft, created_at: at }]);
    if (['studio_operations', 'studio_videos', 'studio_editor_state'].some(table => url.pathname.endsWith(`/${table}`))) return Response.json([]);
    throw new Error('Opening the editor must not register revisions, create tasks or export files.');
  };
  const response = await request(`workspace/articles/${draft.id}/editor`); assert.equal(response.status, 200); const editor = z.object({ draft: draftSchema, history: z.array(draftSchema) }).parse(await response.json());
  assert.equal(editor.draft.variants[0]?.mediaPaths[0], `studio-article-media:${draft.id}:1:reddit:0`); assert(!JSON.stringify(editor).includes('/private'));
  assert.equal(editor.history.length, 1); assert(paths.length >= 4); assert.deepEqual(await readdir(root), []);
});

test('execution detail GET preserves frozen guidance while hiding physical output references and worker diagnostics', async () => {
  const row = { ...runRow(), guidance_version: 'frozen-guidance-v1', error: '/private/worker/error token=fixture', warnings: ['/private/worker/log token=fixture'], variants: [{ platform: 'reddit', title: 'Save', text: 'Save first.', tags: [], mediaPaths: ['/private/worker/video.mp4'] }], output_paths: { master: '/private/worker/master.md', package: '/private/worker/package.json', platforms: { reddit: '/private/worker/reddit.md' } } };
  let reads = 0;
  globalThis.fetch = async (input, init) => { const url = new URL(String(input)); reads++; assert.equal(init?.method, 'GET'); assert(url.pathname.endsWith('/studio_task_runs')); return Response.json([row]); };
  const response = await request(`workspace/runs/${row.id}`); assert.equal(response.status, 200); const details = z.record(z.string(), z.unknown()).parse(await response.json());
  assert.equal(details.guidanceVersion, 'frozen-guidance-v1'); assert.doesNotMatch(JSON.stringify(details), /\/private|token=fixture/u);
  assert.equal(reads, 1); assert.deepEqual(await readdir(root), []);
});

test('article operation checkpoints expose reviewed content without worker baselines or private inputs', () => {
  const draft = draftSchema.parse({ id: randomUUID(), title: 'Save work', body: 'Save first.', brief: { topic: 'Editor tips', audience: 'New users', angle: 'Steps', sources: [{ title: 'Manual', url: 'https://example.com/manual', excerpt: 'Save first.' }], platforms: ['reddit'] }, variants: [{ platform: 'reddit', title: 'Save work', text: 'Save first.', tags: [], mediaPaths: ['/private/original.png'] }], revision: 2, createdAt: at, approvedHash: null });
  const operation = { id: randomUUID(), draftId: draft.id, subjectKind: 'article' as const, subjectId: draft.id, kind: 'sync' as const, status: 'running' as const, phase: 'Applying adapted content', input: { expectedRevision: 2, privateFile: '/private/context.json' }, output: { proposal: { title: 'Updated', body: 'Save twice.', variants: draft.variants }, baselines: draft.variants, checkpoint: '/private/checkpoint.json', conflicts: ['reddit.text'], applying: true }, error: null, createdAt: at, updatedAt: at };
  const presented = publicArticleOperation(operation, draft);
  const output = z.object({ proposal: draftSchema, conflicts: z.array(z.string()), applying: z.boolean() }).parse(presented.output);
  assert.deepEqual(presented.input, { expectedRevision: 2 });
  assert.deepEqual(output.conflicts, ['reddit.text']); assert.equal(output.applying, true);
  assert.equal(output.proposal.variants[0]?.mediaPaths[0], `studio-article-media:${draft.id}:2:reddit:0`);
  assert.doesNotMatch(JSON.stringify(presented), /\/private|baselines|checkpoint|privateFile/u);
  assert.deepEqual(publicArticleOperation({ ...operation, output: { applied: true, baselines: draft.variants } }, draft).output, { applied: true });
});
