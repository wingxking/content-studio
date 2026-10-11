import { addAccount, createDraft, exportJob, replaceDraft, retryFailedPublication } from '../src/core/pipeline.ts';
import { prepareVideoPublication, verifyVideoDeliveryApproval } from '../src/core/video-delivery.ts';
import { markYouTubeJournalPresence } from '../src/core/publication-journal.ts';
import { mutateState } from '../src/core/store.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { approveVideoDelivery, approveVideoRevision, applyVideoRefinement, cancelVideoRender, createVideoProject, createVideoRefinement, currentVideoRevision, generateVideoScript, getIndependentVideoProject, renderVideoProject, updateVideoProject, videoRevisionHash, supabaseVideoRepository, type VideoDependencies, type VideoRepository } from '../src/core/video.ts';
import { videoContentSchema, videoProjectSchema, type VideoContent, type VideoOutput, type VideoProject } from '../src/core/video-model.ts';
import { cacheVideoStage, splitVideoSentences, videoFileHash, videoFingerprint, videoSrt } from '../src/core/video-tools.ts';

const assetId = randomUUID();
const source = { title: 'Software documentation', url: 'https://example.com/documentation', excerpt: 'Save work before closing the editor.' };
const content: VideoContent = { title: 'Save your work', script: 'Save your work before closing the editor.', scenes: [{ id: 'opening', narration: 'Save your work before closing the editor.', visualDescription: 'Show the editor save action.', assetId, caption: null, sourceUrls: [source.url] }], disclosureReview: 'Review supplied visuals and synthetic voice labeling.' };
function memoryRepository(): VideoRepository {
  const rows = new Map<string, VideoProject>();
  return {
    async get(id) { const row = rows.get(id); if (!row) throw new Error('Not found'); return structuredClone(row); },
    async list() { return [...rows.values()].map(row => structuredClone(row)); },
    async save(project, expectedVersion) {
      const previous = rows.get(project.id); if ((previous?.version ?? 0) !== expectedVersion) throw new Error('CAS conflict');
      const next = videoProjectSchema.parse({ ...project, version: expectedVersion + 1, updatedAt: new Date().toISOString() }); rows.set(project.id, structuredClone(next)); return next;
    },
  };
}
async function fixture(overrides: VideoDependencies = {}) {
  const dependencies: VideoDependencies = { repository: memoryRepository(), ...overrides };
  const project = await createVideoProject({ explicitlyRequested: true, brief: { topic: 'Save editor work', audience: 'New users', instruction: 'Show a clear practical step.', sources: [source], platform: 'youtube' }, content }, dependencies);
  return { project, dependencies };
}
async function output(path: string): Promise<VideoOutput> { return { rawPath: path, videoPath: path, captionsPath: null, manifestPath: path, hash: await videoFileHash(path), rawHash: await videoFileHash(path), duration: 3, width: 1080, height: 1920, upstreamRevision: 'a'.repeat(32), reusedStages: 0, renderedAssetId: null }; }

