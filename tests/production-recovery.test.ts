import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { produceEvidenceArticle, type ProductionRuntime } from '../src/core/production.ts';
import { EvidenceFiles, evidenceHash, documentChunks } from '../src/core/evidence.ts';
import { evidenceDocumentSchema, claimSchema } from '../src/contracts/research.ts';
import { taskSchema, taskRunSchema } from '../src/core/task-model.ts';
import { draftSchema, emptyState } from '../src/core/model.ts';
import { configureTaskRuntime, processTaskRun } from '../src/core/tasks.ts';

test('production recovers the same evidence and completed model stages after interruption, then replays without another model call', async () => {
  const environment = { ...process.env }; const fetcher = globalThis.fetch; const directory = await mkdtemp(join(tmpdir(), 'studio-production-'));
  process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_LOCALFS_DIR = directory;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture-not-a-secret';
  const workspace = randomUUID(); const runId = randomUUID(); const timestamp = new Date().toISOString();
  const task = taskSchema.parse({ id: randomUUID(), createdAt: timestamp, updatedAt: timestamp, nextRunAt: null, title: 'Software revisions', prompt: 'Explain immutable software revisions with a useful decision checklist.', kind: 'content', enabled: true, pipelineVersion: 2, model: 'fixture', platforms: ['zhihu'], frequency: { type: 'once', time: '09:00', timezone: 'UTC' } });
  const run = taskRunSchema.parse({ id: runId, taskId: task.id, slot: 'manual:fixture', taskSnapshot: task, status: 'researching', phase: 'researching', progress: 5, attempt: 1, error: null, warnings: [], questions: [], sources: [], master: null, variants: [], draftId: null, outputPaths: null, startedAt: timestamp, finishedAt: null, createdAt: timestamp, updatedAt: timestamp });
  const text = 'Software revisions preserve prior bytes. A new edit creates a distinct immutable version. This permits restoration to the previous version.';
  const questions = ['How do immutable revisions support software recovery?'];
  const files = new EvidenceFiles(); const textRef = await files.put({ text }); const docId = evidenceHash('recovery-doc');
  const document = evidenceDocumentSchema.parse({ id: docId, sourceId: 'primary', url: 'https://example.org/revisions', title: 'Revision documentation', publisher: 'Example', publishedAt: timestamp, fetchedAt: timestamp, sha256: textRef, parserVersion: 'fixture', access: 'full', category: 'primary', chunks: documentChunks(docId, text) });
  const claim = claimSchema.parse({ id: 'c1', text: 'Software revisions preserve prior bytes.', critical: true, kind: 'fact', status: 'supported', evidence: [{ documentId: docId, chunkId: document.chunks[0]!.id, quote: 'Software revisions preserve prior bytes.' }], caveat: '' });
  const bundle = { documents: [document], warnings: [], queries: questions }; const bundleRef = await files.put(bundle);
  type Row = { status: string; input_hash: string; artifact_ref: string | null; attempts: number };
  const steps = new Map<string, Row>([['evidence_bundle', { status: 'completed', input_hash: evidenceHash({ task, questions }), artifact_ref: bundleRef, attempts: 1 }]]);
  let modelCalls = 0; let masterAttempts = 0; let interrupt = true;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/studio_research_steps')) return Response.json(steps.has(url.searchParams.get('stage')!.slice(3)) ? [steps.get(url.searchParams.get('stage')!.slice(3))] : []);
    if (url.pathname.endsWith('/rpc/studio_research_step')) {
      const request = z.object({ p_stage: z.string(), p_input_hash: z.string(), p_artifact: z.string().optional(), p_usage: z.unknown().optional() }).parse(JSON.parse(String(init?.body)));
      const previous = steps.get(request.p_stage);
      if (previous) assert.equal(previous.input_hash, request.p_input_hash);
      if (request.p_usage && !request.p_artifact) return Response.json(previous);
      const row = { status: request.p_artifact ? 'completed' : 'running', input_hash: request.p_input_hash, artifact_ref: request.p_artifact ?? null, attempts: (previous?.attempts ?? 0) + (request.p_artifact ? 0 : 1) };
      steps.set(request.p_stage, row); return Response.json(row);
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`);
  };
  const check = { assessment: { status: 'allowed', reasons: ['The fixed source supports the article.'] }, claims: [claim], issues: [], contribution: true, titleFulfilled: true, originality: true };
  const runtime: ProductionRuntime = {
    structured: async (schema, prompt) => {
      modelCalls++;
      if (prompt.startsWith('Plan a useful')) return schema.parse({ assessment: check.assessment, questions, contribution: 'A recovery checklist.', kind: 'explanation' });
      if (prompt.startsWith('Build atomic')) return schema.parse({ claims: [claim], gaps: [] });
      if (prompt.startsWith('Independently extract') || prompt.startsWith('Check this platform')) return schema.parse(check);
      throw new Error('Unexpected model phase.');
    },
    generateMaster: async () => { modelCalls++; masterAttempts++; if (interrupt) { interrupt = false; throw new Error('Fixture process interruption'); } return { title: 'Software revision checklist', body: `${text}\n\nChoose a new immutable revision before changing a restore target.\nhttps://example.org/revisions` }; },
    adaptMaster: async () => { modelCalls++; return { platform: 'zhihu', title: 'Software revisions', text: `${text}\nhttps://example.org/revisions`, tags: [], mediaPaths: [], format: 'article' }; },
  };
  try {
    const options = { model: 'fixture', signal: new AbortController().signal };
    await assert.rejects(produceEvidenceArticle(run, workspace, randomUUID(), runtime, options, async () => undefined), /interruption/);
    assert.equal(steps.get('research_plan')?.status, 'completed'); assert.equal(steps.get('evidence_ledger')?.status, 'completed');
    const result = await produceEvidenceArticle(run, workspace, randomUUID(), runtime, options, async () => undefined);
    assert.equal(result.report.status, 'passed'); assert.equal(masterAttempts, 2); assert.equal(result.documentIds[0], docId);
    const calls = modelCalls;
    const replay = await produceEvidenceArticle(run, workspace, randomUUID(), runtime, options, async () => undefined);
    assert.equal(modelCalls, calls); assert.deepEqual(replay.master, result.master); assert.deepEqual(replay.variants, result.variants);
    assert.equal(steps.get('write_master')?.attempts, 2); assert.equal(steps.get('quality_final')?.status, 'completed');
    steps.clear(); steps.set('evidence_bundle', { status: 'completed', input_hash: evidenceHash({ task, questions }), artifact_ref: bundleRef, attempts: 1 });
    const refreshed = await produceEvidenceArticle({ ...run, id: randomUUID(), refreshTarget: { draftId: run.id, expectedRevision: 2, reason: 'source_changed' } }, workspace, randomUUID(), runtime, options, async () => undefined);
    assert.equal(refreshed.report.draftRevision, 3);
  } finally { globalThis.fetch = fetcher; process.env = environment; await rm(directory, { recursive: true, force: true }); }
});

