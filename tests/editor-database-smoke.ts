// Explicit acceptance against local Supabase only. Uses an isolated workspace and no model or publisher.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { dbRequest, dbRpc } from '../src/core/database.ts';
import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';
import { applyOperation, cancelOperation, getOperation, handleStudioOperation, listOperations, saveEditedDraft } from '../src/core/editor.ts';
import { createDraft } from '../src/core/pipeline.ts';
import { readState } from '../src/core/store.ts';
import { readDraftRevision } from '../src/core/artifacts.ts';
import { type Draft, type Generated } from '../src/core/model.ts';

await loadRuntimeEnvironment();
const base = new URL(process.env.SUPABASE_URL ?? '');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Editor acceptance requires local Supabase.');
const originalEnvironment = { ...process.env }; const originalFetch = globalThis.fetch;
const workspace = randomUUID(); const directory = await mkdtemp(join(tmpdir(), 'studio-editor-db-smoke-'));
process.env.STUDIO_WORKSPACE_ID = workspace; process.env.STUDIO_DATA_DIR = directory;
const source = { title: 'Acceptance fixture', url: 'https://example.org/fixture', excerpt: 'Deterministic fixture only; no researched or publishable claim.' };
const content: Generated = { title: 'Fixture master', body: 'Fixture master explanation.', variants: [{ platform: 'x', title: 'Fixture X', text: 'Original fixture platform text.', tags: [], mediaPaths: [] }] };
async function currentDraft(id: string): Promise<Draft> {
  const draft = (await readState()).drafts.find(item => item.id === id); assert.ok(draft); return draft;
}
async function proposal(draft: Draft, next: Generated): Promise<string> {
  const id = randomUUID();
  await dbRequest('studio_operations', { method: 'POST', body: { id, workspace_id: workspace, draft_id: draft.id, kind: 'refine', status: 'succeeded', phase: 'Proposal ready', input: { expectedRevision: draft.revision, scope: next.body === draft.body ? 'x' : 'master' }, output: { proposal: next, applied: false } } });
  return id;
}
const changedPlatform = (draft: Draft, text: string): Generated => ({ title: draft.title, body: draft.body, variants: draft.variants.map(item => ({ ...item, text })) });
const queueClaimSchema = z.object({ msgId: z.number(), token: z.uuid() });
try {
  const draft = await createDraft({ topic: 'Fixture topic', audience: 'Fixture creators', angle: 'Verify local transactions', sources: [source], platforms: ['x'] }, content, undefined, 'fixture-codex-model');
  const firstId = await proposal(draft, changedPlatform(draft, 'Reviewed platform change.'));
  const applied = await applyOperation(firstId, draft.revision);
  assert.equal(applied.revision, draft.revision + 1); assert.equal(applied.lastAppliedProposalId, firstId);
  assert.equal(z.object({ applied: z.boolean() }).parse((await getOperation(firstId)).output).applied, true);
  const duplicate = await applyOperation(firstId, draft.revision); assert.equal(duplicate.revision, applied.revision);
  await assert.rejects(cancelOperation(firstId));
  assert.equal((await getOperation(firstId)).status, 'succeeded');
  assert.equal((await readDraftRevision(draft.id, applied.revision)).variants[0]?.text, 'Reviewed platform change.');
  console.log('PASS atomic proposal application, duplicate acceptance, immutable revision and applied-cancellation guard');

  const cancelId = await proposal(applied, changedPlatform(applied, 'This cancelled text must never be applied.'));
  let cancelledDuringApply = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/rpc/studio_apply_proposal') && !cancelledDuringApply) { cancelledDuringApply = true; await cancelOperation(cancelId); }
    return originalFetch(input, init);
  };
  await assert.rejects(applyOperation(cancelId, applied.revision)); globalThis.fetch = originalFetch;
  assert.equal(cancelledDuringApply, true); assert.equal((await getOperation(cancelId)).status, 'cancelled');
  assert.equal((await currentDraft(draft.id)).revision, applied.revision);
  assert.equal((await currentDraft(draft.id)).variants[0]?.text, 'Reviewed platform change.');
  console.log('PASS cancellation after proposal read but before commit prevents draft mutation');

  const retryId = await proposal(applied, changedPlatform(applied, 'Committed despite lost response.'));
  let responseLost = false;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).includes('/rpc/studio_apply_proposal') && response.ok && !responseLost) { responseLost = true; throw new Error('Intentional loss after the committed database response.'); }
    return response;
  };
  await assert.rejects(applyOperation(retryId, applied.revision)); globalThis.fetch = originalFetch;
  assert.equal(responseLost, true);
  const committed = await currentDraft(draft.id); assert.equal(committed.revision, applied.revision + 1);
  assert.equal(committed.lastAppliedProposalId, retryId);
  assert.equal(z.object({ applied: z.boolean() }).parse((await getOperation(retryId)).output).applied, true);
  const recovered = await applyOperation(retryId, applied.revision);
  assert.equal(recovered.revision, committed.revision); assert.equal(recovered.variants[0]?.text, 'Committed despite lost response.');
  assert.equal((await readDraftRevision(draft.id, committed.revision)).lastAppliedProposalId, retryId);
  console.log('PASS lost-response recovery repairs files without a duplicate revision or lost applied receipt');

  const masterId = await proposal(recovered, { title: recovered.title, body: 'A revised master must still synchronize its platforms.', variants: recovered.variants });
  const masterApplied = await applyOperation(masterId, recovered.revision);
  assert.equal(masterApplied.adaptationStatus, 'pending'); assert.equal(masterApplied.lastOperationId, undefined);
  assert.equal(masterApplied.lastAppliedProposalId, masterId);
  assert.equal((await listOperations(draft.id)).filter(item => item.kind === 'sync' && item.input.expectedRevision === masterApplied.revision).length, 1);
  await applyOperation(masterId, recovered.revision);
  assert.equal((await listOperations(draft.id)).filter(item => item.kind === 'sync' && item.input.expectedRevision === masterApplied.revision).length, 1);
  console.log('PASS accepted master changes retain pending adaptation and enqueue exactly one sync');
  const sync = (await listOperations(draft.id)).find(item => item.kind === 'sync' && item.input.expectedRevision === masterApplied.revision); assert.ok(sync);
  assert.equal(sync.input.model, 'fixture-codex-model');
  const syncProposal: Generated = { title: masterApplied.title, body: masterApplied.body, variants: masterApplied.variants.map(item => ({ ...item, text: 'New adaptation generated before the interruption.' })) };
  await dbRequest(`studio_operations?id=eq.${sync.id}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { status: 'running', phase: 'Applying adapted content', output: { proposal: syncProposal, baselines: syncProposal.variants, conflicts: [], applying: true }, lease_until: '2020-01-01T00:00:00Z' } });
  let historyFailure = false;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/studio_revisions') && init?.method === 'POST' && !historyFailure) { historyFailure = true; return new Response('Intentional temporary history write failure', { status: 503 }); }
    return originalFetch(input, init);
  };
  await assert.rejects(handleStudioOperation(sync.id, new AbortController().signal)); globalThis.fetch = originalFetch;
  assert.equal(historyFailure, true);
  const committedSync = await currentDraft(draft.id); assert.equal(committedSync.lastOperationId, sync.id);
  assert.equal((await getOperation(sync.id)).status, 'running');
  await assert.rejects(cancelOperation(sync.id));
  const laterEdit = await saveEditedDraft(draft.id, changedPlatform(committedSync, 'Independent edit after the committed sync.'), committedSync.revision);
  await dbRequest(`studio_operations?id=eq.${sync.id}&workspace_id=eq.${workspace}`, { method: 'PATCH', body: { lease_until: '2020-01-01T00:00:00Z' } });
  await handleStudioOperation(sync.id, new AbortController().signal);
  assert.equal((await getOperation(sync.id)).status, 'succeeded');
  assert.equal((await currentDraft(draft.id)).revision, laterEdit.revision);
  assert.equal((await currentDraft(draft.id)).variants[0]?.text, 'Independent edit after the committed sync.');
  const meta = z.array(z.object({ state: z.object({ baselines: z.array(z.object({ text: z.string() })) }) })).parse(await dbRequest(`studio_editor_state?draft_id=eq.${draft.id}&workspace_id=eq.${workspace}`));
  assert.equal(meta[0]?.state.baselines[0]?.text, 'New adaptation generated before the interruption.');
  console.log('PASS committed sync recovery repairs baseline and receipt without rerunning generation or overwriting a later independent edit');
  console.log('Local Supabase editor acceptance passed. No model generation or external publishing occurred.');
} finally {
  globalThis.fetch = originalFetch;
  const cleanupErrors: string[] = [];
  try {
    for (let index = 0; index < 100; index++) {
      const value = await dbRpc('studio_claim_work', { p_workspace: workspace }); if (!value) break;
      const claim = queueClaimSchema.parse(value);
      await dbRpc('studio_ack_work', { p_workspace: workspace, p_msg: claim.msgId, p_token: claim.token });
    }
  } catch { cleanupErrors.push('fixture queue'); }
  for (const table of ['studio_operations', 'studio_editor_state', 'studio_revisions', 'studio_videos', 'studio_queue_leases', 'content_studio_workspaces']) {
    try { await dbRequest(`${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspace}`, { method: 'DELETE' }); }
    catch { cleanupErrors.push(table); }
  }
  process.env = originalEnvironment; await rm(directory, { recursive: true, force: true });
  if (cleanupErrors.length) throw new Error(`Isolated editor fixture cleanup needs attention (${workspace}): ${cleanupErrors.join(', ')}.`);
}
