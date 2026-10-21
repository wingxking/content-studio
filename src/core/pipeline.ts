import { financeCommunityPreview } from './finance-platforms.ts';
import { financePlatformIds } from './model.ts';
import { AccountExecutionBusyError, withJobExecution } from './account-execution.ts';
import { validateLaunchVariant } from './publishing-capabilities.ts';
import { resolveAssetPath } from './assets.ts';
import type { ArticleNode } from './article-document.ts';
import { canonicalArticle, documentFromText } from './article-document.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { accountSchema, briefSchema, draftSchema, generatedSchema, metricsInputSchema, nativeUrls, type Account, type Brief, type Draft, type Generated, type Job, type Platform, type StudioState, type Variant } from './model.ts';
import { dataDirectory, mutateState, readState } from './store.ts';
import { createVerificationCheck } from './publication-checks.ts';
import { isManagedMediaPath, resolveMediaLocation } from './media-location.ts';
import { commitArticle, committedArticle } from './article-repository.ts';
import { hasYouTubeUploadJournal } from './publication-journal.ts';
import { assertAutomatedPublishingAllowed } from './publishing-policy.ts';
import { sameDraftAccount } from './draft-connectors.ts';
import { DeliveryInputError } from './delivery-errors.ts';
import { assertPublicationAction } from './publication-intent.ts';
import { canonicalPostizContent, listRemotePosts, RejectedPublishError, submitPostiz, validatePostizVariant, verifyIntegration, type Integration } from './postiz.ts';

const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
const videoPlatforms = new Set<Platform>(['tiktok', 'bilibili', 'youtube', 'kuaishou', 'douyin']);
const activeSubmissions = new Set<string>();
function requireArticleId(job: Job): string { if (!job.draftId || job.subject?.kind === 'video') throw new Error('This action requires an article publication.'); return job.draftId; }
const now = (): string => new Date().toISOString();
const digest = (input: unknown): string => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function findDraft(state: StudioState, id: string): Draft {
  const draft = state.drafts.find(item => item.id === id);
  if (!draft) throw new Error('Draft not found.');
  return draft;
}
function findAccount(state: StudioState, id: string): Account {
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new Error('Account not found.');
  return account;
}
function findJob(state: StudioState, id: string): Job {
  const job = state.jobs.find(item => item.id === id);
  if (!job) throw new Error('Job not found.');
  return job;
}
function variantFor(draft: Draft, platform: Platform): Variant {
  const variant = draft.variants.find(item => item.platform === platform);
  if (!variant) throw new Error('This draft has no variant for the selected platform.');
  return variant;
}
function transition(job: Job, status: Job['status'], message: string): void {
  if (job.verificationCheck && ['published', 'failed', 'cancelled', 'needs_reconciliation', 'draft_saved'].includes(status)) { job.verificationCheck.nextAt = null; job.verificationCheck.stoppedReason = status === 'needs_reconciliation' ? 'uncertain' : 'terminal'; }
  job.status = status;
  job.error = ['failed', 'needs_reconciliation'].includes(status) ? message : null;
  job.history.push({ at: now(), status, message });
  if (status !== 'submitting') job.submissionOwner = null;
}
function validGenerated(brief: Brief, input: Generated): Generated {
  const generated = generatedSchema.parse(input);
  if (new Set(brief.platforms).size !== brief.platforms.length) throw new Error('Requested platforms must be unique.');
  const platforms = generated.variants.map(item => item.platform);
  if (new Set(platforms).size !== platforms.length || platforms.length !== brief.platforms.length || brief.platforms.some(platform => !platforms.includes(platform))) throw new Error('Generated variants must match every requested platform exactly once.');
  return generated;
}
function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
async function mediaInfo(path: string): Promise<{ hash: string; video: boolean }> {
  const absolute = await realpath(await resolveMediaLocation(path)).catch(() => { throw new Error(`Media file does not exist: ${path}`); });
  const roots = await Promise.all([realpath(process.cwd()), realpath(dataDirectory()).catch(() => resolve(dataDirectory()))]);
  if (!roots.some(root => inside(absolute, root)) && !await isManagedMediaPath(absolute)) throw new Error('Media must be an original local file inside the project or STUDIO_DATA_DIR.');
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0) throw new Error('Media must be a non-empty regular file.');
  const handle = await open(absolute, 'r');
  const header = Buffer.alloc(32);
  try { await handle.read(header, 0, header.length, 0); }
  finally { await handle.close(); }
  const video = info.size > 32 && (header.toString('ascii', 4, 8) === 'ftyp' || header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) || (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'AVI '));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
  return { hash: hash.digest('hex'), video };
}
export async function draftHash(draft: Draft): Promise<string> {
  const media = await Promise.all(draft.variants.flatMap(variant => variant.mediaPaths.map(async path => ({ path, hash: (await mediaInfo(path)).hash }))));
  const documentAssets: { assetId: string; hash: string }[] = [];
  const visit = async (node: ArticleNode): Promise<void> => {
    if (node.type === 'image') { const assetId = z.uuid().parse(node.attrs?.assetId); documentAssets.push({ assetId, hash: (await mediaInfo(await resolveAssetPath(assetId))).hash }); }
    for (const child of node.content ?? []) await visit(child);
  };
  if (draft.document) await visit(draft.document.content);
  return digest({ revision: draft.revision, title: draft.title, body: draft.body, ...(draft.document ? { document: draft.document, documentAssets } : {}), brief: draft.brief, variants: draft.variants, media });
}
function targetHash(draft: Draft, variant: Variant, account: Account): string {
  return digest({ draftApproval: draft.approvedHash, variant, accountId: account.id, platform: account.platform, provider: account.provider, integrationId: account.integrationId, label: account.label, ...(account.reddit ? { reddit: account.reddit } : {}) });
}
async function contentKey(variant: Variant, account: Account): Promise<string> {
  const mediaHashes = await Promise.all(variant.mediaPaths.map(async path => (await mediaInfo(path)).hash));
  const content = account.provider === 'postiz' ? canonicalPostizContent(variant) : { title: variant.title, text: variant.text, tags: variant.tags };
  return digest({ content, mediaHashes, accountId: account.id, platform: account.platform, provider: account.provider, integrationId: account.integrationId, ...(variant.format ? { format: variant.format } : {}), ...(account.platform === 'reddit' ? { title: variant.title, reddit: account.reddit } : {}), ...(variant.launch ? { launch: variant.launch } : {}), ...(variant.finance ? { finance: variant.finance } : {}) });
}
async function validateMedia(variant: Variant): Promise<void> {
  validateLaunchVariant(variant);
  if ((financePlatformIds as readonly string[]).includes(variant.platform)) financeCommunityPreview(variant);
  const files = await Promise.all(variant.mediaPaths.map(mediaInfo));
  if (videoPlatforms.has(variant.platform) && !(variant.platform === 'bilibili' && variant.format === 'article') && !files.some(file => file.video)) throw new Error('This channel requires a real video file. A generated script is not a publishable video; attach an actual video first.');
}
export async function verifyDraftApproval(draft: Draft): Promise<void> {
  if (draft.generationEvidenceRunId) { const { assertDraftQuality } = await import('./quality.ts'); const { taskWorkspaceId } = await import('./tasks.ts'); await assertDraftQuality(await taskWorkspaceId(), draft); }
  if (!draft.approvedHash || draft.approvedHash !== await draftHash(draft)) throw new Error('Draft content or media changed after approval. Review and approve it again.');
}
async function verifyApproval(draft: Draft, variant: Variant, account: Account, job?: Job): Promise<void> {
  if (job?.automation) await (await import('./task-automation.ts')).verifyJobAutomation(job, account);
  assertAutomatedPublishingAllowed(draft, account);
  await verifyDraftApproval(draft);
  if (job && job.approvedHash !== targetHash(draft, variant, account)) throw new Error('Approved content revision or account target changed. Cancel this job and schedule the reviewed revision.');
}