test('a stale queued research target stops before resolving assets or spending model budget', async () => {
  const environment = { ...process.env }; const fetcher = globalThis.fetch; const directory = await mkdtemp(join(tmpdir(), 'studio-stale-research-'));
  const workspace = randomUUID(); const runId = randomUUID(); const draftId = randomUUID(); const token = randomUUID(); const at = new Date().toISOString();
  process.env.STUDIO_DATA_DIR = directory; process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture-only'; process.env.STUDIO_WORKSPACE_ID = workspace;
  const task = taskSchema.parse({ id: randomUUID(), title: 'Fixture research', prompt: 'Explain immutable source revisions.', pipelineVersion: 2, enabled: false, model: 'fixture', kind: 'content', platforms: ['zhihu'], frequency: { type: 'once', time: '09:00', timezone: 'UTC' }, createdAt: at, updatedAt: at, nextRunAt: null });
  const draft = draftSchema.parse({ id: draftId, revision: 3, title: 'Preserved operator edit', body: 'An operator revision.', createdAt: at, approvedHash: null, generationEvidenceRunId: randomUUID(), brief: { topic: 'Revisions', audience: 'Developers', angle: 'Explain recovery', sources: [{ title: 'Fixture', url: 'https://example.org/revisions', excerpt: 'An immutable reference.' }], platforms: ['zhihu'] }, variants: [{ platform: 'zhihu', title: 'Preserved operator edit', text: 'An operator revision.', tags: [], mediaPaths: [] }] });
  let row: Record<string, unknown> = { id: runId, task_id: task.id, slot: 'fixture-refresh', task_snapshot: task, status: 'researching', phase: 'researching', progress: 0, attempt: 1, error: null, warnings: [], sources: [], questions: [], master: null, variants: [], draft_id: null, output_paths: null, started_at: at, finished_at: null, created_at: at, updated_at: at, refresh_draft_id: draftId, refresh_revision: 2, refresh_reason: 'review_requested' };
  let assetCalls = 0; configureTaskRuntime({ resolveImagePaths: async () => { assetCalls++; return []; } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rpc/studio_claim_task_run')) return Response.json(row);
    if (url.pathname.endsWith('/content_studio_workspaces')) return Response.json([{ id: workspace, state: { ...emptyState(), drafts: [draft] }, revision: 0 }]);
    if (url.pathname.endsWith('/studio_task_runs')) return Response.json([row]);
    if (url.pathname.endsWith('/rpc/studio_patch_task_run')) { const body = z.object({ p_token: z.literal(token), p_patch: z.record(z.string(), z.unknown()) }).parse(JSON.parse(String(init?.body))); assert.equal(body.p_patch.status, 'failed'); row = { ...row, ...body.p_patch }; return Response.json(row); }
    throw new Error('Unexpected work after a stale research target was detected.');
  };
  try {
    await processTaskRun(runId, token, new AbortController().signal);
    assert.equal(assetCalls, 0); assert.equal(row.status, 'failed'); assert.match(String(row.error), /current revision.*saved edit is preserved/u);
  } finally { globalThis.fetch = fetcher; process.env = environment; await rm(directory, { recursive: true, force: true }); }
});
