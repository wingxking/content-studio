import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { committedArticle, commitArticle } from '../src/core/article-repository.ts';
import { publicArticle, publicArticleJob, restoreArticleMedia } from '../src/core/article-media.ts';
import { draftDirectory, writeDraftArtifacts } from '../src/core/artifacts.ts';
import { articleText, documentFromText } from '../src/core/article-document.ts';
import { draftSchema, generatedSchema, jobSchema, type Draft } from '../src/core/model.ts';
import { applyOperation, saveEditedDraft } from '../src/core/editor.ts';
import { addAccount, approveDraft, createDraft, preparePublication, replaceDraft } from '../src/core/pipeline.ts';
import { readState } from '../src/core/store.ts';
import { publicationHandoff } from '../src/core/delivery.ts';

const environment = { ...process.env }; const fetcher = globalThis.fetch; let root = '';

test('video history keeps frozen platform metadata while hiding execution files', () => {
  const id = randomUUID(); const accountId = randomUUID(); const at = new Date().toISOString(); const hash = 'a'.repeat(64);
  const job = jobSchema.parse({ id: randomUUID(), draftId: null, subject: { kind: 'video', id, revision: 1 }, accountId, platform: 'bilibili', provider: 'native', approvedHash: hash, status: 'awaiting_operator', scheduledAt: at, createdAt: at, remoteId: null, remoteUrl: null, attempts: 0, error: '/private/worker/output.mp4 failed', history: [], snapshot: {
    account: { id: accountId, platform: 'bilibili', label: 'Fixture', provider: 'native', integrationId: '', status: 'needs_login', note: '', verifiedAt: null },
    video: { projectId: id, revision: 1, renderId: randomUUID(), renderHash: hash, approvalHash: hash, sources: [] },
    variant: { platform: 'bilibili', title: 'Bilibili version', text: 'Frozen platform description', tags: ['fixture'], mediaPaths: ['/private/worker/output.mp4'], format: 'video' },
  } });
  const view = publicArticleJob(job);
  assert.equal(view.snapshot?.variant.text, 'Frozen platform description'); assert.equal(view.snapshot?.video?.renderId, job.snapshot?.video?.renderId);
  assert.deepEqual(view.snapshot?.variant.mediaPaths, []); assert.doesNotMatch(JSON.stringify(view), /\/private/u);
  assert.equal(job.snapshot?.variant.mediaPaths[0], '/private/worker/output.mp4');
});
const brief = { topic: 'Save work', audience: 'New users', angle: 'Practical explanation', sources: [{ title: 'Manual', url: 'https://example.com/manual', excerpt: 'Save before closing.' }], platforms: ['reddit' as const] };
const generated = { title: 'Save work', body: 'Save before closing the editor.', variants: [{ platform: 'reddit' as const, title: 'Save work', text: 'Use Save before closing.', tags: [], mediaPaths: [] as string[] }] };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'studio-article-commits-')); process.env.STUDIO_DATA_DIR = root; for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'STUDIO_CONTAINER']) delete process.env[key]; });
afterEach(async () => { globalThis.fetch = fetcher; process.env = { ...environment }; await rm(root, { recursive: true, force: true }); });
function database() { const workspace = randomUUID(); process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'isolated-fixture-key'; process.env.STUDIO_WORKSPACE_ID = workspace; return workspace; }

test('committed content and original media survive a filesystem export failure and explicit repair', async () => {
  const original = join(root, 'original.png'); await writeFile(original, 'immutable original media');
  // A regular file where the export directory belongs causes a deterministic ENOTDIR, even as root.
  await writeFile(join(root, 'content'), 'projection unavailable');
  const draft = await createDraft(brief, { ...generated, variants: [{ ...generated.variants[0]!, mediaPaths: [original] }] });
  assert.equal((await readState()).drafts[0]?.id, draft.id); assert.equal(await readFile(original, 'utf8'), 'immutable original media');
  const edited = await replaceDraft(draft.id, { ...draft, title: 'Save your editor work' }, 1);
  assert.equal(edited.revision, 2); assert.equal((await readState()).drafts[0]?.title, edited.title);
  assert.equal(await readFile(original, 'utf8'), 'immutable original media');
  await rm(join(root, 'content')); await writeDraftArtifacts(edited);
  const repaired = draftSchema.parse(JSON.parse(await readFile(join(draftDirectory(draft.id), 'revision-2', 'content.json'), 'utf8')));
  assert.equal(repaired.revision, 2); assert.equal((await readState()).drafts[0]?.revision, 2);
});

