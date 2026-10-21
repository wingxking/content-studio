import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dbRequest, dbRpc } from './database.ts';
import { readState } from './store.ts';
import { hasYouTubeUploadJournal } from './publication-journal.ts';
import { editorialPolicyPrompt, platformGuidancePrompt } from './content-prompts.ts';
import { describeEditorialAssessment, runStructuredGeneration, type GenerationOptions } from './generation-engine.ts';
import { readDraftRevision } from './artifacts.ts';
import { accountSchema, variantSchema, type Account, type Variant, type Job } from './model.ts';
import { videoApprovalInputSchema, videoCreateInputSchema, videoEditInputSchema, videoGenerationEnvelopeSchema, videoProjectSchema, videoRefinementInputSchema, videoSettingsSchema, videoTargetInputSchema, videoTargetEditSchema, type VideoContent, type VideoProject, type VideoRender, type VideoRevision, type VideoSettings, type VideoTarget } from './video-model.ts';
import { videoDeliverySettingsSchema, type VideoDeliverySettings } from '../contracts/video.ts';
import { cancelRendererProject, readRendererRevision, renderVideoRevision, type VideoRendererOptions } from './video-renderer.ts';
import { videoFileHash, videoFingerprint } from './video-tools.ts';
import { resolveMediaLocation } from './media-location.ts';

