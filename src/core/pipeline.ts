import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { accountSchema, briefSchema, generatedSchema, metricsInputSchema, nativeUrls, type Account, type Brief, type Draft, type Generated, type Job, type Platform, type StudioState, type Variant } from './model.ts';
import { dataDirectory, mutateState, readState } from './store.ts';
import { assertAutomatedPublishingAllowed } from './publishing-policy.ts';
import { canonicalPostizContent, listRemotePosts, RejectedPublishError, submitPostiz, validatePostizVariant, verifyIntegration, type Integration } from './postiz.ts';

const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
const videoPlatforms = new Set<Platform>(['tiktok', 'bilibili', 'youtube', 'kuaishou', 'douyin']);
const activeSubmissions = new Set<string>();
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
  const absolute = await realpath(resolve(path)).catch(() => { throw new Error(`Media file does not exist: ${path}`); });
  const roots = await Promise.all([realpath(process.cwd()), realpath(dataDirectory()).catch(() => resolve(dataDirectory()))]);
  if (!roots.some(root => inside(absolute, root))) throw new Error('Media must be an original local file inside the project or STUDIO_DATA_DIR.');
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
async function draftHash(draft: Draft): Promise<string> {
  const media = await Promise.all(draft.variants.flatMap(variant => variant.mediaPaths.map(async path => ({ path, hash: (await mediaInfo(path)).hash }))));
  return digest({ revision: draft.revision, title: draft.title, body: draft.body, brief: draft.brief, variants: draft.variants, media });
}
function targetHash(draft: Draft, variant: Variant, account: Account): string {
  return digest({ draftApproval: draft.approvedHash, variant, accountId: account.id, platform: account.platform, provider: account.provider, integrationId: account.integrationId, label: account.label });
}
async function contentKey(variant: Variant, account: Account): Promise<string> {
  const mediaHashes = await Promise.all(variant.mediaPaths.map(async path => (await mediaInfo(path)).hash));
  const content = account.provider === 'postiz' ? canonicalPostizContent(variant) : { title: variant.title, text: variant.text, tags: variant.tags };
  return digest({ content, mediaHashes, accountId: account.id, platform: account.platform, provider: account.provider, integrationId: account.integrationId });
}
async function validateMedia(variant: Variant): Promise<void> {
  const files = await Promise.all(variant.mediaPaths.map(mediaInfo));
  if (videoPlatforms.has(variant.platform) && !files.some(file => file.video)) throw new Error('This channel requires a real video file. A generated script is not a publishable video; attach an actual video first.');
}
export async function verifyDraftApproval(draft: Draft): Promise<void> {
  if (!draft.approvedHash || draft.approvedHash !== await draftHash(draft)) throw new Error('Draft content or media changed after approval. Review and approve it again.');
}
async function verifyApproval(draft: Draft, variant: Variant, account: Account, job?: Job): Promise<void> {
  assertAutomatedPublishingAllowed(draft, account);
  await verifyDraftApproval(draft);
  if (job && job.approvedHash !== targetHash(draft, variant, account)) throw new Error('Approved content revision or account target changed. Cancel this job and schedule the reviewed revision.');
}

