import { publishingCapability, validateLaunchVariant } from './publishing-capabilities.ts';
import { basename } from 'node:path';
import { z } from 'zod';
import { mutateState, readState } from './store.ts';
import { approveDraft, preparePublication, retryFailedPublication, reconcileJob, runDueJobs } from './pipeline.ts';
import { createOperation, createVideoOperation, listOperations, listVideoOperations } from './editor.ts';
import { reconcileYouTubeJob, uploadYouTubeJob, youtubeSettingsSchema, expectedYouTubeChannelId } from './youtube.ts';
import { platformIds, type Job, type Account, type Draft } from './model.ts';
import { hasYouTubeUploadJournal } from './publication-journal.ts';

function automaticFor(account: Account, draft: Draft): boolean {
  if (account.status !== 'connected') return false;
  if (account.provider === 'native') return account.platform === 'youtube' && account.integrationId === expectedYouTubeChannelId;
  if (!['x', 'linkedin', 'reddit'].includes(account.platform)) return false;
  if (account.platform === 'x' && (draft.brief.topicOrigin === 'trend' || draft.brief.sources.some(source => new URL(source.url).hostname === 'trends.google.com'))) return false;
  return true;
}
export const publishInputSchema = z.object({ accountIds: z.array(z.uuid()).min(1).max(platformIds.length), expectedRevision: z.number().int().positive(), youtubeSettings: youtubeSettingsSchema.optional() });
export async function publishDraft(id: string, value: z.infer<typeof publishInputSchema>): Promise<Job[]> {
  const input = publishInputSchema.parse(value); const state = await readState();
  const draft = state.drafts.find(item => item.id === id);
  if (draft?.adaptationStatus === 'pending') throw new Error('The master is still waiting for platform adaptation. Finish or retry synchronization, then review the resulting platform versions before publishing.');
  if (!draft || draft.revision !== input.expectedRevision) throw new Error('Draft revision changed. Refresh and review before publishing.');
  const accounts = input.accountIds.map(accountId => { const account = state.accounts.find(item => item.id === accountId); if (!account || !draft.variants.some(variant => variant.platform === account.platform)) throw new Error('Select an account for an existing platform version.'); return account; });
  if (new Set(accounts.map(item => item.platform)).size !== accounts.length) throw new Error('Choose one target account per platform in this publication.');
  for (const account of accounts) { const variant = draft.variants.find(item => item.platform === account.platform); if (variant) validateLaunchVariant(variant); }
  await approveDraft(id, input.expectedRevision); const jobs: Job[] = [];
  for (const account of accounts) {
    const automatic = automaticFor(account, draft) && (account.platform !== 'youtube' || account.provider !== 'native' || input.youtubeSettings !== undefined);
    const job = await preparePublication({ draftId: id, accountId: account.id, expectedRevision: input.expectedRevision, automatic }); jobs.push(job);
    if (automatic && ['scheduled', 'awaiting_operator'].includes(job.status)) {
      const pending = (await listOperations(id)).some(operation => operation.kind === 'publish' && operation.input.jobId === job.id && ['queued', 'running'].includes(operation.status));
      if (!pending) await createOperation(id, 'publish', { jobId: job.id, ...(input.youtubeSettings ? { youtubeSettings: input.youtubeSettings } : {}) });
    }
  }
  return jobs;
}
async function reconcileSavedYouTubeUpload(id: string): Promise<Job> {
  await mutateState(state => {
    const job = state.jobs.find(item => item.id === id); if (!job) throw new Error('Publication not found.');
    if (!['scheduled', 'awaiting_operator', 'failed', 'cancelled'].includes(job.status)) return;
    const message = 'A durable YouTube upload journal exists. Verify its existing session or video before any new submission.';
    job.status = 'needs_reconciliation'; job.error = message;
    job.history.push({ at: new Date().toISOString(), status: 'needs_reconciliation', message });
  });
  return reconcileYouTubeJob(id);
}
async function executePublication(id: string, settings: unknown, signal?: AbortSignal): Promise<Job> {
  const state = await readState(); const job = state.jobs.find(item => item.id === id);
  if (!job) throw new Error('Publication not found.');
  if (job.deliveryAction === 'save_draft') return (await import('./remote-drafts.ts')).executeRemoteDraft(id, signal);
  if (job.status === 'published') return job;
  if (job.platform === 'youtube' && job.provider === 'native') {
    if (await hasYouTubeUploadJournal(job)) return reconcileSavedYouTubeUpload(id);
    if (['submitting', 'queued', 'needs_reconciliation', 'delivered'].includes(job.status) || job.providerPostId) return reconcileYouTubeJob(id);
    if (state.paused) throw new Error('Publishing is paused. Resume it in the queue, then continue this publication.');
    return uploadYouTubeJob(id, youtubeSettingsSchema.parse(settings));
  }
  if (['queued', 'needs_reconciliation'].includes(job.status) && job.provider === 'postiz') return reconcileJob(id);
  if (job.provider === 'postiz') { if (state.paused) throw new Error('Publishing is paused. Resume the queue before continuing.'); await runDueJobs(); }
  const result = (await readState()).jobs.find(item => item.id === id); if (!result) throw new Error('Publication disappeared.'); return result;
}
export async function handlePublication(id: string, settings: unknown, signal?: AbortSignal): Promise<Job> {
  try { return await executePublication(id, settings, signal); }
  catch (error) {
    await mutateState(state => {
      const job = state.jobs.find(item => item.id === id);
      if (!job || !['scheduled', 'awaiting_operator'].includes(job.status)) return;
      const message = error instanceof Error ? error.message : 'Publication failed before submission.';
      job.status = 'failed'; job.error = message;
      job.history.push({ at: new Date().toISOString(), status: 'failed', message });
    });
    throw error;
  }
}
export async function continuePublication(id: string): Promise<Job> {
  const state = await readState(); let job = state.jobs.find(item => item.id === id);
  if (!job) throw new Error('Publication not found.');
  if (job.deliveryAction === 'save_draft') return (await import('./remote-drafts.ts')).queueRemoteDraft(id);
  if (job.status === 'published') return job.platform === 'youtube' && job.provider === 'native' ? reconcileYouTubeJob(id) : job;
  if (await hasYouTubeUploadJournal(job)) return reconcileSavedYouTubeUpload(id);
  if (job.status === 'cancelled') return job;
  if (['queued', 'needs_reconciliation', 'submitting', 'delivered'].includes(job.status)) {
    if (job.platform === 'youtube' && job.provider === 'native') return reconcileYouTubeJob(id);
    if (job.provider === 'postiz' && job.status !== 'submitting') return reconcileJob(id);
    return job;
  }
  if (job.status === 'failed' && job.providerPostId) {
    if (job.platform === 'youtube' && job.provider === 'native') return reconcileYouTubeJob(id);
    if (job.provider === 'postiz') return reconcileJob(id);
    throw new Error('This failed job has a remote identity; verify the existing post before continuing.');
  }
  if (job.status === 'failed') job = await retryFailedPublication(id);
  if (!job.draftId) {
    if (job.subject?.kind !== 'video') throw new Error('Publication subject is missing.');
    const previous = (await listVideoOperations(job.subject.id)).find(item => item.kind === 'publish' && item.input.jobId === id);
    if (previous && !['queued', 'running'].includes(previous.status)) await createVideoOperation(job.subject.id, 'publish', { jobId: id, expectedRevision: job.subject.revision, ...(previous.input.youtubeSettings ? { youtubeSettings: previous.input.youtubeSettings } : {}) });
    return job;
  }
  const previous = (await listOperations(job.draftId)).find(item => item.kind === 'publish' && item.input.jobId === id);
  if (previous && ['queued', 'running'].includes(previous.status)) return job;
  if (previous || job.provider === 'postiz') await createOperation(job.draftId, 'publish', { jobId: id, ...(previous?.input.youtubeSettings ? { youtubeSettings: previous.input.youtubeSettings } : {}) });
  return job;
}
export async function publicationHandoff(id: string) {
  const state = await readState(); const job = state.jobs.find(item => item.id === id);
  if (!job?.snapshot) throw new Error('This legacy publication has no immutable handoff snapshot. Open its original account and verify the receipt.');
  if (job.deliveryAction === 'save_draft') throw new Error('Use the draft task and draft receipt. Public publication requires a separate reviewed action.');
  const { variant, account, draft } = job.snapshot;
  const uploadJournalExists = await hasYouTubeUploadJournal(job);
  const requiresReconciliation = Boolean(job.providerPostId || job.remoteId || job.remoteUrl || uploadJournalExists || ['submitting', 'queued', 'needs_reconciliation', 'delivered', 'published'].includes(job.status));
  const automaticEligible = draft && job.draftId ? automaticFor(account, draft) : job.subject?.kind === 'video' && account.status === 'connected' && account.provider === 'native' && account.platform === 'youtube' && account.integrationId === expectedYouTubeChannelId;
  const operations = automaticEligible ? job.draftId ? await listOperations(job.draftId) : job.subject?.kind === 'video' ? await listVideoOperations(job.subject.id) : [] : [];
  const automatic = operations.some(operation => operation.kind === 'publish' && operation.input.jobId === job.id);
  const reason = account.status !== 'connected' ? '账号尚未完成自动发布连接，可在原生创作页面登录并发布。' : automatic ? '支持已授权的 API 发布；如当前任务受阻，可按下方步骤核对后继续。' : '此平台使用创作者原生发布流程；保留人工发布步骤以符合平台权限和自动化要求。';
  const files = variant.mediaPaths.map(path => ({ name: basename(path), url: `/api/media?path=${encodeURIComponent(path)}` }));
  const capability = publishingCapability(job.platform, job.subject?.kind === 'video' || variant.format === 'video' ? 'video' : 'article', account, { postizConfigured: Boolean(process.env.POSTIZ_API_KEY), expectedYoutubeChannel: expectedYouTubeChannelId });
  return { requiresReconciliation, launch: variant.launch, articlePackageUrl: `/api/jobs/${job.id}/article.html`, capability, nativeUrl: capability.nativeUrl, title: variant.title, text: variant.text, tags: variant.tags, files, automatic, reason,
    steps: [
      `在 Chrome 的 radarxai@gmail.com 配置文件中打开创作页面，确认目标账号为 ${account.label}。`,
      '点击复制标题和正文，将内容粘贴到对应编辑框；检查格式、来源、标签及平台要求的 AI 内容标识。',
      files.length ? '下载下方素材，在发布页点击上传/选择文件，从下载目录选择对应图片或视频。' : ['youtube', 'tiktok', 'bilibili', 'kuaishou', 'douyin'].includes(job.platform) && !(job.platform === 'bilibili' && variant.format === 'article') ? '此版本还没有视频。先创建独立视频稿，渲染并预览，附加到平台版本后重新发布。' : '如果平台要求图片，请先在素材库上传并附加到该平台版本。',
      job.platform === 'producthunt' ? '确认个人账号完成 onboarding；按已保存的产品网址、名称、Tagline、介绍和首条评论填写产品上线页。可先在平台 Create draft，不要将本地资料当成已上线产品。' : job.platform === 'zhihu' ? '使用专栏文章入口，核对引用、内容声明与预览；保存草稿后仍需在平台确认发布。' : job.platform === 'bilibili' && variant.format === 'article' ? '使用专栏文章入口，不要向视频上传入口提交文字稿。核对封面、引用、声明并预览。' : job.platform === 'reddit' ? '选择个人主页或已核对规则的 subreddit，确认该社区允许此类内容。' : '预览最终页面，检查目标账号、可见性、标题和媒体。',
      '在平台完成一次发布，复制实际帖文/视频链接和编号，回到此页填写发布回执。结果不明时先查看账号历史，避免重复发布。',
    ] };
}
