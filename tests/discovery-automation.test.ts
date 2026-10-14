import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { taskInputSchema, taskRunSchema } from '../src/core/task-model.ts';
import { listDiscoveryPromotions, repairDiscoveryPromotions } from '../src/core/discovery-automation.ts';
import { configureTaskRuntime, processTaskRun } from '../src/core/tasks.ts';

const environment = { ...process.env }; const fetcher = globalThis.fetch; let directory = '';
const workspace = '8e800d99-f702-4cff-9fd3-80c0bfb83938';
const parentId = 'da8b5ee3-a27d-4eea-9658-7a7575ca4761';
const taskId = 'd3e47fc8-67a8-4378-a3b3-4fddf0a19c51';
const timestamp = '2026-10-14T00:00:00.000Z';
const source = { title: 'Verified fixture evidence', url: 'https://example.org/software', excerpt: 'Substantive fixture evidence. This does not represent a real researched article.' };
const config = () => taskInputSchema.parse({ title: 'Discovery fixture', prompt: 'Find permitted useful software topics.', model: 'fixture-model', platforms: ['x', 'reddit'], kind: 'discovery', enabled: true, discoveryAutomation: { enabled: true, maxDrafts: 2 }, knowledgeIds: ['b1345c11-5907-4529-ae0a-5d65cd12a36d'], frequency: { type: 'daily', time: '09:00', timezone: 'Asia/Singapore' } });
const run = () => taskRunSchema.parse({ id: parentId, taskId, slot: 'fixture', taskSnapshot: { ...config(), id: taskId, createdAt: timestamp, updatedAt: timestamp, nextRunAt: timestamp },
  status: 'succeeded', phase: 'completed', progress: 100, attempt: 1, error: null, warnings: [], sources: [source],
  questions: [1, 2, 3].map(index => ({ question: `Useful software question ${index}?`, audienceNeed: 'Help software users.', angle: 'Practical evidence-backed guide.', sourceUrls: [source.url], platforms: ['x'], assessment: { status: 'allowed', reasons: ['Useful software evidence.'] } })),
  master: null, variants: [], draftId: null, outputPaths: null, startedAt: timestamp, finishedAt: timestamp, createdAt: timestamp, updatedAt: timestamp });
function relation(index: number) { return { id: 'd8f929cf-7c67-4125-af4a-d2d2e3cd892a', workspace_id: workspace, parent_run_id: parentId, candidate_hash: String(index).padStart(32, '0'), candidate_index: index,
  child_task_id: 'f3c6b967-4531-4a16-b045-b66a3942bb59', child_run_id: 'fddff562-52a9-41cb-b401-861f55e85198', created_at: timestamp }; }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-automation-test-')); process.env.STUDIO_DATA_DIR = directory;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture-key';
});
afterEach(async () => { globalThis.fetch = fetcher; process.env = { ...environment }; await rm(directory, { recursive: true, force: true }); });

test('discovery automation defaults off, has a bounded cap and cannot recur through content tasks', () => {
  const { discoveryAutomation: _automation, ...legacy } = config();
  assert.deepEqual(taskInputSchema.parse(legacy).discoveryAutomation, { enabled: false, maxDrafts: 1 });
  for (const maxDrafts of [0, 4, 1.5]) assert.throws(() => taskInputSchema.parse({ ...config(), discoveryAutomation: { enabled: true, maxDrafts } }));
  assert.throws(() => taskInputSchema.parse({ ...config(), kind: 'content' }));
});

test('promotion uses deterministic top candidates, shared selection context and disabled once children', async () => {
  const calls: number[] = [];
  globalThis.fetch = async (request, options) => {
    assert.ok(String(request).endsWith('/rpc/studio_promote_discovery_candidate'));
    const body = z.object({ p_workspace: z.uuid(), p_parent_run: z.uuid(), p_candidate_index: z.number(), p_config: taskInputSchema }).parse(JSON.parse(String(options?.body)));
    assert.equal(body.p_workspace, workspace); assert.equal(body.p_parent_run, parentId); calls.push(body.p_candidate_index);
    assert.equal(body.p_config.kind, 'content'); assert.equal(body.p_config.topicOrigin, 'trend');
    assert.deepEqual(body.p_config.discoveryAutomation, { enabled: false, maxDrafts: 1 });
    assert.deepEqual(body.p_config.frequency, { type: 'once', time: '09:00', timezone: 'Asia/Singapore' });
    assert.deepEqual(body.p_config.sources, [source]); assert.deepEqual(body.p_config.knowledgeIds, config().knowledgeIds);
    assert.equal(body.p_config.model, config().model); assert.deepEqual(body.p_config.platforms, ['x']);
    return Response.json(relation(body.p_candidate_index));
  };
  const promotions = await repairDiscoveryPromotions(run(), workspace);
  assert.deepEqual(calls, [0, 1]); assert.deepEqual(promotions.map(item => item.candidateIndex), [0, 1]);
});