test('a Supabase save delegates its commit once and never attempts an inline export', async () => {
  const workspace = database(); const id = randomUUID(); const command = randomUUID(); const calls: string[] = [];
  const draft = draftSchema.parse({ ...generated, brief, id, createdAt: new Date().toISOString(), revision: 1, approvedHash: null });
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request)); calls.push(url.pathname); assert.equal(init?.method, 'POST');
    assert(url.pathname.endsWith('/rpc/studio_commit_article'));
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body)));
    assert.equal(body.p_workspace, workspace); assert.equal(body.p_command, command); assert.equal(body.p_expected_revision, 0); assert.deepEqual(body.p_content, draft);
    return Response.json(draft);
  };
  const saved = await commitArticle(draft, { expectedRevision: 0, commandId: command }); assert.deepEqual(saved, draft);
  assert.equal(calls.length, 1); await assert.rejects(access(join(root, 'content')));
});

test('command receipts replay the exact committed revision without another save or current-state read', async () => {
  const workspace = database(); const id = randomUUID(); const command = randomUUID();
  const saved = draftSchema.parse({ ...generated, brief, id, createdAt: new Date().toISOString(), revision: 2, approvedHash: null });
  let writes = 0; let gets = 0; let committed: Draft | null = null;
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith('/rpc/studio_commit_article')) { writes++; committed = draftSchema.parse(JSON.parse(String(init?.body)).p_content); return Response.json(committed); }
    assert(!init?.method || init.method === 'GET'); gets++;
    assert.equal(url.searchParams.get('workspace_id'), `eq.${workspace}`);
    if (url.pathname.endsWith('/studio_article_commands')) return Response.json(committed ? [{ draft_id: id, revision: 2 }] : []);
    if (url.pathname.endsWith('/studio_revisions')) { assert.equal(url.searchParams.get('revision'), 'eq.2'); return Response.json([{ content: saved }]); }
    throw new Error('A command replay must not read current workspace state or create operations.');
  };
  assert.equal(await committedArticle(command, id, 1, generated), null);
  await commitArticle(saved, { expectedRevision: 1, commandId: command });
  assert.deepEqual(await committedArticle(command, id, 1, generated), saved);
  assert.deepEqual(await saveEditedDraft(id, generated, 1, undefined, undefined, command), saved);
  assert.equal(writes, 1); assert.equal(gets, 5);
  await assert.rejects(committedArticle(command, id, 1, { ...generated, title: 'Different content' }), /different article content/);
  await assert.rejects(committedArticle(command, randomUUID(), 1, generated), /different article save/);
  await assert.rejects(committedArticle(command, id, 2, generated), /different article save/);
  assert.equal(writes, 1);
});

for (const format of ['legacy-text', 'document', 'older-document-checkpoint'] as const) test(`Supabase proposal apply preserves the exact frozen ${format} payload`, async () => {
  const workspace = database(); const id = randomUUID(); const operationId = randomUUID(); const at = new Date().toISOString();
  const body = format === 'older-document-checkpoint' ? '  Revised master with legacy whitespace.  ' : 'Revised master.\n\nReview its practical steps.';
  const document = format === 'legacy-text' ? undefined : documentFromText(body);
  const proposal = generatedSchema.parse({ ...generated, body: format === 'document' && document ? articleText(document) : body, ...(document ? { document } : {}) });
  const frozen = JSON.stringify(proposal); const selectedModel = 'selected-refinement-model';
  let draft = draftSchema.parse({ ...generated, ...(document ? { document: documentFromText(generated.body) } : {}), brief, id, createdAt: at, revision: 1, approvedHash: null, generationModel: 'original-model', generationInstruction: 'Keep the supplied evidence.', generationAssetIds: [] });
  const operation = { id: operationId, draft_id: id, kind: 'refine', status: 'succeeded', phase: 'Completed', input: { expectedRevision: 1, model: selectedModel }, output: { proposal, applied: false }, error: null, created_at: at, updated_at: at };
  let applied = 0; let revisionsRecorded = 0;
  globalThis.fetch = async (request, init) => {
    const url = new URL(String(request)); const requestBody = init?.body ? z.record(z.string(), z.unknown()).parse(JSON.parse(String(init.body))) : {};
    if (url.pathname.endsWith('/studio_operations')) return Response.json([operation]);
    if (url.pathname.endsWith('/content_studio_workspaces')) return Response.json([{ id: workspace, revision: 1, state: { version: 1, paused: true, drafts: [draft], accounts: [], jobs: [] } }]);
    if (url.pathname.endsWith('/studio_revisions') && init?.method === 'POST') { revisionsRecorded++; return Response.json(null); }
    if (url.pathname.endsWith('/studio_editor_state')) return Response.json(init?.method === 'POST' ? null : []);
    if (url.pathname.endsWith('/rpc/studio_apply_proposal')) {
      applied++; assert.equal(requestBody.p_workspace, workspace); assert.equal(requestBody.p_operation, operationId); assert.equal(requestBody.p_expected_revision, 1);
      // This is the database's frozen-proposal equality boundary, not a permissive save mock.
      assert.deepEqual(requestBody.p_content, operation.output.proposal);
      draft = draftSchema.parse({ ...draft, ...proposal, revision: 2, approvedHash: null, lastAppliedProposalId: operationId, adaptationStatus: 'pending', generationModel: operation.input.model });
      return Response.json(draft);
    }
    throw new Error('Proposal application must use its atomic RPC without separate follow-up writes.');
  };
  const saved = await applyOperation(operationId, 1);
  assert.equal(applied, 1); assert.equal(revisionsRecorded, 1); assert.equal(saved.revision, 2); assert.equal(saved.adaptationStatus, 'pending'); assert.equal(saved.generationModel, selectedModel);
  assert.equal(saved.body, proposal.body); assert.deepEqual(saved.document, proposal.document); assert.equal(JSON.stringify(operation.output.proposal), frozen);
  await assert.rejects(access(join(root, 'content')));
});