export async function createDraft(briefInput: Brief, generatedInput: Generated): Promise<Draft> {
  const brief = briefSchema.parse(briefInput);
  const generated = validGenerated(brief, generatedInput);
  const draft: Draft = { ...generated, id: randomUUID(), brief, createdAt: now(), revision: 1, approvedHash: null };
  return mutateState(state => { state.drafts.push(draft); return draft; });
}
export async function replaceDraft(id: string, generatedInput: Generated, expectedRevision?: number): Promise<Draft> {
  return mutateState(state => {
    const draft = findDraft(state, id);
    if (expectedRevision !== undefined && draft.revision !== expectedRevision) throw new Error('Draft revision changed while this operation was running. Refresh the draft and retry.');
    if (state.jobs.some(job => job.draftId === id && job.status === 'submitting')) throw new Error('This draft has an active provider submission. Reconcile its outcome before editing.');
    Object.assign(draft, validGenerated(draft.brief, generatedInput), { revision: draft.revision + 1, approvedHash: null });
    return draft;
  });
}
export async function approveDraft(id: string): Promise<Draft> {
  return mutateState(async state => { const draft = findDraft(state, id); draft.approvedHash = await draftHash(draft); return draft; });
}
export async function addAccount(input: Omit<Account, 'id'>): Promise<Account> {
  const account = accountSchema.parse({ ...input, id: randomUUID() });
  if (account.provider === 'postiz' && account.status === 'connected') { await verifyIntegration(account); account.verifiedAt = now(); }
  return mutateState(state => {
    if (state.accounts.some(existing => existing.provider === account.provider && existing.platform === account.platform && (account.provider === 'postiz' ? existing.integrationId === account.integrationId : existing.label === account.label))) throw new Error('This account already exists.');
    state.accounts.push(account); return account;
  });
}
function sameTarget(left: Account, right: Account): boolean {
  return left.platform === right.platform && left.provider === right.provider && left.integrationId === right.integrationId && left.label === right.label;
}
export async function updateAccount(id: string, input: Omit<Account, 'id'>): Promise<Account> {
  const account = accountSchema.parse({ ...input, id });
  if (account.provider === 'postiz' && account.status === 'connected') { await verifyIntegration(account); account.verifiedAt = now(); }
  return mutateState(state => {
    const existing = findAccount(state, id);
    if (!sameTarget(existing, account) && state.jobs.some(job => job.accountId === id && job.status === 'submitting')) throw new Error('Account target cannot change during an active provider submission.');
    if (state.accounts.some(other => other.id !== id && other.provider === account.provider && other.platform === account.platform && (account.provider === 'postiz' ? other.integrationId === account.integrationId : other.label === account.label))) throw new Error('This account target already exists.');
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
  const ids = (await readState()).jobs.filter(job => job.status === 'scheduled' && Date.parse(job.scheduledAt) <= Date.now()).map(job => job.id);
  const results: Job[] = [...recovered];
  for (const id of ids) {
    activeSubmissions.add(id);
    try {
      const claimed = await mutateState(async state => {
        const job = findJob(state, id);
        if (state.paused || job.status !== 'scheduled') return null;
        const draft = findDraft(state, job.draftId); const account = findAccount(state, job.accountId); const variant = variantFor(draft, job.platform);
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
      if (!claimed) continue;
      if (claimed.failed) { results.push(claimed.job); continue; }
      let integration: Integration;
      // This read-only preflight cannot create a remote post.
      try { integration = await verifyIntegration(claimed.account); }
      catch (error) {
        results.push(await mutateState(state => { const job = findJob(state, id); transition(job, 'failed', error instanceof Error ? error.message : 'Postiz connection verification failed.'); return job; }));
        continue;
      }
      const final = await mutateState(async state => {
        const job = findJob(state, id);
        if (state.paused) { transition(job, 'scheduled', 'Publishing paused before provider submission.'); return null; }
        if (job.status !== 'submitting' || job.submissionOwner !== owner) return null;
        const draft = findDraft(state, job.draftId); const account = findAccount(state, job.accountId); const variant = variantFor(draft, job.platform);
        try {
          if (account.status !== 'connected') throw new Error('Target account is no longer connected.');
          await verifyApproval(draft, variant, account, job); await validateMedia(variant); validatePostizVariant(account, variant);
          if (account.integrationId !== integration.id) throw new Error('Account target changed after connection verification.');
        } catch (error) { transition(job, 'failed', error instanceof Error ? error.message : 'Final approval check failed.'); return null; }
        job.submissionStartedAt = now();
        return { job, account, variant };
      });
      if (!final) { results.push(findJob(await readState(), id)); continue; }
      let remoteId: string;
      try { remoteId = await submitPostiz(final.job, final.account, final.variant, integration); }
      catch (error) {
        results.push(await mutateState(state => { const job = findJob(state, id); transition(job, error instanceof RejectedPublishError ? 'failed' : 'needs_reconciliation', error instanceof Error ? error.message : 'Provider outcome unknown.'); return job; }));
        continue;
      }
      // A persistence failure after POST leaves submitting in the durable state, so restart requires reconciliation.
      results.push(await mutateState(state => { const job = findJob(state, id); job.providerPostId = remoteId; transition(job, 'queued', 'Postiz accepted this job. Reconcile later for a platform publication URL.'); return job; }));
    } finally { activeSubmissions.delete(id); }
  }
  return results;
}
export async function pausePublishing(paused: boolean): Promise<void> { await mutateState(state => { state.paused = paused; }); }

const receiptHosts: Record<Platform, readonly string[]> = { xiaohongshu: ['xiaohongshu.com', 'xhslink.com'], reddit: ['reddit.com'], x: ['x.com', 'twitter.com'], wechat: ['mp.weixin.qq.com'], tiktok: ['tiktok.com'], bilibili: ['bilibili.com', 'b23.tv'], youtube: ['youtube.com', 'youtu.be'], kuaishou: ['kuaishou.com'], douyin: ['douyin.com'], instagram: ['instagram.com'], linkedin: ['linkedin.com'], facebook: ['facebook.com', 'fb.watch'] };
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
export async function confirmPublication(jobId: string, remoteUrl: string, remoteId: string): Promise<Job> {
  return mutateState(state => {
    const job = findJob(state, jobId);
    if (!['awaiting_operator', 'needs_reconciliation', 'queued'].includes(job.status)) throw new Error('Only a submitted or native handoff job can receive a publication receipt.');
    job.remoteUrl = validateReceipt(job.platform, remoteUrl, remoteId); job.remoteId = remoteId.trim();
    transition(job, 'published', 'Operator supplied the platform post identifier and URL.'); return job;
  });
}
export async function cancelJob(id: string): Promise<Job> {
  return mutateState(state => {
    const job = findJob(state, id);
    if (!['scheduled', 'awaiting_operator', 'failed'].includes(job.status)) throw new Error('This job may already exist at the provider. Reconcile or cancel it at the provider before any new submission.');
    transition(job, 'cancelled', 'Local job cancelled before confirmed publication.'); return job;
  });
}
export async function reconcileJob(id: string): Promise<Job> {
  const state = await readState(); const job = findJob(state, id); const draft = job.snapshot?.draft ?? findDraft(state, job.draftId); const account = job.snapshot?.account ?? findAccount(state, job.accountId); const variant = job.snapshot?.variant ?? variantFor(draft, job.platform);
  if (job.provider !== 'postiz' || !['queued', 'needs_reconciliation'].includes(job.status)) throw new Error('This job needs a native publication receipt or is not ready for Postiz reconciliation.');
  if (!job.providerPostId && job.approvedHash !== targetHash(draft, variant, account)) throw new Error('Content or target changed after the unknown submission. Inspect the provider and record its exact publication receipt.');
  const posts = await listRemotePosts(job);
  const matches = posts.filter(post => post.integration.id === account.integrationId && (job.providerPostId ? post.id === job.providerPostId : post.content === canonicalPostizContent(variant) && Math.abs(Date.parse(post.publishDate) - Date.parse(job.submissionStartedAt ?? job.scheduledAt)) <= 60000));
  return mutateState(current => {
    const currentJob = findJob(current, id);
    if (!['queued', 'needs_reconciliation'].includes(currentJob.status)) return currentJob;
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
export async function exportJob(id: string): Promise<{ job: Job; account: Account; draft: Draft; variant: Variant; nativeUrl: string }> {
  const state = await readState(); const job = findJob(state, id); const draft = job.snapshot?.draft ?? findDraft(state, job.draftId); const account = job.snapshot?.account ?? findAccount(state, job.accountId); const variant = job.snapshot?.variant ?? variantFor(draft, job.platform);
  await verifyApproval(draft, variant, account, job); await validateMedia(variant);
  return { job, account, draft, variant, nativeUrl: nativeUrls[job.platform] };
}
export async function recordMetrics(jobId: string, input: z.infer<typeof metricsInputSchema>): Promise<Job> {
  const metrics = metricsInputSchema.parse(input);
  return mutateState(state => { const job = findJob(state, jobId); if (job.status !== 'published') throw new Error('Record performance only after a confirmed publication.'); job.metrics.push({ ...metrics, at: now() }); return job; });
}
