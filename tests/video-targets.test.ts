import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { type Account, type Job } from '../src/core/model.ts';
import { addAccount } from '../src/core/pipeline.ts';
import { markYouTubeJournalPresence } from '../src/core/publication-journal.ts';
import { mutateState, readState } from '../src/core/store.ts';
import { approvedVideoUploadSettings, prepareVideoPublication, prepareVideoTargetPublication, verifyVideoDeliveryApproval, videoPublicationInputSchema } from '../src/core/video-delivery.ts';
import { approveVideoRenderVariant, approveVideoRevision, approveVideoTarget, createVideoProject, createVideoTarget, currentVideoRevision, getIndependentVideoProject, renderVideoProject, supabaseVideoRepository, updateVideoProject, updateVideoTarget, videoDeliveryApprovalHash, videoRevisionHash, videoTargets, type VideoDependencies, type VideoRepository } from '../src/core/video.ts';
import { videoProjectSchema, videoSettingsSchema, type VideoContent, type VideoOutput, type VideoProject, type VideoTarget } from '../src/core/video-model.ts';
import { videoFileHash, videoFingerprint } from '../src/core/video-tools.ts';
import { videoProjectView, videoRenderDownload } from '../src/server/video-target-api.ts';
import { publicationHandoff } from '../src/core/delivery.ts';
import { deliveryPreflight } from '../src/core/delivery-preflight.ts';
import { DeliveryInputError } from '../src/core/delivery-errors.ts';
import { expectedYouTubeChannelId } from '../src/core/youtube.ts';

const source = { title: 'Editor manual', url: 'https://example.com/manual', excerpt: 'Save your work before closing.' };
const content: VideoContent = { title: 'Save work', script: 'Save your work.', scenes: [{ id: 'save', narration: 'Save your work.', visualDescription: 'A save button.', assetId: randomUUID(), caption: null, sourceUrls: [source.url] }], disclosureReview: 'Review original visuals and synthetic narration.' };
const settings = { privacyStatus: 'private' as const, selfDeclaredMadeForKids: false, containsSyntheticMedia: true, categoryId: '27', defaultLanguage: 'en', descriptionDisclosure: 'AI-assisted narration reviewed by the creator.' };
function memoryRepository(): VideoRepository {
  const rows = new Map<string, VideoProject>();
  return { async get(id) { const project = rows.get(id); assert(project); return structuredClone(project); }, async list() { return [...rows.values()].map(project => structuredClone(project)); }, async save(project, version) {
    assert.equal(rows.get(project.id)?.version ?? 0, version); const next = videoProjectSchema.parse({ ...project, version: version + 1 }); rows.set(project.id, structuredClone(next)); return next;
  } };
}
async function fixture(work: (input: { project: VideoProject; dependencies: VideoDependencies; path: string; root: string; calls: () => number }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'studio-video-targets-')); const environment = { ...process.env };
  process.env.STUDIO_DATA_DIR = root; for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'STUDIO_CONTAINER']) delete process.env[key];
  await mkdir(join(root, 'videos')); const path = join(root, 'videos', 'fixture.mp4'); const bytes = Buffer.alloc(64); bytes.write('ftypisom', 4); await writeFile(path, bytes);
  let calls = 0;
  const dependencies: VideoDependencies = { repository: memoryRepository(), render: async (_id, revision): Promise<VideoOutput> => { calls += 1; return { rawPath: path, videoPath: path, captionsPath: null, manifestPath: join(root, 'manifest.json'), hash: await videoFileHash(path), rawHash: await videoFileHash(path), duration: 1, width: revision.settings.width, height: revision.settings.height, upstreamRevision: 'a'.repeat(32), reusedStages: 0, renderedAssetId: null }; } };
  try { const project = await createVideoProject({ explicitlyRequested: true, brief: { topic: 'Save work', audience: 'New users', instruction: 'Explain saving.', sources: [source], platform: 'youtube' }, content }, dependencies); await work({ project, dependencies, path, root, calls: () => calls }); }
  finally { process.env = environment; await rm(root, { recursive: true, force: true }); }
}
const account = (platform: 'youtube' | 'bilibili'): Account => ({ id: randomUUID(), platform, label: `${platform} fixture`, provider: 'native', integrationId: `${platform}-fixture`, status: 'connected', note: 'Isolated unit fixture', verifiedAt: null });
function targetInput(project: VideoProject, selected: Account, renderId: string) { return { expectedRevision: project.revision, accountId: selected.id, renderId, title: 'Save work', text: 'How to save before closing.', tags: ['editor'], deliverySettings: selected.platform === 'youtube' ? { youtube: settings } : {} }; }
function editInput(project: VideoProject, target: VideoTarget) { return { expectedRevision: project.revision, expectedTargetRevision: target.revision, accountId: target.accountId, renderId: target.renderId, title: target.title, text: target.text, tags: target.tags, deliverySettings: target.deliverySettings }; }
function boundJob(project: VideoProject, target: VideoTarget): Job {
  const approval = target.approval; assert(approval); const at = new Date().toISOString();
  return { id: randomUUID(), draftId: null, subject: { kind: 'video', id: project.id, revision: project.revision }, platform: target.platform, accountId: approval.account.id, approvedHash: approval.approvalHash, contentHash: approval.approvalHash,
    snapshot: { video: { projectId: project.id, revision: project.revision, renderId: approval.renderId, renderHash: approval.outputHash, approvalHash: approval.approvalHash, sources: project.brief.sources, hashVersion: 2, targetId: target.id, targetRevision: target.revision, renderInputHash: approval.renderInputHash, deliverySettings: target.deliverySettings }, account: approval.account, variant: approval.variant },
    status: 'queued', scheduledAt: at, createdAt: at, provider: 'native', providerPostId: null, remoteId: null, remoteUrl: null, attempts: 1, error: null, submissionOwner: null, submissionStartedAt: null, metrics: [], history: [] };
}