test('disabled, unfinished, empty and child runs do not promote', async () => {
  globalThis.fetch = async () => { throw new Error('Disabled automation must not access the database.'); };
  const parent = run();
  for (const candidate of [ { ...parent, status: 'failed' as const }, { ...parent, questions: [] },
    { ...parent, taskSnapshot: { ...parent.taskSnapshot, discoveryAutomation: { enabled: false, maxDrafts: 1 } } },
    { ...parent, taskSnapshot: { ...parent.taskSnapshot, kind: 'content' as const, discoveryAutomation: { enabled: false, maxDrafts: 1 } } } ]) {
    assert.deepEqual(await repairDiscoveryPromotions(candidate, workspace), []);
  }
});

test('a promotion failure propagates for queue repair; a repeat returns the same child identifiers', async () => {
  let fail = true; let calls = 0;
  globalThis.fetch = async (_request, options) => {
    calls++; const body = z.object({ p_candidate_index: z.number() }).parse(JSON.parse(String(options?.body)));
    return fail ? new Response(null, { status: 503 }) : Response.json(relation(body.p_candidate_index));
  };
  await assert.rejects(repairDiscoveryPromotions(run(), workspace), /HTTP 503/); assert.equal(calls, 1);
  fail = false; assert.deepEqual(await repairDiscoveryPromotions(run(), workspace), await repairDiscoveryPromotions(run(), workspace));
});

test('promotion readback is workspace scoped and normalizes PostgreSQL timestamps', async () => {
  globalThis.fetch = async request => {
    const url = new URL(String(request)); assert.equal(url.pathname, '/rest/v1/studio_discovery_promotions');
    assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`); assert.equal(url.searchParams.get('parent_run_id'), `eq.${parentId}`);
    return Response.json([{ ...relation(0), created_at: '2026-10-14T08:00:00+08:00' }]);
  };
  const result = await listDiscoveryPromotions(workspace, parentId); assert.equal(result[0]?.createdAt, timestamp); assert.equal(result[0]?.parentRunId, parentId);
});

test('redelivering a completed parent repairs promotion without rerunning discovery or creating a draft', async () => {
  process.env.STUDIO_WORKSPACE_ID = workspace;
  const parent = run(); parent.taskSnapshot.knowledgeIds = []; parent.taskSnapshot.discoveryAutomation.maxDrafts = 1;
  parent.outputPaths = { master: 'master.md', package: 'package.json', platforms: {} };
  const row = { id: parent.id, task_id: parent.taskId, slot: parent.slot, task_snapshot: parent.taskSnapshot,
    status: parent.status, phase: parent.phase, progress: parent.progress, attempt: parent.attempt, error: parent.error,
    sources: parent.sources, questions: parent.questions, warnings: parent.warnings, master: parent.master, variants: parent.variants,
    draft_id: parent.draftId, output_paths: parent.outputPaths, started_at: parent.startedAt, finished_at: parent.finishedAt,
    created_at: parent.createdAt, updated_at: parent.updatedAt };
  let fail = true; let promotions = 0;
  configureTaskRuntime({ research: async () => { throw new Error('Completed discovery must not research again.'); },
    structured: async () => { throw new Error('Completed discovery must not generate again.'); },
    generateMaster: async () => { throw new Error('Parent discovery must not generate a draft.'); } });
  globalThis.fetch = async request => {
    const url = String(request);
    if (url.endsWith('/rpc/studio_claim_task_run')) return Response.json(null);
    if (url.includes('/studio_task_runs?')) return Response.json([row]);
    if (url.endsWith('/rpc/studio_promote_discovery_candidate')) {
      promotions++; return fail ? new Response(null, { status: 503 }) : Response.json(relation(0));
    }
    throw new Error('Unexpected request during discovery repair.');
  };
  const token = '99a885e8-a639-475b-b439-a86f4c732a7a';
  await assert.rejects(processTaskRun(parentId, token, new AbortController().signal), /HTTP 503/);
  fail = false; await processTaskRun(parentId, token, new AbortController().signal);
  assert.equal(promotions, 2); assert.equal(row.status, 'succeeded'); assert.equal(row.draft_id, null);
});