export async function createDraft(briefInput: Brief, generatedInput: Generated, stableId?: string, generationModel?: string, generationContext?: { instruction: string; assetIds: string[]; knowledgeRef?: string; evidenceRunId?: string; leaseToken?: string; refreshTarget?: { draftId: string; expectedRevision: number } }): Promise<Draft> {
  const brief = briefSchema.parse(briefInput);
  if (brief.knowledgeIds?.length && !generationContext?.knowledgeRef) throw new Error('Knowledge-backed drafts require their original immutable generation snapshot.');
  const refresh = generationContext?.refreshTarget;
  if (refresh && (!generationContext.evidenceRunId || !generationContext.leaseToken || stableId !== refresh.draftId || !Number.isInteger(refresh.expectedRevision) || refresh.expectedRevision < 1)) throw new Error('Evidence refresh requires its original draft revision and active production lease.');
  if (brief.evidenceDocumentIds?.length && (!generationContext?.evidenceRunId || !generationContext.leaseToken || stableId !== (refresh?.draftId ?? generationContext.evidenceRunId))) throw new Error('Evidence-backed drafts require the original production run and its active lease.');
  const generated = canonicalArticle(validGenerated(brief, generatedInput));
  const draft: Draft = { ...generated, id: stableId ? z.uuid().parse(stableId) : randomUUID(), brief, createdAt: now(), revision: 1, approvedHash: null, ...(generationModel !== undefined ? { generationModel: draftSchema.shape.generationModel.parse(generationModel) } : {}), ...(generationContext ? { ...(generationContext.evidenceRunId ? { generationEvidenceRunId: z.uuid().parse(generationContext.evidenceRunId) } : {}), generationInstruction: draftSchema.shape.generationInstruction.parse(generationContext.instruction), generationAssetIds: draftSchema.shape.generationAssetIds.parse(generationContext.assetIds), ...(generationContext.knowledgeRef ? { generationKnowledgeRef: z.uuid().parse(generationContext.knowledgeRef) } : {}) } : {}) };
  if (refresh) {
    const previous = (await readState()).drafts.find(item => item.id === refresh.draftId);
    if (!previous || previous.revision !== refresh.expectedRevision && !(previous.revision === refresh.expectedRevision + 1 && previous.generationEvidenceRunId === generationContext?.evidenceRunId)) throw new Error('Draft revision changed during evidence refresh; preserve the owner edit.');
    draft.createdAt = previous.createdAt; draft.revision = refresh.expectedRevision + 1;
  }
  return commitArticle(draft, { expectedRevision: refresh?.expectedRevision ?? 0, ...(stableId ? { commandId: generationContext?.evidenceRunId ?? stableId } : {}), ...(generationContext?.evidenceRunId && generationContext.leaseToken ? { productionLease: { runId: generationContext.evidenceRunId, token: generationContext.leaseToken } } : {}) });
}
export async function replaceDraft(id: string, generatedInput: Generated, expectedRevision?: number, operationId?: string, appliedProposalId?: string, commandId?: string, generationModel?: string): Promise<Draft> {
  // The reviewed proposal is immutable, including whether older output contained a document.
  const proposalContent = appliedProposalId ? generatedSchema.parse(generatedInput) : undefined;
  generatedInput = canonicalArticle(generatedInput);
  if (expectedRevision !== undefined) { const committed = await committedArticle(commandId, id, expectedRevision, generatedInput); if (committed) return committed; }
  const previous = (await readState()).drafts.find(item => item.id === id);
  if (!previous) throw new Error('Draft not found.');
  if (operationId && previous.lastOperationId === operationId || appliedProposalId && previous.lastAppliedProposalId === appliedProposalId) return previous;
  if (expectedRevision !== undefined && previous.revision !== expectedRevision) throw new Error('Draft revision changed while this operation was running. Refresh the draft and retry.');
  const masterChanged = previous.title !== generatedInput.title || previous.body !== generatedInput.body || (generatedInput.document !== undefined && JSON.stringify(previous.document) !== JSON.stringify(generatedInput.document));
  generatedInput.document ??= previous.body === generatedInput.body ? previous.document : documentFromText(generatedInput.body);
  const draft = draftSchema.parse({ ...previous, ...validGenerated(previous.brief, generatedInput), ...(generationModel ? { generationModel } : {}), adaptationStatus: operationId ? 'current' : masterChanged ? 'pending' : previous.adaptationStatus, revision: previous.revision + 1, approvedHash: null, lastOperationId: operationId, ...(appliedProposalId ? { lastAppliedProposalId: appliedProposalId } : {}) });
  return commitArticle(draft, { expectedRevision: previous.revision, commandId: commandId ?? operationId ?? appliedProposalId, proposalId: appliedProposalId, ...(proposalContent ? { proposalContent } : {}) });
}
export async function approveDraft(id: string, expectedRevision?: number): Promise<Draft> {
  return mutateState(async state => { const draft = findDraft(state, id); if (expectedRevision !== undefined && expectedRevision !== draft.revision) throw new Error('Draft revision changed before approval.');
    if (draft.generationEvidenceRunId) { const { assertDraftQuality } = await import('./quality.ts'); const { taskWorkspaceId } = await import('./tasks.ts'); await assertDraftQuality(await taskWorkspaceId(), draft); }
    draft.approvedHash = await draftHash(draft); return draft; });
}
export async function addAccount(input: Omit<Account, 'id'>): Promise<Account> {
  const account = accountSchema.parse({ ...input, id: randomUUID() });
  delete account.draftConnection;
  delete account.physicalIdentity;
  if (account.provider === 'postiz' && account.status === 'connected') { await verifyIntegration(account); account.verifiedAt = now(); }
  return mutateState(state => {
    if (state.accounts.some(existing => existing.provider === account.provider && existing.platform === account.platform && (account.provider === 'postiz' ? existing.integrationId === account.integrationId : existing.label === account.label))) throw new Error('This account already exists.');
    state.accounts.push(account); return account;
  });
}
function sameTarget(left: Account, right: Account): boolean {
  return left.platform === right.platform && left.provider === right.provider && left.integrationId === right.integrationId && left.label === right.label && JSON.stringify(left.reddit) === JSON.stringify(right.reddit);
}
export async function checkAccountConnection(id: string): Promise<Account> {
  const account = findAccount(await readState(), id);
  if (account.provider !== 'postiz') throw new Error('Use the existing YouTube authorization check or verify native login in Chrome.');
  await verifyIntegration(account);
  return mutateState(state => {
    const current = findAccount(state, id);
    if (!sameTarget(current, account)) throw new Error('Account target changed during connection verification. Refresh and check again.');
    current.verifiedAt = now();
    return current;
  });
}
export async function updateAccount(id: string, input: Omit<Account, 'id'>): Promise<Account> {
  const account = accountSchema.parse({ ...input, id });
  if (account.provider === 'postiz' && account.status === 'connected') { await verifyIntegration(account); account.verifiedAt = now(); }
  return mutateState(state => {
    const existing = findAccount(state, id);
    if (!sameTarget(existing, account) && state.jobs.some(job => job.accountId === id && ['submitting', 'needs_reconciliation'].includes(job.status))) throw new Error('Account target cannot change during an active or uncertain provider submission.');
    if (state.accounts.some(other => other.id !== id && other.provider === account.provider && other.platform === account.platform && (account.provider === 'postiz' ? other.integrationId === account.integrationId : other.label === account.label))) throw new Error('This account target already exists.');
    delete account.draftConnection;
  delete account.physicalIdentity;
    if (existing.platform !== account.platform || existing.provider !== account.provider || existing.integrationId !== account.integrationId) delete existing.draftConnection;
    if (existing.platform !== account.platform || existing.provider !== account.provider || existing.integrationId !== account.integrationId) delete existing.physicalIdentity;
    Object.assign(existing, account); return existing;
  });
}
export async function scheduleJob(input: { draftId: string; accountId: string; scheduledAt: string }): Promise<Job> {
  const time = z.iso.datetime().parse(input.scheduledAt);
  return mutateState(async state => {
    const draft = findDraft(state, input.draftId);
    const account = findAccount(state, input.accountId);
    const variant = variantFor(draft, account.platform);
    if (account.status !== 'connected') throw new Error('Connect or verify this account before scheduling.');
    await verifyApproval(draft, variant, account);
    await validateMedia(variant);
    if (account.provider === 'postiz') validatePostizVariant(account, variant);
    const key = await contentKey(variant, account);
    if (state.jobs.some(existing => existing.accountId === account.id && !['cancelled', 'failed'].includes(existing.status) && existing.contentHash === key)) throw new Error('The same content is already scheduled, queued, awaiting confirmation, or published for this account.');
    const job: Job = { id: randomUUID(), draftId: draft.id, platform: account.platform, accountId: account.id, approvedHash: targetHash(draft, variant, account), contentHash: key, snapshot: structuredClone({ draft, account, variant }), status: 'scheduled', scheduledAt: time, createdAt: now(), provider: account.provider, providerPostId: null, remoteId: null, remoteUrl: null, attempts: 0, submissionOwner: null, submissionStartedAt: null, metrics: [], error: null, history: [{ at: now(), status: 'scheduled', message: 'Approved content scheduled for this account.' }] };
    state.jobs.push(job); return job;
  });
}