test('new video creation defaults landscape while legacy settings and V1 hash stay unchanged', async () => fixture(async ({ project, dependencies }) => {
  assert.equal(currentVideoRevision(project).settings.width, 1920); assert.equal(currentVideoRevision(project).settings.height, 1080);
  assert.deepEqual(videoSettingsSchema.parse({}), { width: 1080, height: 1920, fps: 24, voice: 'af_heart', speed: 1, captions: true, burnCaptions: true, font: 'Noto Sans CJK SC', maxSeconds: 180 });
  const before = videoRevisionHash(project); await createVideoTarget(project.id, { ...targetInput(project, account('bilibili'), randomUUID()), platform: 'bilibili', renderId: null }, dependencies);
  assert.equal(videoRevisionHash(await getIndependentVideoProject(project.id, dependencies)), before);
  assert.equal(before, videoFingerprint({ platform: project.brief.platform, brief: project.brief, revision: currentVideoRevision(project) }));
}));

test('video create command retries reuse one project and compare its immutable initial input', async () => fixture(async ({ project, dependencies }) => {
  const commandId = randomUUID(); const input = { explicitlyRequested: true, commandId, brief: project.brief, content };
  const saved = await createVideoProject(input, dependencies); assert.equal(saved.id, commandId);
  await updateVideoProject(saved.id, { expectedRevision: 1, content: { ...content, title: 'An edited title' } }, dependencies);
  const retry = await createVideoProject(input, dependencies); assert.equal(retry.id, saved.id); assert.equal(retry.revision, 2);
  assert.equal(currentVideoRevision(retry).content?.title, 'An edited title');
  await assert.rejects(createVideoProject({ ...input, brief: { ...project.brief, instruction: 'A different project instruction.' } }, dependencies), /Command ID already used/);
  const chinese = await createVideoProject({ explicitlyRequested: true, brief: { ...project.brief, topic: '保存编辑器工作' } }, dependencies); assert.equal(currentVideoRevision(chinese).settings.voice, 'zf_xiaobei');
  assert.equal((await dependencies.repository!.list()).length, 3);
}));

