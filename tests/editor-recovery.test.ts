import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachAssets, mergeAdaptation } from '../src/core/editor.ts';
import { type Variant } from '../src/core/model.ts';
import { approveDraft, createDraft, replaceDraft, verifyDraftApproval } from '../src/core/pipeline.ts';
import { readState } from '../src/core/store.ts';

const legacy: Variant = { platform: 'x', title: 'My title', text: 'My custom explanation', tags: ['original'], mediaPaths: ['/local/image.png'] };

test('successive master syncs keep unknown legacy fields protected', () => {
  const incoming = { ...legacy, title: 'Generated title', text: 'First generated explanation', tags: ['generated'] };
  const first = mergeAdaptation(undefined, legacy, incoming);
  assert.equal(first.baseline, undefined);
  assert.deepEqual(first.variant, legacy);
  const second = mergeAdaptation(first.baseline, first.variant, { ...incoming, text: 'Second generated explanation' });
  assert.deepEqual(second.variant, legacy);
  assert.equal(second.baseline, undefined);
  assert.deepEqual(second.conflicts, ['x.title', 'x.text', 'x.tags']);
});

test('successive syncs update generated fields while keeping a known independent edit', () => {
  const generated = { ...legacy, text: 'Original generated explanation' };
  const first = mergeAdaptation(generated, legacy, { ...generated, title: 'First new title', text: 'First new explanation' });
  assert.ok(first.baseline);
  assert.equal(first.baseline.text, generated.text);
  assert.equal(first.baseline.title, 'First new title');
  const second = mergeAdaptation(first.baseline, first.variant, { ...generated, title: 'Second new title', text: 'Second new explanation' });
  assert.equal(second.variant.title, 'Second new title');
  assert.equal(second.variant.text, legacy.text);
  assert.deepEqual(second.conflicts, ['x.text']);
  assert.deepEqual(second.variant.mediaPaths, legacy.mediaPaths);
});

test('attaching assets to a missing target fails before Storage access or revision changes', async () => {
  const originalEnv = { ...process.env }; const originalFetch = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'content-studio-editor-recovery-'));
  try {
    process.env.STUDIO_DATA_DIR = directory;
    for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; throw new Error('No network is allowed in this test.'); };
    const draft = await createDraft({ topic: 'Useful topic', audience: 'Creators', angle: 'Practical sourced explanation', sources: [{ title: 'Source', url: 'https://example.com/source', excerpt: 'A source fact.' }], platforms: ['x'] }, { title: 'Useful title', body: 'Master content.', variants: [{ ...legacy, mediaPaths: [] }] });
    await assert.rejects(attachAssets(draft.id, 'youtube', ['f3cc53ec-b17e-4374-8a14-6132d8b03ee4'], draft.revision), /no publishing version/i);
    assert.equal(requests, 0);
    const saved = (await readState()).drafts.find(item => item.id === draft.id);
    assert.equal(saved?.revision, draft.revision);
    assert.deepEqual(saved?.variants, draft.variants);
  } finally {
    globalThis.fetch = originalFetch; process.env = { ...originalEnv };
    await rm(directory, { recursive: true, force: true });
  }
});


test('proposal retry keeps one revision and retains pending master adaptation', async () => {
  const originalEnv = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), 'content-studio-proposal-recovery-'));
  try {
    process.env.STUDIO_DATA_DIR = directory;
    for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
    const draft = await createDraft({ topic: 'Useful topic', audience: 'Creators', angle: 'Practical sourced explanation', sources: [{ title: 'Source', url: 'https://example.com/source', excerpt: 'A source fact.' }], platforms: ['x'] }, { title: 'Useful title', body: 'Master content.', variants: [{ ...legacy, mediaPaths: [] }] });
    const proposalId = 'c2389a90-6157-436e-ab26-ebd4333ce4e1';
    const next = { title: draft.title, body: 'A revised master.', variants: draft.variants };
    const applied = await replaceDraft(draft.id, next, draft.revision, undefined, proposalId);
    assert.equal(applied.revision, draft.revision + 1);
    assert.equal(applied.adaptationStatus, 'pending');
    assert.equal(applied.lastAppliedProposalId, proposalId);
    assert.equal(applied.lastOperationId, undefined);
    const retried = await replaceDraft(draft.id, next, draft.revision, undefined, proposalId);
    assert.equal(retried.revision, applied.revision);
    assert.equal(retried.adaptationStatus, 'pending');
  } finally { process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); }
});


test('a draft keeps its chosen generation model without changing content approval', async () => {
  const originalEnv = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), 'content-studio-model-retention-'));
  try {
    process.env.STUDIO_DATA_DIR = directory;
    for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
    const draft = await createDraft({ topic: 'Useful topic', audience: 'Creators', angle: 'Practical sourced explanation', sources: [{ title: 'Source', url: 'https://example.com/source', excerpt: 'A source fact.' }], platforms: ['x'] }, { title: 'Useful title', body: 'Master content.', variants: [{ ...legacy, mediaPaths: [] }] }, undefined, 'chosen-codex-model');
    assert.equal(draft.generationModel, 'chosen-codex-model');
    const retry = await createDraft(draft.brief, draft, draft.id, 'different-retry-model');
    assert.equal(retry.generationModel, 'chosen-codex-model');
    const approved = await approveDraft(draft.id, draft.revision);
    await assert.doesNotReject(verifyDraftApproval({ ...approved, generationModel: 'other-model-metadata' }));
  } finally { process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); }
});
