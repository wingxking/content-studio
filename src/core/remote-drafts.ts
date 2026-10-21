import { withJobExecution, markAccountDispatch, accountExecutionSignal, AccountExecutionBusyError }  from './account-execution.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { draftExecutionSchema, draftExecutorSaveSchema, type DraftExecution } from '../contracts/draft-executor.ts';
import { type Account, type Draft, type Job, type Platform, type StudioState, type Variant, jobSchema, platformIds } from './model.ts';
import { mutateState, readState } from './store.ts';
import { adapterPlatform, draftBridgeRequest, nativeDraftPlatforms, sameDraftAccount, verifyDraftAccount, assertDraftJournalReady, draftJournalStatus } from './draft-connectors.ts';
import { isManagedMediaPath, resolveMediaLocation } from './media-location.ts';
import { savePostizDraft, validatePostizVariant, verifyIntegration } from './postiz.ts';
import { safeMarkdownToHtml } from './safe-markdown.ts';
import { DeliveryInputError } from './delivery-errors.ts';

const now = (): string => new Date().toISOString();
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
function target(account: Account) { return { id: account.id, platform: account.platform, provider: account.provider, integrationId: account.integrationId, reddit: account.reddit, userId: account.draftConnection?.userId, extensionId: account.draftConnection?.extensionId }; }
function transition(job: Job, status: Job['status'], message: string): Job {
  job.status = status; job.error = ['failed', 'needs_reconciliation'].includes(status) ? message : null;
  if (status !== 'submitting') { job.submissionOwner = null; job.submissionLeaseUntil = null; }
  job.history.push({ at: now(), status, message }); return job;
}
function getJob(state: StudioState, id: string): Job {
  const job = state.jobs.find(item => item.id === id);
  if (!job || job.deliveryAction !== 'save_draft' || !job.snapshot?.draft) throw new Error('Remote draft task not found.');
  return job;
}
export function validateDraftRoute(account: Account, variant: Variant): void {
  if (variant.platform !== account.platform) throw new DeliveryInputError('目标账号与平台版本不一致，请重新选择。', 'ACCOUNT_MISMATCH');
  if (account.status !== 'connected') throw new DeliveryInputError('账号尚未连接，请先完成登录和权限核验。', 'AUTHORIZATION_REQUIRED');
  if (account.provider === 'postiz') { validatePostizVariant(account, variant); return; }
  if (!(nativeDraftPlatforms as readonly Platform[]).includes(account.platform)) throw new DeliveryInputError('此平台暂不支持草稿同步，请选择手动交付。', 'UNSUPPORTED_ACTION');
  if (!account.draftConnection?.permissionConfirmed) throw new DeliveryInputError('请在账号连接中绑定插件实际身份，并允许保存已审核草稿。', 'AUTHORIZATION_REQUIRED');
  if (variant.format !== 'article') throw new DeliveryInputError('此连接仅支持文章草稿，请先将平台版本调整为文章格式。', 'UNSUPPORTED_FORMAT');
}
async function draftImages(variant: Variant): Promise<{ hashes: string[]; html: string; cover?: string }> {
  const hashes: string[] = []; const images: string[] = []; let bytes = 0;
  for (const location of variant.mediaPaths) {
    const path = await realpath(await resolveMediaLocation(location));
    if (!await isManagedMediaPath(path)) throw new Error('Draft images must be managed local assets.');
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > 5 * 1024 * 1024 || (bytes += info.size) > 10 * 1024 * 1024) throw new Error('Use images up to 5 MiB each and 10 MiB total for a browser draft.');
    const data = await readFile(path); const metadata = await sharp(data).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('Article drafts accept PNG, JPEG or WebP images.');
    hashes.push(createHash('sha256').update(data).digest('hex'));
    images.push(`data:image/${metadata.format};base64,${data.toString('base64')}`);
  }
  return { hashes, html: images.map(image => `<p><img src="${image}" alt=""></p>`).join(''), ...(images[0] ? { cover: images[0] } : {}) };
}
function articleContent(draft: Draft, variant: Variant, images: string): string {
  const text = safeMarkdownToHtml(variant.text);
  const tags = variant.tags.length ? `<p>${escapeHtml(variant.tags.map(tag => `#${tag.replace(/^#+/, '')}`).join(' '))}</p>` : '';
  const sources = draft.brief.sources.map(source => `<p>${escapeHtml(source.title)}<br>${escapeHtml(source.url)}</p>`).join('');
  return `${text}${images}${tags}${sources ? `<h2>Sources</h2>${sources}` : ''}`;
}
function nativeDraftRequest(job: Job, images: Awaited<ReturnType<typeof draftImages>>) {
  if (!job.snapshot?.draft) throw new Error('Original draft snapshot is required.');
  return draftExecutorSaveSchema.parse({ platforms: [adapterPlatform(job.platform)], draftOnly: true, execution: { protocolVersion: 1, jobId: job.id, contentHash: job.contentHash, expectedUserId: job.snapshot.account.draftConnection?.userId ?? '' }, article: { title: job.snapshot.variant.title, content: articleContent(job.snapshot.draft,job.snapshot.variant,images.html), ...(images.cover ? {cover:images.cover} : {}) } });
}
export const saveDraftsInputSchema = z.object({ accountIds: z.array(z.uuid()).min(1).max(platformIds.length), expectedRevision: z.number().int().positive() });
export async function prepareRemoteDrafts(id: string, value: z.infer<typeof saveDraftsInputSchema>, options: { jobId?: string } = {}): Promise<Job[]> {
  const input = saveDraftsInputSchema.parse(value); if (options.jobId && input.accountIds.length !== 1) throw new Error('A delivery command targets one account.'); const state = await readState();
  const draft = state.drafts.find(item => item.id === id);
  if (!draft || draft.revision !== input.expectedRevision || draft.adaptationStatus === 'pending') throw new Error('Review the current adapted revision before saving remote drafts.');
  if (draft.generationEvidenceRunId) { const { assertDraftQuality } = await import('./quality.ts'); const { taskWorkspaceId } = await import('./tasks.ts'); await assertDraftQuality(await taskWorkspaceId(), draft); }
  if (new Set(input.accountIds).size !== input.accountIds.length) throw new Error('Choose each account once.');
  const targets = await Promise.all(input.accountIds.map(async accountId => {
    const account = state.accounts.find(item => item.id === accountId); const variant = draft.variants.find(item => item.platform === account?.platform);
    if (!account || !variant) throw new Error('Choose an account with an existing platform version.');
    validateDraftRoute(account, variant);
    const images = await draftImages(variant);
    return { account, variant, mediaHashes: images.hashes, hash: digest({ action: 'save_draft', draftId: id, revision: draft.revision, variant, sources: draft.brief.sources, media: images.hashes, target: target(account) }) };
  }));
  return mutateState(current => {
    if (current.drafts.find(item => item.id === id)?.revision !== draft.revision) throw new Error('The article revision changed. Refresh and review it.');
    return targets.map(item => {
      const account = current.accounts.find(account => account.id === item.account.id);
      if (!account || digest(target(account)) !== digest(target(item.account)) || account.status !== 'connected') throw new Error('The selected account changed. Refresh its connection.');
      const existing = current.jobs.find(job => job.deliveryAction === 'save_draft' && job.contentHash === item.hash && job.status !== 'cancelled');
      if (existing) return existing;
      if (current.jobs.some(job => sameDraftAccount(job, account) && ['submitting', 'needs_reconciliation'].includes(job.status))) throw new Error('Resolve the existing account delivery before creating another draft.');
      if (options.jobId && current.jobs.some(job => job.id === options.jobId)) throw new Error('Delivery command changed.');
      const job = jobSchema.parse({ id: options.jobId ?? randomUUID(), deliveryAction: 'save_draft', draftId: id, subject: { kind: 'article', id, revision: draft.revision }, platform: account.platform, accountId: account.id, approvedHash: item.hash, contentHash: item.hash, mediaHashes: item.mediaHashes, snapshot: { draft, variant: item.variant, account }, status: 'scheduled', scheduledAt: now(), createdAt: now(), provider: account.provider, remoteId: null, remoteUrl: null, attempts: 0, error: null, history: [{ at: now(), status: 'scheduled', message: 'Reviewed revision queued for draft storage only; public publishing was not requested.' }] });
      current.jobs.push(job); return job;
    });
  });
}
export async function queueRemoteDraft(id: string): Promise<Job> {
  const job = getJob(await readState(), id);
  if (!['scheduled', 'failed'].includes(job.status)) return job;
  if (job.attempts > 0) throw new Error('A draft request was already sent. Inspect its existing outcome before any resubmission.');
  const { listOperations, createOperation } = await import('./editor.ts');
  const operations = await listOperations(job.draftId!);
  if (operations.some(operation => operation.kind === 'publish' && operation.input.jobId === id && ['queued', 'running'].includes(operation.status))) return job;
  await createOperation(job.draftId!, 'publish', { jobId: id, expectedRevision: job.subject?.revision });
  return job;
}
export async function saveRemoteDrafts(id: string, input: z.infer<typeof saveDraftsInputSchema>): Promise<Job[]> {
  const jobs = await prepareRemoteDrafts(id, input);
  for (const job of jobs) await queueRemoteDraft(job.id);
  return jobs;
}
function checkSnapshot(state: StudioState, job: Job): void {
  const draft = state.drafts.find(item => item.id === job.draftId); const account = state.accounts.find(item => item.id === job.accountId);
  if (!job.snapshot?.draft || !draft || draft.revision !== job.snapshot.draft.revision || !account || digest(target(account)) !== digest(target(job.snapshot.account))) throw new Error('Content revision or target account changed. Save the newly reviewed revision instead.');
  validateDraftRoute(account, job.snapshot.variant);
}
export function safeDraftUrl(platform: Platform, id: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid remote draft identifier.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use the actual HTTPS draft editor URL.');
  if (platform === 'wechat' && url.hostname === 'mp.weixin.qq.com' && url.pathname === '/cgi-bin/appmsg' && url.searchParams.get('t') === 'media/appmsg_edit' && url.searchParams.get('action') === 'edit' && url.searchParams.get('appmsgid') === id) return `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${encodeURIComponent(id)}`;
  if (platform === 'zhihu' && url.hostname === 'zhuanlan.zhihu.com' && url.pathname === `/p/${id}/edit`) return `${url.origin}${url.pathname}`;
  if (platform === 'bilibili' && url.hostname === 'member.bilibili.com' && url.pathname === '/platform/upload/text/edit' && url.searchParams.get('aid') === id) return `${url.origin}${url.pathname}?aid=${encodeURIComponent(id)}`;
  throw new Error('The draft editor URL does not match the target platform and identifier.');
}
export function postizDraftUrl(): string {
  const url = new URL(process.env.POSTIZ_WEB_URL ?? 'https://platform.postiz.com/');
  if ((url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) || url.username || url.password || url.search || url.hash) throw new Error('Configure a safe Postiz web URL.');
  return url.href;
}
export function parseNativeDraftReceipt(platform: Platform, value: unknown, expectedExecution?: DraftExecution): NonNullable<Job['draftReceipt']> {
  if (expectedExecution) {
    const execution = z.object({ execution: draftExecutionSchema }).safeParse(value);
    if (!execution.success || digest(execution.data.execution) !== digest(draftExecutionSchema.parse(expectedExecution))) throw new Error('The draft receipt does not match the reviewed job and account.');
  }
  const parsed = z.object({ results: z.array(z.object({ platform: z.string(), success: z.literal(true), draftOnly: z.literal(true), postId: z.union([z.string(), z.number()]).transform(String), postUrl: z.string() })).length(1) }).safeParse(value);
  const result = parsed.success ? parsed.data.results[0] : undefined;
  if (!result || result.platform !== adapterPlatform(platform)) throw new Error('The adapter did not return a confirmed draft receipt. Inspect the platform draft box.');
  return { destination: 'platform', id: result.postId, url: safeDraftUrl(platform, result.postId, result.postUrl), verification: 'adapter_reported' };
}
async function executeRemoteDraftOwned(id: string, signal?: AbortSignal): Promise<Job> {
  const initial = getJob(await readState(), id);
  if (!['scheduled', 'failed'].includes(initial.status) || initial.attempts > 0) return initial;
  const owner = randomUUID(); let dispatched = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController(); const signals = [signal, controller.signal, accountExecutionSignal()].filter((item): item is AbortSignal => Boolean(item)); const activeSignal = AbortSignal.any(signals);
  try {
    const snapshot = initial.snapshot!;
    checkSnapshot(await readState(), initial);
    const images = await draftImages(snapshot.variant);
    if (digest(images.hashes) !== digest(initial.mediaHashes ?? [])) throw new Error('Draft images changed after review. Save a newly reviewed revision.');
    const integration = snapshot.account.provider === 'postiz' ? await verifyIntegration(snapshot.account) : null;
    if (!integration) { await verifyDraftAccount(snapshot.account); await assertDraftJournalReady(); }
    const providerUrl = integration ? postizDraftUrl() : null;
    activeSignal.throwIfAborted();
    const claimed = await mutateState(state => {
      const job = getJob(state, id);
      if (!['scheduled', 'failed'].includes(job.status) || job.attempts > 0) return null;
      checkSnapshot(state, job);
      if (state.jobs.some(other => other.id !== id && sameDraftAccount(other, snapshot.account) && ['submitting', 'needs_reconciliation'].includes(other.status))) throw new Error('Another delivery for this account is active or needs reconciliation.');
      job.submissionOwner = owner; job.submissionStartedAt = now(); job.submissionLeaseUntil = new Date(Date.now() + 15 * 60_000).toISOString(); job.attempts++;
      transition(job, 'submitting', 'Saving a remote draft. Inspect uncertain results before retrying.'); return job;
    });
    if (!claimed) return getJob(await readState(), id);
    // Persist dispatch intent before calling either remote writer. Loss after this point is uncertain.
    await markAccountDispatch(); dispatched = true;
    heartbeat = setInterval(() => { void mutateState(state => { const job = getJob(state, id); if (job.submissionOwner !== owner || job.status !== 'submitting') { controller.abort(); return; } job.submissionLeaseUntil = new Date(Date.now() + 15 * 60_000).toISOString(); }).catch(() => controller.abort()); }, 20_000);
    activeSignal.throwIfAborted();
    const execution: DraftExecution = { protocolVersion: 1, jobId: claimed.id, contentHash: claimed.contentHash, expectedUserId: snapshot.account.draftConnection?.userId ?? '' };
    const receipt: NonNullable<Job['draftReceipt']> = integration
      ? { destination: 'provider', id: await savePostizDraft(claimed, snapshot.account, snapshot.variant, integration), url: providerUrl!, verification: 'adapter_reported' }
      : parseNativeDraftReceipt(claimed.platform, await draftBridgeRequest('syncArticle', nativeDraftRequest(claimed,images), activeSignal), execution);
    return await mutateState(state => { const job = getJob(state, id); if (job.submissionOwner !== owner || job.status !== 'submitting') return job; job.draftReceipt = receipt; return transition(job, 'draft_saved', receipt.destination === 'platform' ? 'Adapter returned a native draft ID and editor URL. Open it to verify formatting; this is not a public post.' : 'Postiz accepted a provider draft. It is not in the destination platform draft box or publicly published.'); });
  } catch {
    return mutateState(state => {
      const job = getJob(state, id);
      if (dispatched && job.submissionOwner === owner && job.status === 'submitting') return transition(job, 'needs_reconciliation', 'Draft request outcome is unknown. Open the selected account draft box and record the existing draft; do not resubmit.');
      if (!dispatched && ['scheduled', 'failed'].includes(job.status) && job.attempts === 0) return transition(job, 'failed', 'Draft preflight failed. Check the companion, exact account login, article revision and local images, then retry. No draft request was sent.');
      return job;
    });
  } finally { if (heartbeat) clearInterval(heartbeat); }
}
async function confirmDraftReceiptOwned(jobId: string, id: string, value: string): Promise<Job> {
  return mutateState(state => {
    const job = getJob(state, jobId);
    if (!['draft_saved', 'needs_reconciliation'].includes(job.status)) throw new Error('Only a saved or uncertain draft accepts draft verification.');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Provide the actual draft identifier.');
    const url = job.provider === 'postiz' ? new URL(value) : null;
    if (url && (url.origin !== new URL(postizDraftUrl()).origin || url.username || url.password || url.search || url.hash)) throw new Error('Use the configured Postiz web origin without secret URL parameters.');
    job.draftReceipt = { destination: job.provider === 'postiz' ? 'provider' : 'platform', id, url: url?.href ?? safeDraftUrl(job.platform, id, value), verification: 'operator_verified', verifiedAt: now() };
    return transition(job, 'draft_saved', 'Operator verified the existing remote draft. No public publication was performed.');
  });
}

