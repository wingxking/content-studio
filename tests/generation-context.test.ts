import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { draftDirectory, writeDraftArtifacts } from '../src/core/artifacts.ts';
import { describeEditorialAssessment } from '../src/core/generation-engine.ts';
import { createOperation } from '../src/core/editor.ts';
import { draftSchema, emptyState, type StudioState } from '../src/core/model.ts';
import { approveDraft, createDraft, replaceDraft, verifyDraftApproval } from '../src/core/pipeline.ts';
import { readState } from '../src/core/store.ts';

const previousEnv = { ...process.env }; const previousFetch = globalThis.fetch;
const workspace = '2d254dfb-f230-46bd-ae28-9bcb948f7874';
const assetId = '2c3e4aa2-dc4b-4cbe-9aaf-785641732e64';
const instruction = 'Create an English Reddit post for my personal profile only. Use the selected reference image; do not submit to any subreddit.';
const brief = { topic: 'Accessible images', audience: 'Developers', angle: 'Practical sourced explanation', sources: [{ title: 'Evidence', url: 'https://example.com/source', excerpt: 'A supplied practical fact.' }], platforms: ['reddit' as const] };
const generated = { title: 'Accessible images', body: 'Master content.', variants: [{ platform: 'reddit' as const, title: 'Image purpose', text: 'A practical explanation.', tags: [], mediaPaths: [] }] };
let directory = ''; let state: StudioState; let revision = 0; let linkedRuns: unknown[]; let requestedRuns = 0;
const operations = new Map<string, Record<string, unknown>>();
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-generation-context-')); state = emptyState(); revision = 0; linkedRuns = []; requestedRuns = 0; operations.clear();
  process.env.STUDIO_DATA_DIR = directory; process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture-only'; process.env.STUDIO_WORKSPACE_ID = workspace;
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request)); const body = init?.body ? z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body))) : {};
    if (url.pathname.endsWith('/rpc/studio_commit_article')) {
      const draft = draftSchema.parse(body.p_content); const previous = state.drafts.find(item => item.id === draft.id);
      if (previous && body.p_expected_revision === 0) return Response.json(previous);
      assert.equal(previous?.revision ?? 0, body.p_expected_revision);
      state.drafts = [...state.drafts.filter(item => item.id !== draft.id), draft]; revision++;
      return Response.json(draft);
    }
    if (url.pathname.endsWith('/content_studio_workspaces')) {
      if (init?.method === 'PATCH') { state = z.object({ state: z.unknown() }).parse(body).state as StudioState; revision++; }
      return Response.json([{ id: workspace, state, revision }]);
    }
    if (url.pathname.endsWith('/studio_task_runs')) {
      requestedRuns++; assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`); assert.equal(url.searchParams.get('status'), 'eq.succeeded');
      return Response.json(linkedRuns);
    }
    if (url.pathname.endsWith('/rpc/studio_create_operation')) {
      const id = z.uuid().parse(body.p_id); const timestamp = new Date().toISOString();
      operations.set(id, { id, draft_id: body.p_draft, kind: body.p_kind, status: 'queued', phase: 'Queued', input: body.p_input, output: null, error: null, created_at: timestamp, updated_at: timestamp });
      return Response.json(id);
    }
    if (url.pathname.endsWith('/studio_operations')) return Response.json([operations.get(url.searchParams.get('id')?.slice(3) ?? '')]);
    throw new Error('Unexpected request: this fixture never contacts a live service.');
  };
});
afterEach(async () => { globalThis.fetch = previousFetch; process.env = { ...previousEnv }; await rm(directory, { recursive: true, force: true }); });

test('new task draft context survives later revisions and supplies sync/refine without changing approval', async () => {
  const draft = await createDraft(brief, generated, randomUUID(), 'model-test', { instruction, assetIds: [assetId] });
  assert.equal(draft.generationInstruction, instruction); assert.deepEqual(draft.generationAssetIds, [assetId]);
  const approved = await approveDraft(draft.id, draft.revision); await verifyDraftApproval(approved);
  const sync = await createOperation(draft.id, 'sync', { expectedRevision: draft.revision });
  const refine = await createOperation(draft.id, 'refine', { expectedRevision: draft.revision, scope: 'reddit', prompt: 'Change only the title.' });
  for (const operation of [sync, refine]) {
    assert.equal(operation.input.generationInstruction, instruction); assert.deepEqual(operation.input.assetIds, [assetId]); assert.equal(operation.input.model, 'model-test');
  }
  const deselected = await createOperation(draft.id, 'refine', { expectedRevision: draft.revision, scope: 'reddit', prompt: 'Change only the title.', assetIds: [] });
  assert.deepEqual(deselected.input.assetIds, []); assert.equal(deselected.input.generationInstruction, instruction); assert.equal(requestedRuns, 0);
  const after = (await readState()).drafts[0]; assert.equal(after?.approvedHash, approved.approvedHash); assert.equal(after?.revision, 1);
  const updated = await replaceDraft(draft.id, { ...generated, body: 'Updated master.' }, draft.revision);
  assert.equal(updated.generationInstruction, instruction); assert.deepEqual(updated.generationAssetIds, [assetId]);
});

test('legacy exact completed-run context is copied into the operation without rewriting immutable snapshots', async () => {
  const draft = await createDraft(brief, generated, randomUUID(), 'model-test');
  // Seed the independently completed export: database commits no longer perform filesystem work.
  await writeDraftArtifacts(draft);
  const snapshotPath = join(draftDirectory(draft.id), 'revision-1', 'content.json');
  const before = await readFile(snapshotPath);
  linkedRuns = [{ id: draft.id, draft_id: draft.id, task_snapshot: { prompt: instruction, assetIds: [assetId], model: 'model-test' } }];
  const operation = await createOperation(draft.id, 'sync', { expectedRevision: 1 });
  assert.equal(operation.input.generationInstruction, instruction); assert.deepEqual(operation.input.assetIds, [assetId]); assert.equal(operation.input.model, 'model-test');
  assert.deepEqual(await readFile(snapshotPath), before);
  const persisted = (await readState()).drafts[0]; assert.equal(persisted?.revision, 1); assert.equal(persisted?.generationInstruction, undefined); assert.equal(persisted?.generationAssetIds, undefined);
});

test('unrelated completed runs do not supply a destination and conflicting exact contexts fail before enqueue', async () => {
  const draft = await createDraft(brief, generated, randomUUID(), 'model-test');
  linkedRuns = [{ id: randomUUID(), draft_id: randomUUID(), task_snapshot: { prompt: instruction, assetIds: [assetId], model: 'model-test' } }];
  const missing = await createOperation(draft.id, 'refine', { expectedRevision: 1, scope: 'reddit', prompt: 'Change only the title.' });
  assert.equal(missing.input.generationInstruction, ''); assert.deepEqual(missing.input.assetIds, []);
  linkedRuns = [
    { id: draft.id, draft_id: draft.id, task_snapshot: { prompt: instruction, assetIds: [assetId], model: 'model-test' } },
    { id: randomUUID(), draft_id: draft.id, task_snapshot: { prompt: 'Different unresolved destination.', assetIds: [], model: 'model-test' } },
  ];
  const before = operations.size;
  await assert.rejects(createOperation(draft.id, 'sync', { expectedRevision: 1 }), /Conflicting completed runs/);
  assert.equal(operations.size, before);
});


test('editorial errors retain actionable bounded assessment reasons without raw control characters', () => {
  const text = describeEditorialAssessment({ status: 'uncertain', reasons: ['The selected destination requires source-backed context.\nNo permission is implied.', ...Array.from({ length: 19 }, () => 'Long assessment reason '.repeat(30))] });
  assert.match(text, /uncertain/); assert.match(text, /selected destination/); assert.match(text, /No permission is implied/);
  assert.ok(text.length < 1600); assert.doesNotMatch(text, /[\r\n\u0000]/u);
  const diagnostic = describeEditorialAssessment({ status: 'uncertain', reasons: ['Context '.repeat(30) + 'Missing destination detail is retained.'] });
  assert.match(diagnostic, /Missing destination detail is retained/);
});
