import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Job, variantSchema } from './model.ts';
import { mutateState, readState } from './store.ts';
import { approveVideoDelivery, getIndependentVideoProject, videoDeliveryApprovalHash } from './video.ts';
import { hashMedia, expectedYouTubeChannelId } from './youtube.ts';
import { hasYouTubeUploadJournal } from './publication-journal.ts';

export const videoPublicationInputSchema = z.object({ expectedRevision: z.number().int().positive(), renderId: z.uuid(), accountId: z.uuid(), title: variantSchema.shape.title, text: variantSchema.shape.text, tags: variantSchema.shape.tags, automatic: z.boolean().default(false) });
export async function verifyVideoDeliveryApproval(job: Job, options: { historical?: boolean } = {}): Promise<void> {
  const snapshot = job.snapshot;
  if (!snapshot?.video || job.subject?.kind !== 'video' || job.draftId !== null || job.subject.id !== snapshot.video.projectId) throw new Error('Video delivery subject is invalid.');
  const project = await getIndependentVideoProject(snapshot.video.projectId);
  const render = project.renders.find(candidate => candidate.id === snapshot.video?.renderId);
  const boundProject = options.historical ? { ...project, revision: snapshot.video.revision } : project;
  if (!render?.output || render.status !== 'succeeded' || render.revision !== snapshot.video.revision || render.output.hash !== snapshot.video.renderHash || snapshot.video.approvalHash !== job.approvedHash || (!options.historical && (project.revision !== snapshot.video.revision || project.deliveryApproval?.approvalHash !== job.approvedHash)) || videoDeliveryApprovalHash(boundProject, render, snapshot.account, snapshot.variant) !== job.approvedHash) throw new Error('Video revision, render or approval changed. Review and approve its current version.');
  if (await hashMedia(render.output.videoPath) !== snapshot.video.renderHash) throw new Error('Approved video bytes changed. Render and review again.');
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
    if (previous) return previous;
    for (const previousJob of state.jobs.filter(candidate => candidate.accountId === account.id && candidate.subject?.kind === 'video' && candidate.subject.id === id && candidate.status !== 'cancelled')) {
      if (previousJob.providerPostId || previousJob.remoteId || ['submitting', 'queued', 'needs_reconciliation'].includes(previousJob.status) || await hasYouTubeUploadJournal(previousJob)) throw new Error('An earlier video delivery has a remote or unknown outcome. Reconcile it before creating another.');
    }
    const at = new Date().toISOString(); const status = input.automatic ? 'scheduled' : 'awaiting_operator';
    const job: Job = { id: randomUUID(), draftId: null, subject: { kind: 'video', id, revision: project.revision }, platform: account.platform, accountId: account.id, approvedHash: approval.approvalHash, contentHash: approval.approvalHash, snapshot: { video: { projectId: id, revision: project.revision, renderId: render.id, renderHash: output.hash, approvalHash: approval.approvalHash, sources: project.brief.sources }, account, variant }, status, scheduledAt: at, createdAt: at, provider: account.provider, providerPostId: null, remoteId: null, remoteUrl: null, attempts: 0, error: null, submissionOwner: null, submissionStartedAt: null, metrics: [], history: [{ at, status, message: input.automatic ? 'Reviewed independent video approved for official API delivery.' : 'Reviewed independent video ready for native publication handoff.' }] };
    state.jobs.push(job); return job;
  });
}