test('one video render serves two independent targets and editing one preserves the other approval', async () => fixture(async ({ project, dependencies, calls }) => {
  await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies); const render = current.renders[0]; assert(render);
  const youtube = account('youtube'); const bili = account('bilibili');
  current = await updateVideoTarget(project.id, project.id, { ...targetInput(current, youtube, render.id), expectedTargetRevision: 1 }, dependencies);
  current = await createVideoTarget(project.id, { ...targetInput(current, bili, render.id), platform: 'bilibili' }, dependencies);
  const biliTarget = videoTargets(current).find(target => target.platform === 'bilibili'); assert(biliTarget);
  current = await approveVideoTarget(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 2, account: youtube }, dependencies);
  current = await approveVideoTarget(project.id, biliTarget.id, { expectedRevision: 1, expectedTargetRevision: 1, account: bili }, dependencies);
  const youtubeApproval = videoTargets(current)[0]?.approval; assert(youtubeApproval);
  const edited = await updateVideoTarget(project.id, biliTarget.id, { ...editInput(current, biliTarget), title: '保存工作的方法' }, dependencies);
  assert.deepEqual(videoTargets(edited)[0]?.approval, youtubeApproval); assert.equal(videoTargets(edited).find(target => target.id === biliTarget.id)?.approval, null);
  assert.equal(edited.revision, 1); assert.equal(edited.renders.length, 1); assert.equal(calls(), 1);
  assert.deepEqual(edited.renders, current.renders);
  await assert.rejects(updateVideoTarget(project.id, biliTarget.id, editInput(current, biliTarget), dependencies), /revision changed/);
}));

test('render variants reuse identical outputs and isolate differing frame dimensions', async () => fixture(async ({ project, dependencies, calls }) => {
  await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies); const oldRender = structuredClone(current.renders[0]);
  await approveVideoRenderVariant(project.id, 1, { width: 1920, height: 1080 }, dependencies);
  current = await renderVideoProject(project.id, 1, { settings: { width: 1920, height: 1080 } }, dependencies); assert.equal(calls(), 1); assert.deepEqual(current.renders[0], oldRender);
  await approveVideoRenderVariant(project.id, 1, { width: 1080, height: 1920 }, dependencies);
  current = await renderVideoProject(project.id, 1, { settings: { width: 1080, height: 1920 } }, dependencies);
  assert.equal(calls(), 2); assert.equal(current.renders.length, 2); assert.equal(current.renders[1]?.settings?.width, 1080); assert.notEqual(current.renders[1]?.inputHash, oldRender?.inputHash);
  assert.deepEqual(current.renders[0], oldRender); assert.equal(currentVideoRevision(current).settings.width, 1920);
  await renderVideoProject(project.id, 1, { settings: { width: 1080, height: 1920 } }, dependencies); assert.equal(calls(), 2);
}));

test('video target fences protect only the target with an unknown external delivery', async () => fixture(async ({ project, dependencies, root }) => {
  await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies); const render = current.renders[0]; assert(render);
  const youtube = account('youtube'); const bili = account('bilibili');
  current = await updateVideoTarget(project.id, project.id, { ...targetInput(current, youtube, render.id), expectedTargetRevision: 1 }, dependencies);
  current = await approveVideoTarget(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 2, account: youtube }, dependencies);
  current = await createVideoTarget(project.id, { ...targetInput(current, bili, render.id), platform: 'bilibili' }, dependencies);
  const yt = videoTargets(current)[0]; const bt = videoTargets(current)[1]; assert(yt && bt); const job = boundJob(current, yt); dependencies.deliveryJobs = async () => [job];
  await assert.rejects(updateVideoTarget(project.id, yt.id, editInput(current, yt), dependencies), /active or unknown/);
  await updateVideoTarget(project.id, bt.id, { ...editInput(current, bt), text: 'Bilibili description changed.' }, dependencies);
  job.status = 'failed'; job.attempts = 0; await markYouTubeJournalPresence(job.id);
  assert.equal(await readFile(join(root, 'publication-journals', `${job.id}.json`), 'utf8').then(value => JSON.parse(value).journalPresent), true);
  await assert.rejects(updateVideoTarget(project.id, yt.id, editInput(current, yt), dependencies), /active or unknown/);
}));