function orphaned(job: Job): boolean {
  if (job.status === 'submitting' && job.submissionLeaseUntil) return Date.parse(job.submissionLeaseUntil) <= Date.now();
  if (job.status !== 'submitting') return false;
  if (job.submissionOwner === owner) return !activeSubmissions.has(job.id);
  if (!job.submissionOwner || !job.submissionStartedAt) return true;
  const parts = job.submissionOwner.split(':');
  if (parts[0] === hostname()) {
    try { process.kill(Number(parts[1]), 0); if (job.platform === 'youtube' && job.provider === 'native') return false; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; }
  }
  return Date.now() - Date.parse(job.submissionStartedAt) > 120000;
}
let dispatchPromise: Promise<Job[]> | null = null;
export async function runDueJobs(): Promise<Job[]> {
  if (dispatchPromise) return dispatchPromise;
  dispatchPromise = dispatchDue();
  try { return await dispatchPromise; }
  finally { dispatchPromise = null; }
}
async function dispatchDue(): Promise<Job[]> {
  const recovered = await mutateState(state => {
    const jobs = state.jobs.filter(orphaned);
    for (const job of jobs) transition(job, 'needs_reconciliation', 'Worker stopped during submission. Check the provider before any resubmission.');
    return jobs;
  });
  const ids = (await readState()).jobs.filter(job => job.deliveryAction !== 'save_draft' && job.status === 'scheduled' && Date.parse(job.scheduledAt) <= Date.now()).map(job => job.id);
  const results: Job[] = [...recovered];
  for (const id of ids) {
    activeSubmissions.add(id);
    try { await withJobExecution(id, 'write', async () => {
    try {
      const claimed = await mutateState(async state => {
        const job = findJob(state, id);
        if (state.paused || job.status !== 'scheduled' || job.subject?.kind === 'video' || job.deliveryAction === 'save_draft') return null;
        const targetAccount = findAccount(state, job.accountId);
        if (state.jobs.some(other => other.id !== id && sameDraftAccount(other, targetAccount) && ['submitting', 'needs_reconciliation'].includes(other.status))) return null;
        const draft = findDraft(state, requireArticleId(job)); const account = findAccount(state, job.accountId); const variant = variantFor(draft, job.platform);
        try {
          if (account.status !== 'connected') throw new Error('Target account is no longer connected.');
          await verifyApproval(draft, variant, account, job); await validateMedia(variant);
          if (job.provider === 'postiz') validatePostizVariant(account, variant);
        } catch (error) { transition(job, 'failed', error instanceof Error ? error.message : 'Publish preflight failed.'); return { job, account, variant, failed: true }; }
        if (job.provider === 'native') { transition(job, 'awaiting_operator', 'Ready for the verified Chrome profile. Publish through the creator page and record the platform receipt.'); return { job, account, variant, failed: true }; }
        transition(job, 'submitting', 'Submission started; do not create another job until its outcome is known.');
        job.attempts++; job.submissionOwner = owner; job.submissionStartedAt = now();
        return { job, account, variant, failed: false };
      });
      if (!claimed) return;
      if (claimed.failed) { results.push(claimed.job); return; }
      let integration: Integration;
      // This read-only preflight cannot create a remote post.
      try { integration = await verifyIntegration(claimed.account); }
      catch (error) {
        results.push(await mutateState(state => { const job = findJob(state, id); transition(job, 'failed', error instanceof Error ? error.message : 'Postiz connection verification failed.'); return job; }));
        return;
      }
      const final = await mutateState(async state => {
        const job = findJob(state, id);
        if (state.paused) { transition(job, 'scheduled', 'Publishing paused before provider submission.'); return null; }
        if (job.status !== 'submitting' || job.submissionOwner !== owner) return null;
        const draft = findDraft(state, requireArticleId(job)); const account = findAccount(state, job.accountId); const variant = variantFor(draft, job.platform);
        try {
          if (account.status !== 'connected') throw new Error('Target account is no longer connected.');
          await verifyApproval(draft, variant, account, job); await validateMedia(variant); validatePostizVariant(account, variant);
          if (account.integrationId !== integration.id) throw new Error('Account target changed after connection verification.');
        } catch (error) { transition(job, 'failed', error instanceof Error ? error.message : 'Final approval check failed.'); return null; }
        job.submissionStartedAt = now();
        return { job, account, variant };
      });
      if (!final) { results.push(findJob(await readState(), id)); return; }
      let remoteId: string;
      try { remoteId = await submitPostiz(final.job, final.account, final.variant, integration); }
      catch (error) {
        results.push(await mutateState(state => { const job = findJob(state, id); transition(job, error instanceof RejectedPublishError ? 'failed' : 'needs_reconciliation', error instanceof Error ? error.message : 'Provider outcome unknown.'); return job; }));
        return;
      }
      // A persistence failure after POST leaves submitting in the durable state, so restart requires reconciliation.
      results.push(await mutateState(state => { const job = findJob(state, id); job.providerPostId = remoteId; job.verificationCheck = createVerificationCheck(); transition(job, 'queued', 'Postiz accepted this job. Read-only verification will check its platform publication URL while publishing is enabled.'); return job; }));
    } finally { activeSubmissions.delete(id); }
    }); } catch (error) {
      // Another job owns this account, or its accepted submission awaits readback.
      // Keep its durable barrier and this job scheduled; other accounts may proceed.
      if (!(error instanceof AccountExecutionBusyError)) throw error;
    } finally { activeSubmissions.delete(id); }
  }
  return results;
}
export async function pausePublishing(paused: boolean): Promise<void> { await mutateState(state => { state.paused = paused; }); }