test('independent video creation has no article requirement and no implicit render', async () => {
  const { project } = await fixture(); assert.equal(currentVideoRevision(project).sourceArticle, null); assert.equal(project.renders.length, 0); assert.equal(project.approval, null); assert.equal(project.status, 'editing');
  await assert.rejects(createVideoProject({ brief: project.brief }, { repository: memoryRepository() }));
});
test('video evidence and spoken script cannot silently diverge', async () => {
  const { project, dependencies } = await fixture();
  await assert.rejects(updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, script: 'Unrelated spoken text' } }, dependencies), /must match/);
  await assert.rejects(updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, scenes: [{ ...content.scenes[0], sourceUrls: ['https://invented.example/'] }] } }, dependencies), /outside/);
});
test('a changed video revision invalidates render and delivery approval', async () => {
  const { project, dependencies } = await fixture(); const approved = await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies);
  assert.equal(approved.approval?.inputHash, videoRevisionHash(approved));
  const edited = await updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, title: 'Save your editor work' } }, dependencies);
  assert.equal(edited.revision, 2); assert.equal(edited.approval, null); assert.equal(edited.deliveryApproval, null); assert.equal(edited.revisions.length, 2);
  await assert.rejects(renderVideoProject(project.id, 1, {}, dependencies), /revision changed/);
  await assert.rejects(renderVideoProject(project.id, 2, {}, dependencies), /Approve/);
});
test('script generation enforces editorial assessment and does not invent media', async () => {
  const dependencies: VideoDependencies = { repository: memoryRepository(), generate: async <T>(schema: z.ZodType<T>) => schema.parse({ assessment: { status: 'excluded', reasons: ['Outside allowed editorial scope'] }, content: null }) };
  const project = await createVideoProject({ explicitlyRequested: true, brief: { topic: 'Software', audience: 'Readers', instruction: 'Practical instructions', sources: [source], platform: 'youtube' } }, dependencies);
  await assert.rejects(generateVideoScript(project.id, 1, {}, dependencies), /excluded/); assert.equal((await getIndependentVideoProject(project.id, dependencies)).revision, 1);
  dependencies.generate = async <T>(schema: z.ZodType<T>) => schema.parse({ assessment: { status: 'allowed', reasons: ['Source-backed software topic'] }, content: { ...content, scenes: content.scenes.map(scene => ({ ...scene, assetId: null })) } });
  const generated = await generateVideoScript(project.id, 1, {}, dependencies); assert.equal(generated.revision, 2); assert.equal(generated.renders.length, 0);
  await assert.rejects(approveVideoRevision(project.id, { expectedRevision: 2 }, dependencies), /real reviewed asset/);
});
test('video refinement remains a proposal until accepted and stale proposals cannot overwrite edits', async () => {
  const replacement = videoContentSchema.parse({ ...content, title: 'Remember to save' });
  const { project, dependencies } = await fixture({ generate: async <T>(schema: z.ZodType<T>) => schema.parse({ assessment: { status: 'allowed', reasons: ['Permitted software topic'] }, content: replacement }) });
  const result = await createVideoRefinement(project.id, { expectedRevision: 1, instruction: 'Make the title specific.' }, {}, dependencies);
  assert.equal(result.project.revision, 1); assert.equal(currentVideoRevision(result.project).content?.title, content.title);
  await updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, title: 'Manual title' } }, dependencies);
  await assert.rejects(applyVideoRefinement(project.id, result.proposal.id, 2, dependencies), /older/);
});
test('cancelled render cannot commit a late output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-video-domain-')); const path = join(directory, 'fixture.mp4'); await writeFile(path, 'test result bytes');
  try {
    const { project, dependencies } = await fixture(); await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies);
    dependencies.render = async (id, _revision, options) => { await cancelVideoRender(id, options.renderId, dependencies); return output(path); };
    await assert.rejects(renderVideoProject(project.id, 1, {}, dependencies));
    const cancelled = await getIndependentVideoProject(project.id, dependencies); assert.equal(cancelled.renders[0]?.status, 'cancelled'); assert.equal(cancelled.renders[0]?.output, null); assert.notEqual(cancelled.status, 'ready');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('failed render retry retains render ID and gets a new fenced owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-video-domain-')); const path = join(directory, 'fixture.mp4'); await writeFile(path, 'fixture bytes');
  try {
    const { project, dependencies } = await fixture(); await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies);
    dependencies.render = async () => { throw new Error('Interrupted renderer'); }; await assert.rejects(renderVideoProject(project.id, 1, {}, dependencies), /Interrupted/);
    const failed = await getIndependentVideoProject(project.id, dependencies); const first = failed.renders[0]; assert.ok(first);
    dependencies.render = async () => output(path); const retried = await renderVideoProject(project.id, 1, {}, dependencies); const second = retried.renders[0]; assert.ok(second);
    assert.equal(first.id, second.id); assert.notEqual(first.owner, second.owner); assert.equal(second.attempt, 2); assert.equal(second.status, 'succeeded'); assert.equal(retried.status, 'ready');
    const account = { id: randomUUID(), platform: 'youtube' as const, label: 'Test account', provider: 'native' as const, integrationId: 'channel-test', status: 'connected' as const, note: 'Unit fixture only', verifiedAt: new Date().toISOString() };
    const variant = { platform: 'youtube' as const, title: content.title, text: 'An accurate description', tags: [], mediaPaths: [path] };
    const approved = await approveVideoDelivery(project.id, { expectedRevision: 1, renderId: second.id, account, variant }, dependencies);
    assert.equal(approved.deliveryApproval?.account.integrationId, 'channel-test'); assert.equal(approved.deliveryApproval?.variant.text, variant.text);
    await writeFile(path, 'different bytes'); await assert.rejects(approveVideoDelivery(project.id, { expectedRevision: 1, renderId: second.id, account, variant }, dependencies), /MP4 changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('finishing an older revision does not promote it over manual video edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-video-domain-')); const path = join(directory, 'fixture.mp4'); await writeFile(path, 'fixture bytes');
  try {
    const { project, dependencies } = await fixture(); await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies);
    dependencies.render = async () => { await updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, title: 'Edited while rendering' } }, dependencies); return output(path); };
    const finished = await renderVideoProject(project.id, 1, {}, dependencies); assert.equal(finished.revision, 2); assert.equal(finished.status, 'editing'); assert.equal(finished.renders[0]?.status, 'succeeded'); assert.equal(finished.approval, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('stage cache verifies bytes and cancellation never writes a completion record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-video-stages-')); const key = videoFingerprint({ narration: 'Sentence' }); let produced = 0;
  const producer = async (path: string): Promise<void> => { produced += 1; await writeFile(path, `audio-${produced}`); };
  try {
    const first = await cacheVideoStage(directory, key, 'wav', producer, async () => undefined);
    const second = await cacheVideoStage(directory, key, 'wav', producer, async () => undefined); assert.equal(second.reused, true); assert.equal(produced, 1);
    await writeFile(first.path, 'corrupted'); const third = await cacheVideoStage(directory, key, 'wav', producer, async () => undefined); assert.equal(third.reused, false); assert.equal(produced, 2);
    await assert.rejects(cacheVideoStage(directory, videoFingerprint('cancelled'), 'wav', producer, async () => { throw new Error('Lost render owner'); }), /Lost/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('sentence captions preserve full text and measured nonoverlapping times', () => {
  const text = 'First step. Save your work! 然后关闭编辑器。'; const sentences = splitVideoSentences(text); assert.equal(sentences.join(' ').replace(/\s+/gu, ''), text.replace(/\s+/gu, ''));
  const srt = videoSrt([{ text: 'First step.', start: 0, end: 1.234 }, { text: '保存工作。', start: 1.234, end: 2.5 }]); assert.match(srt, /00:00:01,234/); assert.match(srt, /保存工作/u);
  assert.throws(() => videoSrt([{ text: 'Overlap', start: 0, end: 2 }, { text: 'Second', start: 1, end: 3 }]), /nonoverlapping/);
  assert.throws(() => videoSrt([{ text: '长'.repeat(80), start: 0, end: 2 }]), /three readable lines/);
});
test('reclaimed script and refinement operations reuse their durable receipts', async () => {
  let calls = 0; const generatedContent = { ...content, scenes: content.scenes.map(scene => ({ ...scene, assetId: null })) };
  const dependencies: VideoDependencies = { repository: memoryRepository(), generate: async <T>(schema: z.ZodType<T>) => { calls += 1; return schema.parse({ assessment: { status: 'allowed', reasons: ['Permitted sourced topic'] }, content: generatedContent }); } };
  const project = await createVideoProject({ explicitlyRequested: true, brief: { topic: 'Software', audience: 'Readers', instruction: 'Practical instructions', sources: [source], platform: 'youtube' } }, dependencies);
  const operationId = randomUUID(); const generated = await generateVideoScript(project.id, 1, { operationId }, dependencies);
  const reclaimed = await generateVideoScript(project.id, 1, { operationId }, dependencies); assert.equal(reclaimed.revision, generated.revision); assert.equal(calls, 1);
  const refinementId = randomUUID(); const first = await createVideoRefinement(project.id, { expectedRevision: 2, instruction: 'Keep the sourced meaning.' }, { operationId: refinementId }, dependencies);
  const next = await createVideoRefinement(project.id, { expectedRevision: 2, instruction: 'Keep the sourced meaning.' }, { operationId: refinementId }, dependencies);
  assert.equal(first.proposal.id, next.proposal.id); assert.equal(calls, 2);
});
test('active delivery guard blocks video edits, approvals and replacement renders', async () => {
  const { project, dependencies } = await fixture(); dependencies.assertEditable = async () => { throw new Error('Active or unknown delivery'); };
  await assert.rejects(updateVideoProject(project.id, { expectedRevision: 1, content }, dependencies), /Active/);
  await assert.rejects(approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies), /Active/);
  await assert.rejects(renderVideoProject(project.id, 1, {}, dependencies), /Active/);
  const saved = await getIndependentVideoProject(project.id, dependencies); assert.equal(saved.revision, 1); assert.equal(saved.renders.length, 0);
});

test('standalone delivery retries the same unsubmitted job and preserves historical export after edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-delivery-')); const environment = { ...process.env }; const original = { ...supabaseVideoRepository };
  process.env.STUDIO_DATA_DIR = directory; for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'STUDIO_CONTAINER']) delete process.env[key];
  const bytes = Buffer.alloc(64); bytes.write('ftypisom', 4); const path = join(directory, 'fixture.mp4'); await writeFile(path, bytes);
  try {
    const { project, dependencies } = await fixture(); Object.assign(supabaseVideoRepository, dependencies.repository);
    await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); dependencies.render = async () => output(path); const rendered = await renderVideoProject(project.id, 1, {}, dependencies); const render = rendered.renders[0]; assert(render);
    const account = await addAccount({ platform: 'youtube', label: 'Test channel', provider: 'native', integrationId: 'channel-test', status: 'connected', note: 'Isolated fixture', verifiedAt: null });
    const job = await prepareVideoPublication(project.id, { expectedRevision: 1, renderId: render.id, accountId: account.id, title: 'Save work', text: 'Reviewed description', tags: [] }); assert.equal(job.draftId, null);
    await mutateState(state => { const current = state.jobs.find(item => item.id === job.id); assert(current); current.status = 'failed'; current.error = 'Pre-submission failure'; });
    const retried = await retryFailedPublication(job.id); assert.equal(retried.id, job.id); assert.equal(retried.status, 'scheduled'); assert.equal(retried.attempts, 0); assert.equal(retried.remoteId, null);
    const article = await createDraft({ topic: 'Unrelated article', audience: 'Users', angle: 'Practical guidance', sources: [source], platforms: ['reddit'] }, { title: 'Unrelated', body: 'Original body', variants: [{ platform: 'reddit', title: 'Unrelated', text: 'Reviewed text', tags: [], mediaPaths: [] }] });
    await replaceDraft(article.id, { ...article, body: 'Edited article' }, article.revision); await verifyVideoDeliveryApproval(retried);
    await updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, title: 'New video title' } }, dependencies);
    assert.equal((await exportJob(job.id)).job.snapshot?.video?.revision, 1); await assert.rejects(verifyVideoDeliveryApproval(retried), /changed/);
    await mutateState(state => { const current = state.jobs.find(item => item.id === job.id); assert(current); current.status = 'failed'; }); await markYouTubeJournalPresence(job.id);
    await assert.rejects(retryFailedPublication(job.id), /journal/);
  } finally { Object.assign(supabaseVideoRepository, original); process.env = environment; await rm(directory, { recursive: true, force: true }); }
});
test('cancelled or reclaimed operation ownership prevents late script and render persistence', async () => {
  let owned = true; const base = memoryRepository(); const repository: VideoRepository = { ...base, async save(project, version, fence) { if (fence && !owned) throw new Error('Operation cancelled or ownership changed'); return base.save(project, version); } };
  const dependencies: VideoDependencies = { repository, generate: async <T>(schema: z.ZodType<T>) => { owned = false; return schema.parse({ assessment: { status: 'allowed', reasons: ['Permitted topic'] }, content: { ...content, scenes: content.scenes.map(scene => ({ ...scene, assetId: null })) } }); } };
  const project = await createVideoProject({ explicitlyRequested: true, brief: { topic: 'Software', audience: 'Readers', instruction: 'Practical guidance', sources: [source], platform: 'youtube' } }, dependencies);
  dependencies.operationFence = { id: randomUUID(), owner: randomUUID() };
  await assert.rejects(generateVideoScript(project.id, 1, {}, dependencies), /Operation cancelled/); assert.equal((await base.get(project.id)).revision, 1);
  owned = true; delete dependencies.operationFence; await updateVideoProject(project.id, { expectedRevision: 1, content }, dependencies); await approveVideoRevision(project.id, { expectedRevision: 2 }, dependencies);
  const directory = await mkdtemp(join(tmpdir(), 'video-owned-render-')); const path = join(directory, 'fixture.mp4'); await writeFile(path, 'fixture bytes');
  try { dependencies.operationFence = { id: randomUUID(), owner: randomUUID() }; dependencies.render = async () => { owned = false; return output(path); }; await assert.rejects(renderVideoProject(project.id, 2, {}, dependencies), /Operation cancelled/); assert.notEqual((await base.get(project.id)).renders[0]?.status, 'succeeded'); } finally { await rm(directory, { recursive: true, force: true }); }
});

test('long English narration splits at whole-word boundaries', () => {
  const text = 'The editor keeps your original research and turns it into clear instructions that readers can follow without losing the source context.';
  const segments = splitVideoSentences(text);
  assert.equal(segments.join(' '), text);
  assert.deepEqual(segments.flatMap(segment => segment.split(/\s+/u)), text.split(/\s+/u));
  assert.ok(segments.every(segment => [...segment].length <= 70));
  assert.ok(splitVideoSentences('内容'.repeat(80)).every(segment => [...segment].length <= 70));
});