test('V2 job receipts survive other target edits and bind upload settings without issuing requests', async () => fixture(async ({ project, dependencies }) => {
  const previousRepository = { ...supabaseVideoRepository }; Object.assign(supabaseVideoRepository, dependencies.repository);
  try {
    await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies); const render = current.renders[0]; assert(render);
    const yt = await addAccount(account('youtube')); const bili = await addAccount(account('bilibili'));
    current = await updateVideoTarget(project.id, project.id, { ...targetInput(current, yt, render.id), expectedTargetRevision: 1 }, dependencies);
    const job = await prepareVideoTargetPublication(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 2 });
    assert.equal(job.snapshot?.video?.hashVersion, 2); assert.deepEqual(approvedVideoUploadSettings(job, undefined), settings);
    assert.throws(() => approvedVideoUploadSettings(job, { ...settings, privacyStatus: 'public' }), /after approval/);
    const changedMedia = structuredClone(job); assert(changedMedia.snapshot); changedMedia.snapshot.variant.mediaPaths = ['/another/movie.mp4'];
    await assert.rejects(verifyVideoDeliveryApproval(changedMedia), /binding is invalid/);
    current = await createVideoTarget(project.id, { ...targetInput(current, yt, render.id), platform: 'youtube', title: 'A second target for the same account' }, dependencies);
    const twin = videoTargets(current).find(target => target.platform === 'youtube' && target.id !== project.id); assert(twin);
    await assert.rejects(prepareVideoTargetPublication(project.id, twin.id, { expectedRevision: 1, expectedTargetRevision: 1 }), /earlier video delivery.*pending/);
    current = await createVideoTarget(project.id, { ...targetInput(current, bili, render.id), platform: 'bilibili' }, dependencies);
    await verifyVideoDeliveryApproval(job); const bt = videoTargets(current).find(target => target.platform === 'bilibili'); assert(bt);
    await assert.rejects(prepareVideoTargetPublication(project.id, bt.id, { expectedRevision: 1, expectedTargetRevision: 1, automatic: true }), /Bilibili.*manual handoff/);
    const duplicate = await prepareVideoTargetPublication(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 2 }); assert.equal(duplicate.id, job.id);
    await mutateState(state => { const saved = state.jobs.find(item => item.id === job.id); assert(saved); saved.status = 'failed'; });
    current = await getIndependentVideoProject(project.id, dependencies); const target = videoTargets(current)[0]; assert(target);
    await updateVideoTarget(project.id, target.id, { ...editInput(current, target), title: 'An updated title' }, dependencies);
    await assert.rejects(verifyVideoDeliveryApproval(job), /approval changed/); await verifyVideoDeliveryApproval(job, { historical: true });
    await mutateState(state => { const saved = state.jobs.find(item => item.id === job.id); assert(saved); saved.status = 'cancelled'; });
    await markYouTubeJournalPresence(job.id);
    await assert.rejects(prepareVideoTargetPublication(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 3 }), /remote or unknown/);
  } finally { Object.assign(supabaseVideoRepository, previousRepository); }
}));