export async function executeRemoteDraft(id: string, signal?: AbortSignal): Promise<Job> {
  const initial = getJob(await readState(), id); if (!['scheduled', 'failed'].includes(initial.status) || initial.attempts > 0) return initial;
  try { return await withJobExecution(id, 'write', () => executeRemoteDraftOwned(id, signal)); }
  catch (error) {
    if (!(error instanceof AccountExecutionBusyError)) throw error;
    return mutateState(state => { const job = getJob(state, id); if (['scheduled', 'failed'].includes(job.status) && job.attempts === 0) return transition(job, 'failed', 'The target account is busy or needs reconciliation. No draft request was sent.'); return job; });
  }
}

export async function confirmDraftReceipt(jobId: string, id: string, value: string): Promise<Job> { return withJobExecution(jobId, 'reconcile', () => confirmDraftReceiptOwned(jobId, id, value)); }

/** Reconcile local records only. This path never calls a platform draft writer. */
export async function syncVerifiedDraftJournal(jobId: string): Promise<{ synchronized: true; jobId: string }> {
  return withJobExecution(jobId,'reconcile',async () => {
    const job = getJob(await readState(),jobId);
    if (job.provider !== 'native' || job.status !== 'draft_saved' || job.draftReceipt?.destination !== 'platform' || job.draftReceipt.verification !== 'operator_verified') throw new Error('请先在原平台核对账号、正文与素材，并在原任务保存实际草稿回执。');
    const images = await draftImages(job.snapshot!.variant);
    if (digest(images.hashes) !== digest(job.mediaHashes ?? [])) throw new Error('原草稿素材已变化，不能同步未知记录；请保留记录并恢复原素材后核对。');
    const receipt = {platform:adapterPlatform(job.platform),success:true,draftOnly:true,postId:job.draftReceipt.id,postUrl:safeDraftUrl(job.platform,job.draftReceipt.id,job.draftReceipt.url)};
    const result = z.object({synchronized:z.literal(true),jobId:z.uuid()}).strict().parse(await draftBridgeRequest('studio.confirmReceipt',{request:nativeDraftRequest(job,images),receipt},accountExecutionSignal()));
    if (result.jobId !== jobId) throw new Error('插件返回的核对记录与原任务不一致。');
    return result;
  });
}

export async function pendingDraftJournals() {
  const [journal,state] = await Promise.all([draftJournalStatus(),readState()]);
  return {...journal,items:journal.pending.map(jobId => {
    const job = state.jobs.find(item=>item.id===jobId && item.deliveryAction==='save_draft');
    const canSync = job?.provider==='native' && job.status==='draft_saved' && job.draftReceipt?.verification==='operator_verified' && job.draftReceipt.destination==='platform';
    return {jobId,title:job?.snapshot?.variant.title ?? '来自其他工作区的待核对记录',platform:job?.platform ?? null,draftId:job?.draftId ?? null,status:job?.status ?? null,canSync,reason:!job ? '请回到产生该记录的原工作区核对；当前工作区不会覆盖或删除它。' : canSync ? '原任务已登记人工核对回执，可同步到插件；不会再次发送草稿。' : '先在原账号草稿箱核对，再在该任务中保存实际草稿 ID 和编辑链接。'};
  })};
}