test('public article media references recover the frozen physical reference without rewriting files', async () => {
  const original = join(root, 'original.png'); await writeFile(original, 'original bytes'); const asset = `studio-asset:${randomUUID()}`;
  const draft = await createDraft(brief, { ...generated, variants: [{ ...generated.variants[0]!, mediaPaths: [original, asset] }] });
  const safe = publicArticle(draft); assert(!JSON.stringify(safe).includes(root)); assert.equal(safe.variants[0]?.mediaPaths[1], asset);
  assert.equal(safe.variants[0]?.mediaPaths[0], `studio-article-media:${draft.id}:1:reddit:0`);
  const restored = await restoreArticleMedia(generatedSchema.parse(safe)); assert.deepEqual(restored.variants[0]?.mediaPaths, [original, asset]);
  const snapshot = await readFile(join(draftDirectory(draft.id), 'revision-1', 'content.json'));
  await restoreArticleMedia(generatedSchema.parse(safe)); assert.deepEqual(await readFile(join(draftDirectory(draft.id), 'revision-1', 'content.json')), snapshot);
  await assert.rejects(restoreArticleMedia({ ...generated, variants: [{ ...generated.variants[0]!, mediaPaths: [`studio-article-media:${draft.id}:1:reddit:20`] }] }));
  assert.equal(await readFile(original, 'utf8'), 'original bytes');
});

test('manual article handoff downloads use frozen media references and preserve internal snapshots', async () => {
  const original = join(root, 'original.png'); await writeFile(original, 'original media bytes');
  const draft = await createDraft(brief, { ...generated, variants: [{ ...generated.variants[0]!, mediaPaths: [original] }] });
  const selected = await addAccount({ platform: 'reddit', label: 'Manual fixture', provider: 'native', integrationId: 'fixture-account', status: 'blocked', note: 'Manual handoff fixture', verifiedAt: null });
  await approveDraft(draft.id, 1); const job = await preparePublication({ draftId: draft.id, accountId: selected.id, expectedRevision: 1, automatic: false });
  const before = await readState(); const handoff = await publicationHandoff(job.id);
  assert.equal(handoff.requiresReconciliation, false); assert.equal(handoff.files.length, 1);
  assert.equal(new URL(handoff.files[0]!.url, 'http://localhost').searchParams.get('path'), `studio-article-media:${draft.id}:1:reddit:0`);
  assert(!JSON.stringify(handoff).includes(root)); assert.deepEqual(await readState(), before);
  assert.equal(before.jobs[0]?.snapshot?.variant.mediaPaths[0], original);
});

test('a newer exporter writes a separate version and retains every legacy revision byte', async () => {
  const draft = await createDraft(brief, generated); const legacy = join(draftDirectory(draft.id), 'revision-1');
  const names = ['content.json', 'master.md', 'sources.md', 'reddit.md'];
  const before = await Promise.all(names.map(name => readFile(join(legacy, name))));
  await writeDraftArtifacts(draft, 2);
  for (const [index, name] of names.entries()) {
    assert.deepEqual(await readFile(join(legacy, name)), before[index]);
    assert.deepEqual(await readFile(join(legacy, 'exports', 'v2', name)), before[index]);
  }
  const current = await readFile(join(draftDirectory(draft.id), 'content.json')); assert.deepEqual(current, before[0]);
  await writeDraftArtifacts(draft, 2); assert.deepEqual(await readFile(join(legacy, 'master.md')), before[1]);
  assert.equal((await readState()).drafts[0]?.revision, 1);
});