test('safe video views and stable media routes expose no internal paths and do not rewrite output', async () => fixture(async ({ project, dependencies, path, root }) => {
  await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); const rendered = await renderVideoProject(project.id, 1, {}, dependencies); const render = rendered.renders[0]; assert(render);
  const before = await stat(path); const digest = await videoFileHash(path); const serialized = JSON.stringify(videoProjectView(rendered, []));
  assert(!serialized.includes(root)); assert(!serialized.includes('videoPath')); assert(!serialized.includes('manifestPath'));
  const safe = videoProjectView(rendered, []); assert.equal(safe.renders[0]?.output?.mediaUrl, `/api/video-projects/${project.id}/renders/${render.id}/media`);
  assert.equal(await videoRenderDownload(rendered, render.id, 'media'), path); assert.equal(await videoFileHash(path), digest); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  await assert.rejects(videoRenderDownload(rendered, '../fixture', 'media'));
  await writeFile(path, 'changed output'); await assert.rejects(videoRenderDownload(rendered, render.id, 'media'), /integrity/);
}));

test('a V1 approval hash ignores new target collections and render approvals', async () => fixture(async ({ project, dependencies }) => {
  await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); const rendered = await renderVideoProject(project.id, 1, {}, dependencies); const render = rendered.renders[0]; assert(render?.output);
  const selected = account('youtube'); const variant = { platform: 'youtube' as const, title: 'Save work', text: 'A reviewed description', tags: [], mediaPaths: [render.output.videoPath] };
  const hash = videoDeliveryApprovalHash(rendered, render, selected, variant);
  const changed = await createVideoTarget(project.id, { ...targetInput(rendered, account('bilibili'), render.id), platform: 'bilibili' }, dependencies);
  assert.equal(videoDeliveryApprovalHash(changed, render, selected, variant), hash);
  const edited = await updateVideoProject(project.id, { expectedRevision: 1, content: { ...content, title: 'Save editor work' } }, dependencies);
  assert.equal(videoTargets(edited)[0]?.sourceRevision, 1); assert.equal(edited.revision, 2); assert.equal(edited.renderApprovals?.length, 0);
}));

test('manual video handoff shares stable MP4 and caption URLs without exposing or modifying file paths', async () => fixture(async ({ project, dependencies, root }) => {
  const previousRepository = { ...supabaseVideoRepository }; Object.assign(supabaseVideoRepository, dependencies.repository);
  try {
    await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies);
    const render = current.renders[0]; assert(render?.output); const captions = join(root, 'videos', 'captions.srt'); await writeFile(captions, '1\n00:00:00,000 --> 00:00:01,000\nSave work\n');
    current = await dependencies.repository!.save({ ...current, renders: current.renders.map(item => item.id === render.id ? { ...item, output: { ...render.output!, captionsPath: captions } } : item) }, current.version);
    const bili = await addAccount(account('bilibili')); current = await createVideoTarget(project.id, { ...targetInput(current, bili, render.id), platform: 'bilibili' }, dependencies);
    const target = videoTargets(current).find(item => item.platform === 'bilibili'); assert(target);
    const job = await prepareVideoTargetPublication(project.id, target.id, { expectedRevision: 1, expectedTargetRevision: 1 });
    const before = await getIndependentVideoProject(project.id, dependencies); const handoff = await publicationHandoff(job.id);
    assert.equal(handoff.articlePackageUrl, null); assert.equal(handoff.files.length, 2); assert(!JSON.stringify(handoff).includes(root));
    assert.equal(handoff.files[0]?.url, `/api/video-projects/${project.id}/renders/${render.id}/media?download=true`); assert.equal(handoff.files[1]?.url, `/api/video-projects/${project.id}/renders/${render.id}/captions`);
    assert.deepEqual(await getIndependentVideoProject(project.id, dependencies), before);
  } finally { Object.assign(supabaseVideoRepository, previousRepository); }
}));