const receiptHosts: Record<Platform, readonly string[]> = { xiaohongshu: ['xiaohongshu.com', 'xhslink.com'], reddit: ['reddit.com'], x: ['x.com', 'twitter.com'], wechat: ['mp.weixin.qq.com'], tiktok: ['tiktok.com'], bilibili: ['bilibili.com', 'b23.tv'], youtube: ['youtube.com', 'youtu.be'], kuaishou: ['kuaishou.com'], douyin: ['douyin.com'], instagram: ['instagram.com'], linkedin: ['linkedin.com'], facebook: ['facebook.com', 'fb.watch'], producthunt: ['producthunt.com'], zhihu: ['zhihu.com'], xueqiu: ['xueqiu.com'], gelonghui: ['gelonghui.com'], guba: ['guba.eastmoney.com'] };
function receiptUrl(platform: Platform, remoteUrl: string): URL {
  const url = new URL(remoteUrl);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || !receiptHosts[platform].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Publication URL must use HTTPS on the selected platform domain.');
  return url;
}
export function extractPlatformId(platform: Platform, remoteUrl: string): string {
  const url = receiptUrl(platform, remoteUrl);
  const path = decodeURIComponent(url.pathname);
  let id: string | undefined;
  switch (platform) {
    case 'producthunt': {
      id = /^\/posts\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(path)?.[1];
      if (!id && /^\/products\/[a-z0-9][a-z0-9-]*\/?$/i.test(path) && url.searchParams.getAll('launch').length === 1) {
        const launch = url.searchParams.get('launch');
        if (launch && /^[a-z0-9][a-z0-9-]*$/i.test(launch)) id = launch;
      }
      if (id && ['new', 'edit', 'draft'].includes(id.toLowerCase())) id = undefined;
      break;
    }
    case 'xueqiu': id = /^\/\d+\/(\d+)\/?$/.exec(path)?.[1]; break;
    case 'gelonghui': id = /^\/p\/(\d+)\/?$/.exec(path)?.[1]; break;
    case 'guba': id = /^\/news,[a-zA-Z0-9]+,(\d+)\.html$/.exec(path)?.[1]; break;
    case 'zhihu': id = url.hostname === 'zhuanlan.zhihu.com' ? /^\/p\/(\d+)\/?$/.exec(path)?.[1] : /^\/question\/\d+\/answer\/(\d+)\/?$/.exec(path)?.[1]; break;
    case 'x': id = /^\/[^/]+\/status\/(\d+)(?:\/|$)/.exec(path)?.[1]; break;
    case 'reddit': id = /^\/(?:r\/[^/]+\/|user\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i.exec(path)?.[1]; break;
    case 'youtube':
      if (url.hostname === 'youtu.be') id = /^\/([\w-]{11})(?:\/|$)/.exec(path)?.[1];
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) id = path === '/watch' ? url.searchParams.get('v') ?? undefined : /^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/.exec(path)?.[1];
      if (id && !/^[\w-]{11}$/.test(id)) id = undefined;
      break;
    case 'tiktok': id = /^\/@[^/]+\/video\/(\d+)(?:\/|$)/.exec(path)?.[1]; break;
    case 'xiaohongshu': id = /^\/(?:explore|discovery\/item)\/([a-z0-9]+)(?:\/|$)/i.exec(path)?.[1]; break;
    case 'linkedin': id = /^\/feed\/update\/urn:li:activity:(\d+)(?:\/|$)/.exec(path)?.[1] ?? (/^\/posts\//.test(path) ? /(?:_|-)activity-(\d+)(?:-|\/|$)/.exec(path)?.[1] : undefined); break;
    case 'wechat': id = /^\/s\/([\w-]+)(?:\/|$)/.exec(path)?.[1] ?? (path === '/s' ? url.searchParams.get('mid') ?? undefined : undefined); break;
    case 'bilibili': id = /^\/video\/((?:BV[\w]+|av\d+))(?:\/|$)/i.exec(path)?.[1] ?? /^\/read\/(cv\d+)(?:\/|$)/i.exec(path)?.[1]; break;
    case 'kuaishou': id = /^\/short-video\/([\w-]+)(?:\/|$)/.exec(path)?.[1]; break;
    case 'douyin': id = /^\/(?:video|note)\/(\d+)(?:\/|$)/.exec(path)?.[1]; break;
    case 'instagram': id = /^\/(?:p|reel|tv)\/([\w-]+)(?:\/|$)/.exec(path)?.[1]; break;
    case 'facebook':
      if (url.hostname === 'fb.watch' || url.hostname === 'www.fb.watch') id = /^\/([\w-]+)\/?$/.exec(path)?.[1];
      else if (path === '/watch' || path === '/watch/') id = url.searchParams.get('v') ?? undefined;
      else if (path === '/permalink.php') id = url.searchParams.get('story_fbid') ?? undefined;
      else if (path === '/photo.php') id = url.searchParams.get('fbid') ?? undefined;
      else id = /^\/(?:[^/]+\/)?(?:posts|videos|reel)\/([\w-]+)(?:\/|$)/.exec(path)?.[1];
      break;
  }
  if (!id || /[\s/]/.test(id)) throw new Error('Unsupported publication URL structure. Open the actual published post and copy its canonical permalink and post/video identifier.');
  return id;
}
export function validateReceipt(platform: Platform, remoteUrl: string, remoteId: string): string {
  const url = receiptUrl(platform, remoteUrl);
  if (!remoteId.trim() || remoteId.length > 500 || /[\r\n]/.test(remoteId)) throw new Error('A real platform post or video identifier is required.');
  if (extractPlatformId(platform, remoteUrl) !== remoteId.trim()) throw new Error('The supplied platform post/video identifier does not match the published permalink.');
  return url.href;
}
async function confirmPublicationOwned(jobId: string, remoteUrl: string, remoteId: string): Promise<Job> {
  return mutateState(state => {
    const job = findJob(state, jobId);
    if (job.deliveryAction === 'save_draft') throw new Error('Use a draft receipt for this task. Public publication requires a separate reviewed action.');
    if (!['awaiting_operator', 'needs_reconciliation', 'queued', 'failed', 'delivered'].includes(job.status)) throw new Error('Only a submitted or native handoff job can receive a publication receipt.');
    job.remoteUrl = validateReceipt(job.platform, remoteUrl, remoteId); job.remoteId = remoteId.trim();
    transition(job, 'published', 'Operator supplied the platform post identifier and URL.'); return job;
  });
}
export async function cancelJob(id: string): Promise<Job> {
  return mutateState(async state => {
    const job = findJob(state, id);
    if (!['scheduled', 'awaiting_operator', 'failed'].includes(job.status)) throw new Error('This job may already exist at the provider. Reconcile or cancel it at the provider before any new submission.');
    if (job.providerPostId || job.remoteId || job.remoteUrl) throw new Error('This task has a remote identity. Reconcile or cancel it at the provider; local cancellation cannot withdraw it.');
    if (await hasYouTubeUploadJournal(job)) throw new Error('A durable YouTube upload journal exists. Reconcile that upload before cancelling or creating another publication.');
    transition(job, 'cancelled', 'Local job cancelled before confirmed publication.'); return job;
  });
}
async function reconcileJobOwned(id: string, signal?: AbortSignal): Promise<Job> {
  const state = await readState(); const job = findJob(state, id); const draft = job.snapshot?.draft ?? findDraft(state, requireArticleId(job)); const account = job.snapshot?.account ?? findAccount(state, job.accountId); const variant = job.snapshot?.variant ?? variantFor(draft, job.platform);
  if (job.deliveryAction === 'save_draft') throw new Error('Inspect the remote draft box and record a draft receipt. This task cannot be reconciled as a public post.');
  if (job.provider !== 'postiz' || !(['queued', 'needs_reconciliation'].includes(job.status) || (job.status === 'failed' && job.providerPostId))) throw new Error('This job needs a native publication receipt or is not ready for Postiz reconciliation.');
  if (!job.providerPostId && job.approvedHash !== targetHash(draft, variant, account)) throw new Error('Content or target changed after the unknown submission. Inspect the provider and record its exact publication receipt.');
  const posts = await listRemotePosts(job, signal);
  const matches = posts.filter(post => post.integration.id === account.integrationId && (job.providerPostId ? post.id === job.providerPostId : post.content === canonicalPostizContent(variant) && Math.abs(Date.parse(post.publishDate) - Date.parse(job.submissionStartedAt ?? job.scheduledAt)) <= 60000));
  return mutateState(current => {
    const currentJob = findJob(current, id);
    if (!['queued', 'needs_reconciliation', 'failed'].includes(currentJob.status)) return currentJob;
    if (matches.length !== 1 || !matches[0]) { transition(currentJob, 'needs_reconciliation', matches.length ? 'Multiple remote matches; inspect Postiz and record the correct receipt.' : 'No remote match found. Absence from this query does not prove non-publication; inspect the provider before resubmitting.'); return currentJob; }
    const post = matches[0]; currentJob.providerPostId = post.id;
    if (post.releaseURL && post.state === 'PUBLISHED') {
      try { const platformId = extractPlatformId(job.platform, post.releaseURL); currentJob.remoteUrl = validateReceipt(job.platform, post.releaseURL, platformId); currentJob.remoteId = platformId; transition(currentJob, 'published', 'Provider reported PUBLISHED with a matching platform URL and extracted platform identifier.'); }
      catch { transition(currentJob, 'needs_reconciliation', 'Provider publication URL did not match the selected platform. Inspect the remote receipt.'); }
    } else if (post.state === 'ERROR') transition(currentJob, 'failed', 'Provider reported a publish error. Inspect Postiz for details before correcting and rescheduling.');
    else if (post.state === 'QUEUE') transition(currentJob, 'queued', 'Provider still has this job queued; no platform publication receipt yet.');
    else transition(currentJob, 'needs_reconciliation', 'Provider status requires inspection; no confirmed platform publication receipt.');
    return currentJob;
  });
}
export async function exportJob(id: string): Promise<{ job: Job; account: Account; draft?: Draft; variant: Variant; nativeUrl: string }> {
  const state = await readState(); const job = findJob(state, id);
  if (job.snapshot?.video) {
    const { verifyVideoDeliveryApproval } = await import('./video-delivery.ts'); await verifyVideoDeliveryApproval(job, { historical: true });
    await validateMedia(job.snapshot.variant);
    return { job, account: job.snapshot.account, variant: job.snapshot.variant, nativeUrl: nativeUrls[job.platform] };
  }
  const draft = job.snapshot?.draft ?? findDraft(state, requireArticleId(job)); const account = job.snapshot?.account ?? findAccount(state, job.accountId); const variant = job.snapshot?.variant ?? variantFor(draft, job.platform);
  await verifyApproval(draft, variant, account, job); await validateMedia(variant);
  return { job, account, draft, variant, nativeUrl: nativeUrls[job.platform] };
}
export async function recordMetrics(jobId: string, input: z.infer<typeof metricsInputSchema>): Promise<Job> {
  const metrics = metricsInputSchema.parse(input);
  return mutateState(state => { const job = findJob(state, jobId); if (!['published', 'delivered'].includes(job.status)) throw new Error('Record performance only after a confirmed publication or processed upload.'); job.metrics.push({ ...metrics, at: now() }); return job; });
}

export async function assertExistingPublicationAction(jobs: Job[], variant: Variant, account: Account, automatic: boolean): Promise<void> {
  const candidates = jobs.filter(job => job.accountId === account.id && job.deliveryAction !== 'save_draft' && job.status !== 'cancelled');
  if (!candidates.length) return;
  const key = await contentKey(variant, account);
  const previous = candidates.find(job => job.contentHash === key);
  if (previous) assertPublicationAction(previous, automatic, { journalExists: await hasYouTubeUploadJournal(previous) });
}
export async function preparePublication(input: { draftId: string; accountId: string; expectedRevision: number; automatic: boolean; scheduledAt?: string; automation?: Job['automation']; jobId?: string }): Promise<Job> {
  const requestedSchedule = input.scheduledAt ? z.iso.datetime().parse(input.scheduledAt) : undefined;
  const prepared = await mutateState(async state => {
    const draft = findDraft(state, input.draftId); const account = findAccount(state, input.accountId); const variant = variantFor(draft, account.platform);
    if (draft.revision !== input.expectedRevision) throw new Error('The draft changed. Review the current revision before publishing.');
    await verifyDraftApproval(draft);
    const key = await contentKey(variant, account);
    if (input.jobId && state.jobs.some(job => job.id === input.jobId && (job.accountId !== account.id || job.contentHash !== key || job.status === 'cancelled'))) throw new Error('Delivery command changed.');
    let previous = state.jobs.find(job => job.accountId === account.id && job.contentHash === key && job.status !== 'cancelled');
    if (!previous) {
      for (const candidate of state.jobs.filter(job => job.accountId === account.id && job.contentHash === key && job.status === 'cancelled')) {
        if (!await hasYouTubeUploadJournal(candidate)) continue;
        transition(candidate, 'needs_reconciliation', 'A durable upload journal survives this legacy cancellation. Verify the existing upload before creating another publication.');
        previous = candidate; break;
      }
    }
    if (previous) {
      if (requestedSchedule && Date.parse(previous.scheduledAt) !== Date.parse(requestedSchedule)) throw new DeliveryInputError('相同内容已有其他发布时间的交付，请先处理原任务，不能通过重新提交覆盖排期。');
      if (!requestedSchedule && !previous.automation && Date.parse(previous.scheduledAt) > Date.now()) throw new DeliveryInputError('相同内容已有未来排期，请打开原交付核对，不能通过立即发布覆盖排期。');
      const safeUnsent = ['scheduled', 'failed'].includes(previous.status) && !previous.providerPostId && !previous.remoteId && !previous.remoteUrl;
      const journalExists = await hasYouTubeUploadJournal(previous);
      // Persist recovery of a cancelled journal before reporting the uncertain outcome.
      if (['submitting', 'needs_reconciliation'].includes(previous.status)) return previous;
      assertPublicationAction(previous, input.automatic, { automation: input.automation, journalExists });
      // Explicit publication of a reviewed revision may take over an unsent
      // rule-owned job. Uncertain/accepted submissions retain their original authority.
      if (previous.automation && !input.automation && safeUnsent && !journalExists) {
        const authority = previous.automation;
        delete previous.automation;
        previous.scheduledAt = requestedSchedule ?? now();
        transition(previous, input.automatic ? 'scheduled' : 'awaiting_operator', `Operator reviewed revision ${draft.revision} and replaced task authorization ${JSON.stringify(authority)} before submission.`);
        return previous;
      }
      if (previous.approvedHash === targetHash(draft, variant, account) || !safeUnsent || journalExists) return previous;
      transition(previous, 'cancelled', 'Superseded by a newly reviewed revision before confirmed remote acceptance. The old immutable snapshot remains in history.');
    }
    let status: Job['status'] = input.automatic ? 'scheduled' : 'awaiting_operator';
    let message = input.automatic ? 'Approved for automatic publication to this selected account.' : 'Ready for native publication. Follow the handoff and record the real receipt.';
    if (input.automatic) {
      try {
        if (account.status !== 'connected') throw new Error('Connect this target account before automatic publication.');
        assertAutomatedPublishingAllowed(draft, account); await validateMedia(variant);
        if (account.provider === 'postiz') validatePostizVariant(account, variant);
      } catch (error) { status = 'failed'; message = error instanceof Error ? error.message : 'Publishing preflight failed.'; }
    }
    const job: Job = { id: input.jobId ? z.uuid().parse(input.jobId) : randomUUID(), draftId: draft.id, platform: account.platform, accountId: account.id, approvedHash: targetHash(draft, variant, account), contentHash: key, snapshot: structuredClone({ draft, account, variant }), status, scheduledAt: now(), createdAt: now(), provider: account.provider, providerPostId: null, remoteId: null, remoteUrl: null, attempts: 0, submissionOwner: null, submissionStartedAt: null, metrics: [], error: status === 'failed' ? message : null, history: [{ at: now(), status, message }] };
    if (requestedSchedule) job.scheduledAt = requestedSchedule;
    if (input.automation) {
      job.automation = input.automation;
      job.history.push({ at: now(), status, message: `Task publication authority: ${JSON.stringify(input.automation)}` });
    }
    state.jobs.push(job); return job;
  });
  if (['submitting', 'needs_reconciliation'].includes(prepared.status)) assertPublicationAction(prepared, input.automatic);
  return prepared;
}
export async function retryFailedPublication(id: string): Promise<Job> {
  return mutateState(async state => {
    const job = findJob(state, id);
    if (job.status !== 'failed') return job;
    if (job.providerPostId || job.remoteId || job.remoteUrl) throw new Error('This submission has a remote identity. Reconcile it before retrying.');
    if (await hasYouTubeUploadJournal(job)) throw new Error('A durable YouTube upload journal exists. Reconcile the saved upload; do not retry it as a new submission.');
    const account = findAccount(state, job.accountId);
    if (job.subject?.kind === 'video') {
      const { verifyVideoDeliveryApproval } = await import('./video-delivery.ts');
      await verifyVideoDeliveryApproval(job);
      if (!job.snapshot?.video || JSON.stringify(account) !== JSON.stringify(job.snapshot.account)) throw new Error('Target account changed. Review and approve the video again.');
      await validateMedia(job.snapshot.variant);
    } else {
      const draft = findDraft(state, requireArticleId(job)); const variant = variantFor(draft, job.platform);
      await verifyApproval(draft, variant, account, job); await validateMedia(variant);
    }
    if (account.status !== 'connected') throw new Error('Connect the selected account before retrying.');
    transition(job, 'scheduled', 'Retrying the same unfinished publication; no new job was created.'); job.scheduledAt = now(); return job;
  });
}

export async function reconcileJob(id: string, options: { signal?: AbortSignal } = {}): Promise<Job> { return withJobExecution(id, 'reconcile', () => reconcileJobOwned(id, options.signal)); }

export async function confirmPublication(jobId: string, remoteUrl: string, remoteId: string): Promise<Job> { return withJobExecution(jobId, 'reconcile', () => confirmPublicationOwned(jobId, remoteUrl, remoteId)); }