export interface VideoRepository {
  get(id: string): Promise<VideoProject>;
  list(): Promise<VideoProject[]>;
  save(project: VideoProject, expectedVersion: number, fence?: { id: string; owner: string }): Promise<VideoProject>;
}
const workspace = (): string => z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
const now = (): string => new Date().toISOString();
export const supabaseVideoRepository: VideoRepository = {
  async get(id) {
    const rows = z.array(z.object({ content: videoProjectSchema })).parse(await dbRequest(`studio_video_projects?id=eq.${z.uuid().parse(id)}&workspace_id=eq.${workspace()}`));
    if (!rows[0]) throw new Error('Video project not found.'); return rows[0].content;
  },
  async list() { return z.array(z.object({ content: videoProjectSchema })).parse(await dbRequest(`studio_video_projects?workspace_id=eq.${workspace()}&order=updated_at.desc&limit=100`)).map(row => row.content); },
  async save(project, expectedVersion, fence) {
    const content = videoProjectSchema.parse({ ...project, version: expectedVersion + 1, updatedAt: now() });
    return videoProjectSchema.parse(await dbRpc(fence ? 'studio_put_owned_video_project' : 'studio_put_video_project', { p_workspace: workspace(), p_id: content.id, p_expected_version: expectedVersion, p_content: content, ...(fence ? { p_operation: fence.id, p_owner: fence.owner } : {}) }));
  },
};
export type VideoGenerationOptions = GenerationOptions & { operationId?: string };
export interface VideoDependencies { operationFence?: { id: string; owner: string }; assertEditable?: (id: string) => Promise<void>; repository?: VideoRepository; generate?: typeof runStructuredGeneration; render?: typeof renderVideoRevision; resolveArticle?: typeof readDraftRevision; deliveryJobs?: () => Promise<Job[]> }
function repository(options?: VideoDependencies): VideoRepository { const base = options?.repository ?? supabaseVideoRepository; return options?.operationFence ? { ...base, save: (project, version) => base.save(project, version, options.operationFence) } : base; }
async function assertVideoEditable(id: string, dependencies: VideoDependencies): Promise<void> {
  if (dependencies.assertEditable) { await dependencies.assertEditable(id); return; }
  if (dependencies.repository) return;
  const jobs = (await readState()).jobs.filter(job => job.subject?.kind === 'video' && job.subject.id === id);
  for (const job of jobs) {
    if (['submitting', 'queued', 'needs_reconciliation'].includes(job.status) || !['published', 'delivered'].includes(job.status) && await hasYouTubeUploadJournal(job)) throw new Error('This video has an active or unknown delivery. Reconcile it before changing its revision, rendering or approval.');
  }
}
export function currentVideoRevision(project: VideoProject): VideoRevision {
  const revision = project.revisions.find(candidate => candidate.number === project.revision); if (!revision) throw new Error('Current video revision is missing.'); return revision;
}
export function videoRevisionHash(project: VideoProject): string { return videoFingerprint({ platform: project.brief.platform, brief: project.brief, revision: currentVideoRevision(project) }); }
// Keep videoRevisionHash and videoDeliveryApprovalHash unchanged: historical receipts use V1.
export function videoRenderInputHash(project: VideoProject, settings: VideoSettings): string {
  return videoFingerprint({ contract: 'studio-video-render-v2', projectId: project.id, revision: { ...currentVideoRevision(project), settings }, sources: project.brief.sources });
}
export function isCurrentVideoRender(project: VideoProject, render: VideoRender): boolean {
  return render.revision === project.revision && (render.hashVersion === 2 ? Boolean(render.settings && render.inputHash === videoRenderInputHash(project, render.settings)) : render.inputHash === videoRevisionHash(project));
}
export function videoTargets(project: VideoProject): VideoTarget[] {
  if (project.targets) return project.targets;
  const content = currentVideoRevision(project).content; const old = project.deliveryApproval;
  return [{ id: project.id, platform: project.brief.platform, revision: 1, sourceRevision: project.revision,
    accountId: old?.accountId ?? null, renderId: old?.renderId ?? project.renders.findLast(render => render.status === 'succeeded' && isCurrentVideoRender(project, render))?.id ?? null,
    title: old?.variant.title ?? content?.title ?? project.brief.topic,
    text: old?.variant.text ?? (project.brief.instruction || content?.script || project.brief.topic),
    tags: old?.variant.tags ?? [], deliverySettings: {}, approval: null }];
}
function targetJob(job: Job, projectId: string, target: VideoTarget): boolean {
  if (job.subject?.kind !== 'video' || job.subject.id !== projectId || !job.snapshot?.video) return false;
  const identity = z.object({ targetId: z.uuid().optional() }).parse(job.snapshot.video);
  return identity.targetId ? identity.targetId === target.id : target.id === projectId;
}
async function assertVideoTargetEditable(projectId: string, target: VideoTarget, dependencies: VideoDependencies): Promise<void> {
  if (dependencies.assertEditable) { await dependencies.assertEditable(projectId); return; }
  if (dependencies.repository && !dependencies.deliveryJobs) return;
  const jobs = dependencies.deliveryJobs ? await dependencies.deliveryJobs() : (await readState()).jobs;
  for (const job of jobs.filter(item => targetJob(item, projectId, target))) {
    if (['submitting', 'queued', 'needs_reconciliation'].includes(job.status) || !['published', 'delivered'].includes(job.status) && await hasYouTubeUploadJournal(job)) throw new Error('This video target has an active or unknown delivery. Reconcile that target before editing it.');
  }
}
function validateTargetSelection(project: VideoProject, target: VideoTarget): void {
  if (target.deliverySettings.youtube && target.platform !== 'youtube') throw new Error('YouTube delivery settings belong only to a YouTube target.');
  if (target.renderId && !project.renders.some(render => render.id === target.renderId && render.status === 'succeeded' && render.output && isCurrentVideoRender(project, render))) throw new Error('Select a successful render of the current video revision.');
}
export async function createVideoTarget(id: string, value: unknown, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const input = videoTargetInputSchema.parse(value); const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, input.expectedRevision);
  const { expectedRevision: _expected, ...fields } = input;
  const target: VideoTarget = { ...fields, id: randomUUID(), revision: 1, sourceRevision: project.revision, approval: null };
  validateTargetSelection(project, target);
  return repository(dependencies).save({ ...project, targets: [...videoTargets(project), target] }, project.version);
}
export async function updateVideoTarget(id: string, targetId: string, value: unknown, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const input = videoTargetEditSchema.parse(value); const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, input.expectedRevision);
  const targets = videoTargets(project); const previous = targets.find(item => item.id === z.uuid().parse(targetId));
  if (!previous) throw new Error('Video target not found.');
  if (previous.revision !== input.expectedTargetRevision) throw new Error('Video target revision changed; refresh before saving.');
  await assertVideoTargetEditable(id, previous, dependencies);
  const { expectedRevision: _videoRevision, expectedTargetRevision: _targetRevision, ...fields } = input;
  const target: VideoTarget = { ...previous, ...fields, revision: previous.revision + 1, sourceRevision: project.revision, approval: null };
  validateTargetSelection(project, target);
  return repository(dependencies).save({ ...project, targets: targets.map(item => item.id === target.id ? target : item), ...(target.id === project.id ? { deliveryApproval: null } : {}) }, project.version);
}
export function videoTargetDeliveryHash(input: { projectId: string; revision: VideoRevision; sources: VideoProject['brief']['sources']; targetId: string; targetRevision: number; render: VideoRender; account: Account; variant: Variant; deliverySettings: VideoDeliverySettings }): string {
  if (!input.render.output) throw new Error('Video render has no output.');
  const { id, platform, provider, integrationId, physicalIdentity } = input.account;
  const { title, text, tags } = input.variant;
  return videoFingerprint({ contract: 'studio-video-delivery-v2', projectId: input.projectId, revision: input.revision, sources: input.sources, targetId: input.targetId, targetRevision: input.targetRevision, renderId: input.render.id, renderInputHash: input.render.inputHash, outputHash: input.render.output.hash,
    account: { id, platform, provider, integrationId, physicalIdentity: physicalIdentity?.id ?? null }, variant: { platform: input.variant.platform, title, text, tags }, deliverySettings: videoDeliverySettingsSchema.parse(input.deliverySettings) });
}
export async function approveVideoTarget(id: string, targetId: string, input: { expectedRevision: number; expectedTargetRevision: number; account: Account }, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, input.expectedRevision); const targets = videoTargets(project); const target = targets.find(item => item.id === z.uuid().parse(targetId));
  if (!target || target.revision !== input.expectedTargetRevision || target.sourceRevision !== project.revision) throw new Error('Review the current video target revision before publishing.');
  await assertVideoTargetEditable(id, target, dependencies);
  const account = accountSchema.parse(input.account);
  if (target.accountId !== account.id || target.platform !== account.platform) throw new Error('Video target and selected account do not match.');
  const render = project.renders.find(item => item.id === target.renderId);
  if (!render?.output || render.status !== 'succeeded' || !isCurrentVideoRender(project, render)) throw new Error('Review a completed render of the current video revision.');
  if (await videoFileHash(await resolveMediaLocation(render.output.videoPath)) !== render.output.hash) throw new Error('The reviewed MP4 changed; render it again.');
  const variant = variantSchema.parse({ platform: target.platform, title: target.title, text: target.text, tags: target.tags, mediaPaths: [render.output.videoPath] });
  const approval = { hashVersion: 2 as const, targetRevision: target.revision, revision: project.revision, renderId: render.id, renderInputHash: render.inputHash, outputHash: render.output.hash, account, variant, deliverySettings: target.deliverySettings,
    approvalHash: videoTargetDeliveryHash({ projectId: id, revision: currentVideoRevision(project), sources: project.brief.sources, targetId, targetRevision: target.revision, render, account, variant, deliverySettings: target.deliverySettings }), at: now() };
  return repository(dependencies).save({ ...project, targets: targets.map(item => item.id === targetId ? { ...item, approval } : item) }, project.version);
}
export async function approveVideoRenderVariant(id: string, expectedRevision: number, settings: Partial<VideoSettings>, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, expectedRevision); const revision = currentVideoRevision(project);
  if (!revision.content) throw new Error('Review a storyboard before rendering.');
  validateVideoEvidence(project, revision.content); if (revision.content.scenes.some(scene => !scene.assetId)) throw new Error('Every storyboard scene needs a real reviewed asset.');
  const effective = videoSettingsSchema.parse({ ...revision.settings, ...settings }); const inputHash = videoRenderInputHash(project, effective);
  const approval = { revision: project.revision, inputHash, settings: effective, at: now() };
  return repository(dependencies).save({ ...project, renderApprovals: [...(project.renderApprovals ?? []).filter(item => item.inputHash !== inputHash), approval] }, project.version);
}
export function validateVideoEvidence(project: VideoProject, content: VideoContent): void {
  const sources = new Set(project.brief.sources.map(source => source.url));
  for (const scene of content.scenes) if (scene.sourceUrls.some(url => !sources.has(url))) throw new Error('Storyboard cites a source outside the frozen video brief.');
  const spoken = content.scenes.map(scene => scene.narration).join(' ').replace(/\s+/gu, ' ').trim();
  if (spoken !== content.script.replace(/\s+/gu, ' ').trim()) throw new Error('The script must match storyboard narration in scene order.');
}
function assertRevision(project: VideoProject, expectedRevision: number): void {
  if (project.revision !== z.number().int().positive().parse(expectedRevision)) throw new Error('Video revision changed; refresh before continuing.');
}
function appendRevision(project: VideoProject, content: VideoContent, settings = currentVideoRevision(project).settings, assessment = currentVideoRevision(project).assessment): VideoProject {
  validateVideoEvidence(project, content);
  const previous = currentVideoRevision(project); const revision: VideoRevision = { number: project.revision + 1, createdAt: now(), content, settings, sourceArticle: previous.sourceArticle, assessment };
  return { ...project, revision: revision.number, revisions: [...project.revisions, revision], status: 'editing', approval: null, deliveryApproval: null, renderApprovals: [], ...(project.targets ? { targets: project.targets.map(target => ({ ...target, approval: null })) } : {}) };
}
export async function createVideoProject(input: unknown, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const parsed = videoCreateInputSchema.parse(input);
  const source = parsed.sourceArticle ? await (dependencies.resolveArticle ?? readDraftRevision)(parsed.sourceArticle.draftId, parsed.sourceArticle.revision) : null;
  if (source && (source.id !== parsed.sourceArticle?.draftId || source.revision !== parsed.sourceArticle.revision)) throw new Error('Source article revision could not be verified.');
  const at = now(); const sourceArticle = source ? { draftId: source.id, revision: source.revision, title: source.title, body: source.body } : null;
  const settings = parsed.settings ?? videoSettingsSchema.parse({ voice: /\p{Script=Han}/u.test(parsed.brief.topic + parsed.brief.instruction) ? 'zf_xiaobei' : 'af_heart' });
  const project = videoProjectSchema.parse({ id: parsed.commandId ?? randomUUID(), version: 1, createdAt: at, updatedAt: at, brief: parsed.brief, revision: 1, revisions: [{ number: 1, createdAt: at, content: parsed.content ?? null, settings, sourceArticle, assessment: null }], proposals: [], renders: [], status: 'editing', approval: null, deliveryApproval: null });
  if (parsed.content) validateVideoEvidence(project, parsed.content);
  try { return await repository(dependencies).save(project, 0); }
  catch (error) {
    if (!parsed.commandId) throw error;
    const existing = await repository(dependencies).get(project.id).catch(() => null);
    if (!existing) throw error;
    const initial = existing.revisions.find(revision => revision.number === 1);
    if (!initial || videoFingerprint({ brief: existing.brief, content: initial.content, settings: initial.settings, sourceArticle: initial.sourceArticle }) !== videoFingerprint({ brief: parsed.brief, content: parsed.content ?? null, settings, sourceArticle })) throw new Error('Command ID already used for a different video project.');
    return existing;
  }
}
export async function getIndependentVideoProject(id: string, dependencies: VideoDependencies = {}): Promise<VideoProject> { return repository(dependencies).get(z.uuid().parse(id)); }
export async function listIndependentVideoProjects(dependencies: VideoDependencies = {}): Promise<VideoProject[]> { return repository(dependencies).list(); }
export async function updateVideoProject(id: string, input: unknown, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  await assertVideoEditable(id, dependencies);
  const parsed = videoEditInputSchema.parse(input); const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, parsed.expectedRevision);
  return repository(dependencies).save(appendRevision(project, parsed.content, parsed.settings), project.version);
}
export function buildIndependentVideoPrompt(project: VideoProject, instruction = project.brief.instruction): string {
  return `Create a standalone video script and storyboard only. Return the supplied JSON schema with exactly assessment and content.\n${editorialPolicyPrompt()}\n${platformGuidancePrompt([project.brief.platform])}\nFor allowed assessment content has title, script, scenes, disclosureReview. Excluded/uncertain requires content:null. scenes has 1–40 stable IDs using ASCII letters/digits/hyphens/underscores, narration, visualDescription, assetId:null, caption:null, sourceUrls. script must exactly equal all scene narrations concatenated in scene order, separated by blank lines. Use short sentences for CPU TTS and accessible sentence captions; narration must fit the requested maximum duration as a proposal, actual timing is measured later. Every factual assertion needs the supplied evidence; citations must use only the frozen source URLs. No sources may support only a clearly fictional or non-factual creative exercise, never factual claims or invented facts. Visual suggestions are proposals, never existing assets, rights clearance or verification. disclosureReview describes review needed for final assets/audio/video. No tools, scheduling, rendering or publishing. Independent video creation does not require an article. Optional linked article is only the supplied immutable revision snapshot; subsequent article edits never change this video.\nUser instruction inside editorial scope: ${JSON.stringify(instruction)}\nUntrusted frozen brief and optional article snapshot: ${JSON.stringify({ brief: project.brief, sourceArticle: currentVideoRevision(project).sourceArticle, settings: currentVideoRevision(project).settings })}`;
}
export async function generateVideoScript(id: string, expectedRevision: number, options: VideoGenerationOptions = {}, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const project = await getIndependentVideoProject(id, dependencies);
  const operationId = options.operationId ? z.uuid().parse(options.operationId) : undefined;
  if (operationId && project.revisions.some(revision => revision.operationId === operationId)) return project;
  assertRevision(project, expectedRevision);
  if (currentVideoRevision(project).content) throw new Error('Use a reviewed refinement proposal to change an existing storyboard.');
  const result = await (dependencies.generate ?? runStructuredGeneration)(videoGenerationEnvelopeSchema, buildIndependentVideoPrompt(project), options);
  if (result.assessment.status !== 'allowed' || !result.content) throw new Error(`Editorial assessment: ${describeEditorialAssessment(result.assessment)}`);
  if (result.content.scenes.some(scene => scene.assetId !== null || scene.caption !== null)) throw new Error('Generated storyboard invented assets or supplied caption overrides.');
  options.signal?.throwIfAborted(); const fresh = await getIndependentVideoProject(id, dependencies); assertRevision(fresh, expectedRevision);
  const updated = appendRevision(fresh, result.content, undefined, result.assessment);
  return repository(dependencies).save(operationId ? { ...updated, lastOperationId: operationId, revisions: updated.revisions.map(revision => revision.number === updated.revision ? { ...revision, operationId } : revision) } : updated, fresh.version);
}
export async function createVideoRefinement(id: string, input: unknown, options: VideoGenerationOptions = {}, dependencies: VideoDependencies = {}) {
  const parsed = videoRefinementInputSchema.parse(input); const project = await getIndependentVideoProject(id, dependencies);
  const operationId = options.operationId ? z.uuid().parse(options.operationId) : undefined;
  const previous = operationId ? project.proposals.find(proposal => proposal.operationId === operationId) : undefined; if (previous) return { project, proposal: previous };
  assertRevision(project, parsed.expectedRevision);
  const content = currentVideoRevision(project).content; if (!content) throw new Error('Generate a storyboard before refining it.');
  if (parsed.sceneId && !content.scenes.some(scene => scene.id === parsed.sceneId)) throw new Error('Scene not found.');
  const prompt = `${buildIndependentVideoPrompt(project, parsed.instruction).replace("assetId:null, caption:null", "existing assetId and caption values")}\nThis is a refinement PROPOSAL for the saved storyboard. Keep scene IDs/order and assetId bindings identical. Preserve fields outside the requested scope. ${parsed.sceneId ? `Only scene ${parsed.sceneId} may change; preserve title, disclosureReview and all other scenes, updating script solely to reflect its revised narration.` : 'Refine the script/storyboard within the requested instruction; keep real media bindings.'}\nUntrusted saved content: ${JSON.stringify(content)}`;
  const result = await (dependencies.generate ?? runStructuredGeneration)(videoGenerationEnvelopeSchema, prompt, options);
  if (result.assessment.status !== 'allowed' || !result.content) throw new Error(`Editorial assessment: ${describeEditorialAssessment(result.assessment)}`);
  validateVideoEvidence(project, result.content);
  if (videoFingerprint(content.scenes.map(scene => ({ id: scene.id, assetId: scene.assetId }))) !== videoFingerprint(result.content.scenes.map(scene => ({ id: scene.id, assetId: scene.assetId })))) throw new Error('Refinement changed scene order or real media bindings.');
  if (parsed.sceneId && (content.title !== result.content.title || content.disclosureReview !== result.content.disclosureReview || videoFingerprint(content.scenes.filter(scene => scene.id !== parsed.sceneId)) !== videoFingerprint(result.content.scenes.filter(scene => scene.id !== parsed.sceneId)))) throw new Error('Refinement changed fields outside the selected scene.');
  options.signal?.throwIfAborted(); const fresh = await getIndependentVideoProject(id, dependencies); assertRevision(fresh, parsed.expectedRevision);
  const proposal = { ...(operationId ? { operationId } : {}), id: randomUUID(), baseRevision: parsed.expectedRevision, assessment: result.assessment, instruction: parsed.instruction, content: result.content, createdAt: now(), appliedRevision: null };
  const saved = await repository(dependencies).save({ ...fresh, proposals: [...fresh.proposals, proposal] }, fresh.version);
  return { project: saved, proposal };
}
export async function applyVideoRefinement(id: string, proposalId: string, expectedRevision: number, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  await assertVideoEditable(id, dependencies);
  const project = await getIndependentVideoProject(id, dependencies); const proposal = project.proposals.find(candidate => candidate.id === z.uuid().parse(proposalId));
  if (!proposal) throw new Error('Video refinement proposal not found.');
  if (proposal.appliedRevision) return project;
  assertRevision(project, expectedRevision); if (proposal.baseRevision !== expectedRevision) throw new Error('This proposal belongs to an older video revision.');
  const updated = appendRevision(project, proposal.content, undefined, proposal.assessment);
  return repository(dependencies).save({ ...updated, proposals: updated.proposals.map(candidate => candidate.id === proposalId ? { ...candidate, appliedRevision: updated.revision } : candidate) }, project.version);
}
export async function approveVideoRevision(id: string, input: unknown, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  await assertVideoEditable(id, dependencies);
  const parsed = videoApprovalInputSchema.parse(input); const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, parsed.expectedRevision);
  const content = currentVideoRevision(project).content; if (!content) throw new Error('Review a script and storyboard before approving rendering.');
  validateVideoEvidence(project, content); if (content.scenes.some(scene => !scene.assetId)) throw new Error('Every storyboard scene needs a real reviewed asset before rendering approval.');
  return repository(dependencies).save({ ...project, approval: { revision: project.revision, inputHash: videoRevisionHash(project), at: now() } }, project.version);
}
export function videoDeliveryApprovalHash(project: VideoProject, render: VideoRender, account: Account, variant: Variant): string {
  if (!render.output) throw new Error('Video render has no completed output.');
  return videoFingerprint({ subject: 'video', projectId: project.id, revision: currentVideoRevision(project), brief: project.brief, renderId: render.id, renderHash: render.output.hash, account, variant });
}
export async function approveVideoDelivery(id: string, input: { expectedRevision: number; renderId: string; account: Account; variant: Variant }, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  await assertVideoEditable(id, dependencies);
  const project = await getIndependentVideoProject(id, dependencies); assertRevision(project, input.expectedRevision);
  const account = accountSchema.parse(input.account); const variant = variantSchema.parse(input.variant);
  if (account.platform !== project.brief.platform || variant.platform !== project.brief.platform) throw new Error('Video approval account and metadata must match the selected platform.');
  const render = project.renders.find(candidate => candidate.id === z.uuid().parse(input.renderId));
  if (!render?.output || render.status !== 'succeeded' || render.revision !== project.revision || render.inputHash !== videoRevisionHash(project)) throw new Error('Approve a successful render of the current video revision.');
  if (variant.mediaPaths.length !== 1 || variant.mediaPaths[0] !== render.output.videoPath) throw new Error('Video delivery metadata must attach exactly the reviewed final MP4.');
  if (await videoFileHash(await resolveMediaLocation(render.output.videoPath)) !== render.output.hash) throw new Error('The reviewed MP4 changed; render it again.');
  return repository(dependencies).save({ ...project, deliveryApproval: { renderId: render.id, revision: project.revision, accountId: account.id, outputHash: render.output.hash, approvalHash: videoDeliveryApprovalHash(project, render, account, variant), account, variant, at: now() } }, project.version);
}
const activeRenders = new Map<string, AbortController>();
async function mutateRender(id: string, renderId: string, owner: string, transform: (project: VideoProject, render: VideoRender) => VideoProject, dependencies: VideoDependencies): Promise<VideoProject> {
  let failure: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const project = await getIndependentVideoProject(id, dependencies); const render = project.renders.find(candidate => candidate.id === renderId);
    if (!render || render.owner !== owner || render.status !== 'running') throw new Error('Video render ownership changed or the attempt was cancelled.');
    try { return await repository(dependencies).save(transform(project, render), project.version); } catch (error) { failure = error; }
  }
  throw failure;
}
export async function renderVideoProject(id: string, expectedRevision: number, options: Omit<VideoRendererOptions, 'renderId' | 'fence'> & { settings?: Partial<VideoSettings> } = {}, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  // Adding an immutable output never changes already approved outputs or platform targets.
  if (!options.settings) await assertVideoEditable(id, dependencies);
  let project = await getIndependentVideoProject(id, dependencies); assertRevision(project, expectedRevision);
  const revision = currentVideoRevision(project); const settings = videoSettingsSchema.parse({ ...revision.settings, ...options.settings });
  const inputHash = options.settings ? videoRenderInputHash(project, settings) : videoRevisionHash(project);
  const approved = options.settings ? project.renderApprovals?.some(approval => approval.revision === expectedRevision && approval.inputHash === inputHash) : project.approval?.revision === expectedRevision && project.approval.inputHash === inputHash;
  if (!approved) throw new Error('Approve the current video script, assets and settings before requesting a render.');
  let previous = project.renders.findLast(render => render.revision === expectedRevision && (render.inputHash === inputHash || !render.hashVersion && videoFingerprint(settings) === videoFingerprint(revision.settings) && render.inputHash === videoRevisionHash(project)));
  if (previous?.status === 'succeeded' && previous.output) {
    if (await resolveMediaLocation(previous.output.videoPath).then(videoFileHash).catch(() => '') === previous.output.hash) return project;
    previous = undefined; // Never replace a historical successful render when its file needs repair.
  }
  if (previous?.status === 'running' && Date.now() - Date.parse(previous.heartbeatAt) < 90000) throw new Error('This video render is already active.');
  const renderId = previous?.id ?? randomUUID(); const owner = randomUUID(); const started = now();
  const render: VideoRender = { ...(dependencies.operationFence ? { operationId: dependencies.operationFence.id } : {}), ...(options.settings ? { hashVersion: 2, settings } : {}), id: renderId, revision: expectedRevision, inputHash, status: 'running', owner, attempt: (previous?.attempt ?? 0) + 1, phase: 'Preparing reviewed video', startedAt: started, heartbeatAt: started, finishedAt: null, output: null, error: null };
  project = await repository(dependencies).save({ ...project, status: 'rendering', ...(!options.settings ? { deliveryApproval: null } : {}), renders: [...project.renders.filter(candidate => candidate.id !== renderId), render] }, project.version);
  const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]); activeRenders.set(renderId, controller);
  let heartbeatFailure: Error | null = null; let heartbeatBusy = false;
  const fence = async (): Promise<void> => {
    signal.throwIfAborted(); if (heartbeatFailure) throw heartbeatFailure;
    const current = await getIndependentVideoProject(id, dependencies); const attempt = current.renders.find(candidate => candidate.id === renderId);
    if (!attempt || attempt.status !== 'running' || attempt.owner !== owner) { controller.abort(); throw new Error('Video render was cancelled or replaced.'); }
  };
  const timer = setInterval(() => {
    if (heartbeatBusy) return; heartbeatBusy = true;
    void mutateRender(id, renderId, owner, (current, attempt) => ({ ...current, renders: current.renders.map(candidate => candidate.id === renderId ? { ...attempt, heartbeatAt: now() } : candidate) }), dependencies)
      .catch(error => { heartbeatFailure = error instanceof Error ? error : new Error('Video heartbeat failed.'); controller.abort(); }).finally(() => { heartbeatBusy = false; });
  }, 5000);
  try {
    const output = await (dependencies.render ?? renderVideoRevision)(id, { ...currentVideoRevision(project), settings }, { ...options, signal, renderId, fence, onProgress: async phase => {
      await mutateRender(id, renderId, owner, (current, attempt) => ({ ...current, renders: current.renders.map(candidate => candidate.id === renderId ? { ...attempt, phase, heartbeatAt: now() } : candidate) }), dependencies); await options.onProgress?.(phase);
    } });
    await fence();
    return await mutateRender(id, renderId, owner, (current, attempt) => ({ ...current, status: current.revision === expectedRevision ? 'ready' : current.status, renders: current.renders.map(candidate => candidate.id === renderId ? { ...attempt, status: 'succeeded', phase: 'Completed; review the final MP4', finishedAt: now(), output, error: null } : candidate) }), dependencies);
  } catch (error) {
    const message = (heartbeatFailure as Error | null)?.message ?? (error instanceof Error ? error.message : 'Video rendering failed.');
    await mutateRender(id, renderId, owner, (current, attempt) => ({ ...current, status: current.revision === expectedRevision ? 'failed' : current.status, renders: current.renders.map(candidate => candidate.id === renderId ? { ...attempt, status: signal.aborted && !heartbeatFailure ? 'cancelled' : 'failed', phase: 'Needs attention; completed stages retained', finishedAt: now(), error: message } : candidate) }), dependencies).catch(() => undefined);
    throw error;
  } finally { clearInterval(timer); if (activeRenders.get(renderId) === controller) activeRenders.delete(renderId); }
}
export async function cancelVideoRender(id: string, renderId: string, dependencies: VideoDependencies = {}): Promise<VideoProject> {
  const project = await getIndependentVideoProject(id, dependencies); const render = project.renders.find(candidate => candidate.id === z.uuid().parse(renderId)); if (!render) throw new Error('Video render not found.');
  if (render.status !== 'running') return project;
  const saved = await mutateRender(id, renderId, render.owner, (current, attempt) => ({ ...current, status: current.revision === render.revision ? 'editing' : current.status, renders: current.renders.map(candidate => candidate.id === renderId ? { ...attempt, status: 'cancelled', phase: 'Cancelled; completed stages retained', finishedAt: now(), error: null } : candidate) }), dependencies);
  activeRenders.get(renderId)?.abort();
  const upstream = await readRendererRevision(id, renderId); if (upstream) await cancelRendererProject(id, upstream).catch(() => undefined);
  return saved;
}