test('video target and legacy publication reuse reject changed delivery actions and preserve unknown outcomes', async () => fixture(async ({ project, dependencies }) => {
  const previousRepository = { ...supabaseVideoRepository }; Object.assign(supabaseVideoRepository, dependencies.repository);
  try {
    await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies);
    const render = current.renders[0]; assert(render);
    const selected = await addAccount({ ...account('youtube'), integrationId: expectedYouTubeChannelId });
    current = await updateVideoTarget(project.id, project.id, { ...targetInput(current, selected, render.id), expectedTargetRevision: 1 }, dependencies);
    for (const automatic of [false, true]) {
      await mutateState(state => { state.jobs = []; });
      const input = { expectedRevision: 1, expectedTargetRevision: 2, automatic };
      const first = await prepareVideoTargetPublication(project.id, project.id, input);
      assert.equal((await prepareVideoTargetPublication(project.id, project.id, input)).id, first.id);
      const before = (await readState()).jobs;
      await assert.rejects(prepareVideoTargetPublication(project.id, project.id, { ...input, automatic: !automatic }), error => error instanceof DeliveryInputError);
      const check = await deliveryPreflight({ items: [{ subjectKind: 'video', videoId: project.id, targetId: project.id, expectedRevision: 1, expectedTargetRevision: 2, accountId: selected.id, action: automatic ? 'manual_handoff' : 'publish' }] });
      assert.equal(check.items[0]?.eligible, false); assert.match(check.items[0]?.issues[0]?.nextAction ?? '', /原交付/u);
      assert.deepEqual((await readState()).jobs, before);
    }
    for (const status of ['submitting', 'needs_reconciliation'] as const) {
      await mutateState(state => { state.jobs[0]!.status = status; });
      const before = (await readState()).jobs;
      for (const automatic of [false, true]) await assert.rejects(prepareVideoTargetPublication(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 2, automatic }), /核对原任务/u);
      assert.deepEqual((await readState()).jobs, before);
    }
    for (const automatic of [false, true]) {
      await mutateState(state => { state.jobs = []; });
      const input = videoPublicationInputSchema.parse({ expectedRevision: 1, renderId: render.id, accountId: selected.id, title: 'Save work', text: 'Legacy reviewed description', tags: [], automatic });
      const first = await prepareVideoPublication(project.id, input);
      assert.equal((await prepareVideoPublication(project.id, input)).id, first.id);
      await assert.rejects(prepareVideoPublication(project.id, { ...input, automatic: !automatic }), error => error instanceof DeliveryInputError);
      assert.equal((await readState()).jobs.length, 1); assert.equal((await readState()).jobs[0]?.status, first.status);
    }
  } finally { Object.assign(supabaseVideoRepository, previousRepository); }
}));

test('video target preparation checks action again when a duplicate appears after approval', async () => fixture(async ({ project, dependencies }) => {
  const previousRepository = { ...supabaseVideoRepository }; Object.assign(supabaseVideoRepository, dependencies.repository);
  try {
    await approveVideoRevision(project.id, { expectedRevision: 1 }, dependencies); let current = await renderVideoProject(project.id, 1, {}, dependencies);
    const render = current.renders[0]; assert(render);
    const selected = await addAccount({ ...account('youtube'), integrationId: expectedYouTubeChannelId });
    current = await updateVideoTarget(project.id, project.id, { ...targetInput(current, selected, render.id), expectedTargetRevision: 1 }, dependencies);
    for (const automatic of [false, true]) {
      await mutateState(state => { state.jobs = []; });
      let injected = false;
      supabaseVideoRepository.save = async (value, version) => {
        const saved = await dependencies.repository!.save(value, version); const target = videoTargets(saved)[0]; assert(target?.approval);
        if (!injected) { injected = true; await mutateState(state => { state.jobs.push({ ...boundJob(saved, target), status: automatic ? 'awaiting_operator' : 'scheduled', attempts: 0 }); }); }
        return saved;
      };
      await assert.rejects(prepareVideoTargetPublication(project.id, project.id, { expectedRevision: 1, expectedTargetRevision: 2, automatic }), error => error instanceof DeliveryInputError);
      assert.equal(injected, true); const jobs = (await readState()).jobs;
      assert.equal(jobs.length, 1); assert.equal(jobs[0]?.status, automatic ? 'awaiting_operator' : 'scheduled'); assert.equal(jobs[0]?.attempts, 0);
    }
  } finally { Object.assign(supabaseVideoRepository, previousRepository); }
}));
