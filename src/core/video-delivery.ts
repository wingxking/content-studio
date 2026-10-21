import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Job, variantSchema } from './model.ts';
import { mutateState, readState } from './store.ts';
import { approveVideoDelivery, approveVideoTarget, getIndependentVideoProject, videoDeliveryApprovalHash, videoTargetDeliveryHash, videoTargets } from './video.ts';
import { hashMedia, expectedYouTubeChannelId, youtubeSettingsSchema } from './youtube.ts';
import { hasYouTubeUploadJournal } from './publication-journal.ts';
import { videoDeliverySettingsSchema } from '../contracts/video.ts';
import { videoFingerprint } from './video-tools.ts';
import { resolveMediaLocation } from './media-location.ts';
import { assertPublicationAction } from './publication-intent.ts';

export const videoPublicationInputSchema = z.object({ expectedRevision: z.number().int().positive(), renderId: z.uuid(), accountId: z.uuid(), title: variantSchema.shape.title, text: variantSchema.shape.text, tags: variantSchema.shape.tags, automatic: z.boolean().default(false) });
export const videoTargetPublicationInputSchema = z.object({ expectedRevision: z.number().int().positive(), expectedTargetRevision: z.number().int().positive(), automatic: z.boolean().default(false) }).strict();
const deliveryBindingSchema = z.object({ hashVersion: z.literal(2), targetId: z.uuid(), targetRevision: z.number().int().positive(), renderInputHash: z.string().regex(/^[a-f0-9]{64}$/u), deliverySettings: videoDeliverySettingsSchema });
export function approvedVideoUploadSettings(job: Job, supplied: unknown): z.infer<typeof youtubeSettingsSchema> {
  if (!job.snapshot?.video || !('hashVersion' in job.snapshot.video)) return youtubeSettingsSchema.parse(supplied);
  const binding = deliveryBindingSchema.parse(job.snapshot.video); const approved = youtubeSettingsSchema.parse(binding.deliverySettings.youtube);
  if (supplied !== undefined && videoFingerprint(youtubeSettingsSchema.parse(supplied)) !== videoFingerprint(approved)) throw new Error('YouTube visibility or disclosure settings changed after approval. Review the video target again.');
  return approved;
}
export async function verifyVideoDeliveryApproval(job: Job, options: { historical?: boolean } = {}): Promise<void> {
  const snapshot = job.snapshot;
  if (!snapshot?.video || job.subject?.kind !== 'video' || job.draftId !== null || job.subject.id !== snapshot.video.projectId) throw new Error('Video delivery subject is invalid.');
  const project = await getIndependentVideoProject(snapshot.video.projectId);
  const render = project.renders.find(candidate => candidate.id === snapshot.video?.renderId);
  const binding = deliveryBindingSchema.safeParse(snapshot.video);
  if (binding.success) {
    const value = binding.data; const revision = project.revisions.find(item => item.number === snapshot.video?.revision);
    const target = videoTargets(project).find(item => item.id === value.targetId);
    if (!render?.output || !revision || job.subject.revision !== revision.number || render.status !== 'succeeded' || render.revision !== revision.number || render.inputHash !== value.renderInputHash || render.output.hash !== snapshot.video.renderHash || snapshot.video.approvalHash !== job.approvedHash || snapshot.account.id !== job.accountId || snapshot.variant.platform !== job.platform || snapshot.account.platform !== job.platform || snapshot.variant.mediaPaths.length !== 1 || snapshot.variant.mediaPaths[0] !== render.output.videoPath) throw new Error('Video target delivery binding is invalid.');
    if (!options.historical && (project.revision !== revision.number || target?.revision !== value.targetRevision || target.approval?.approvalHash !== job.approvedHash)) throw new Error('Video target approval changed; review that target again.');
    if (videoTargetDeliveryHash({ projectId: project.id, revision, sources: snapshot.video.sources, targetId: value.targetId, targetRevision: value.targetRevision, render, account: snapshot.account, variant: snapshot.variant, deliverySettings: value.deliverySettings }) !== job.approvedHash) throw new Error('Video target content, settings or account approval changed.');
    if (await hashMedia(await resolveMediaLocation(render.output.videoPath)) !== snapshot.video.renderHash) throw new Error('Approved video bytes changed. Render and review again.');
    return;
  }
  if ('hashVersion' in snapshot.video) throw new Error('Video target delivery binding is incomplete.');
  const boundProject = options.historical ? { ...project, revision: snapshot.video.revision } : project;
  if (!render?.output || render.status !== 'succeeded' || render.revision !== snapshot.video.revision || render.output.hash !== snapshot.video.renderHash || snapshot.video.approvalHash !== job.approvedHash || (!options.historical && (project.revision !== snapshot.video.revision || project.deliveryApproval?.approvalHash !== job.approvedHash)) || videoDeliveryApprovalHash(boundProject, render, snapshot.account, snapshot.variant) !== job.approvedHash) throw new Error('Video revision, render or approval changed. Review and approve its current version.');
  if (await hashMedia(await resolveMediaLocation(render.output.videoPath)) !== snapshot.video.renderHash) throw new Error('Approved video bytes changed. Render and review again.');
}
export async function prepareVideoTargetPublication(id: string, targetId: string, value: unknown, options: { jobId?: string } = {}): Promise<Job> {
  const input = videoTargetPublicationInputSchema.parse(value); const project = await getIndependentVideoProject(id);
  const target = videoTargets(project).find(item => item.id === z.uuid().parse(targetId));
  const state = await readState(); const account = state.accounts.find(item => item.id === target?.accountId);
  if (!target || !account) throw new Error('Select an account for this video target before publishing.');
  if (input.automatic && (account.provider !== 'native' || account.platform !== 'youtube' || account.status !== 'connected' || account.integrationId !== expectedYouTubeChannelId || !target.deliverySettings.youtube)) throw new Error('Automatic video upload requires the authorized YouTube channel and explicit visibility settings. Bilibili currently uses manual handoff until a verified official adapter and App authorization are available.');
  const existing = state.jobs.find(item => item.subject?.kind === 'video' && item.subject.id === id && item.accountId === account.id && item.approvedHash === target.approval?.approvalHash && item.status !== 'cancelled');
  if (existing) { assertPublicationAction(existing, input.automatic, { journalExists: await hasYouTubeUploadJournal(existing) }); await verifyVideoDeliveryApproval(existing); return existing; }
  // An unrecognised journal cannot be bypassed by selecting a different target for the same account.
  for (const previous of state.jobs.filter(item => item.subject?.kind === 'video' && item.subject.id === id && item.accountId === account.id)) {
    if (previous.providerPostId || previous.remoteId || ['scheduled', 'awaiting_operator', 'submitting', 'queued', 'needs_reconciliation'].includes(previous.status) || await hasYouTubeUploadJournal(previous)) throw new Error('An earlier video delivery to this account is pending or has a remote or unknown outcome. Resolve it before creating another.');
  }
  const approved = await approveVideoTarget(id, targetId, { ...input, account }); const approval = videoTargets(approved).find(item => item.id === targetId)?.approval;
  if (!approval) throw new Error('Video target approval was not saved.');
  return mutateState(async current => {
    const fresh = await getIndependentVideoProject(id); const currentTarget = videoTargets(fresh).find(item => item.id === targetId);
    if (fresh.revision !== input.expectedRevision || currentTarget?.revision !== input.expectedTargetRevision || currentTarget.approval?.approvalHash !== approval.approvalHash) throw new Error('Video target changed while preparing publication.');
    const currentAccount = current.accounts.find(item => item.id === account.id);
    if (JSON.stringify(currentAccount) !== JSON.stringify(account)) throw new Error('Target account changed while approving. Review again.');
    const duplicate = current.jobs.find(item => item.subject?.kind === 'video' && item.subject.id === id && item.accountId === account.id && item.approvedHash === approval.approvalHash && item.status !== 'cancelled');
    if (duplicate) { assertPublicationAction(duplicate, input.automatic, { journalExists: await hasYouTubeUploadJournal(duplicate) }); return duplicate; }
    for (const previous of current.jobs.filter(item => item.subject?.kind === 'video' && item.subject.id === id && item.accountId === account.id)) if (previous.providerPostId || previous.remoteId || ['scheduled', 'awaiting_operator', 'submitting', 'queued', 'needs_reconciliation'].includes(previous.status) || await hasYouTubeUploadJournal(previous)) throw new Error('An earlier video delivery is pending or has a remote or unknown outcome. Resolve it before creating another.');
    const at = new Date().toISOString(); const status = input.automatic ? 'scheduled' : 'awaiting_operator';
    const job: Job = { id: options.jobId ? z.uuid().parse(options.jobId) : randomUUID(), draftId: null, subject: { kind: 'video', id, revision: approved.revision }, platform: target.platform, accountId: account.id, approvedHash: approval.approvalHash, contentHash: approval.approvalHash,
      snapshot: { video: { projectId: id, revision: approved.revision, renderId: approval.renderId, renderHash: approval.outputHash, approvalHash: approval.approvalHash, sources: approved.brief.sources, hashVersion: 2, targetId, targetRevision: target.revision, renderInputHash: approval.renderInputHash, deliverySettings: approval.deliverySettings }, account, variant: approval.variant },
      status, scheduledAt: at, createdAt: at, provider: account.provider, providerPostId: null, remoteId: null, remoteUrl: null, attempts: 0, error: null, submissionOwner: null, submissionStartedAt: null, metrics: [], history: [{ at, status, message: input.automatic ? 'Reviewed video target approved for official YouTube upload.' : 'Reviewed video target ready for native manual publication.' }] };
    current.jobs.push(job); return job;
  });
}
export async function prepareVideoPublication(id: string, value: unknown): Promise<Job> {
  const input = videoPublicationInputSchema.parse(value); const project = await getIndependentVideoProject(id);
  const account = (await readState()).accounts.find(candidate => candidate.id === input.accountId);
  const render = project.renders.find(candidate => candidate.id === input.renderId);
  if (!account || !render?.output || account.platform !== project.brief.platform) throw new Error('Select a target account and a completed matching render.');
  if (input.automatic && (account.provider !== 'native' || account.platform !== 'youtube' || account.status !== 'connected' || account.integrationId !== expectedYouTubeChannelId)) throw new Error('Automatic video delivery requires the connected official YouTube channel. Other channels use native handoff.');
  const variant = variantSchema.parse({ platform: project.brief.platform, title: input.title, text: input.text, tags: input.tags, mediaPaths: [render.output.videoPath] });
  const output = render.output;
  const approved = await approveVideoDelivery(id, { expectedRevision: input.expectedRevision, renderId: input.renderId, account, variant });
  const approval = approved.deliveryApproval; if (!approval) throw new Error('Video delivery approval was not saved.');
  return mutateState(async state => {
    const currentProject = await getIndependentVideoProject(id);
    if (currentProject.revision !== approved.revision || currentProject.deliveryApproval?.approvalHash !== approval.approvalHash) throw new Error('Video approval changed while preparing publication. Review again.');
    const currentAccount = state.accounts.find(candidate => candidate.id === account.id);
    if (JSON.stringify(currentAccount) !== JSON.stringify(account)) throw new Error('Target account changed while approving. Review again.');
    const previous = state.jobs.find(candidate => candidate.subject?.kind === 'video' && candidate.subject.id === id && candidate.accountId === account.id && candidate.approvedHash === approval.approvalHash && candidate.status !== 'cancelled');
    if (previous) { assertPublicationAction(previous, input.automatic, { journalExists: await hasYouTubeUploadJournal(previous) }); return previous; }
    for (const previousJob of state.jobs.filter(candidate => candidate.accountId === account.id && candidate.subject?.kind === 'video' && candidate.subject.id === id)) {
      if (previousJob.providerPostId || previousJob.remoteId || ['scheduled', 'awaiting_operator', 'submitting', 'queued', 'needs_reconciliation'].includes(previousJob.status) || await hasYouTubeUploadJournal(previousJob)) throw new Error('An earlier video delivery is pending or has a remote or unknown outcome. Resolve it before creating another.');
    }
    const at = new Date().toISOString(); const status = input.automatic ? 'scheduled' : 'awaiting_operator';
    const job: Job = { id: randomUUID(), draftId: null, subject: { kind: 'video', id, revision: project.revision }, platform: account.platform, accountId: account.id, approvedHash: approval.approvalHash, contentHash: approval.approvalHash, snapshot: { video: { projectId: id, revision: project.revision, renderId: render.id, renderHash: output.hash, approvalHash: approval.approvalHash, sources: project.brief.sources }, account, variant }, status, scheduledAt: at, createdAt: at, provider: account.provider, providerPostId: null, remoteId: null, remoteUrl: null, attempts: 0, error: null, submissionOwner: null, submissionStartedAt: null, metrics: [], history: [{ at, status, message: input.automatic ? 'Reviewed independent video approved for official API delivery.' : 'Reviewed independent video ready for native publication handoff.' }] };
    state.jobs.push(job); return job;
  });
}
