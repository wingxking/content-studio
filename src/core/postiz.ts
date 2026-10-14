import { markAccountDispatch, markAccountRejected, withAccountExecution, accountExecutionSignal } from './account-execution.ts';
import { z } from 'zod';
import { assertXText } from './text-limits.ts';
import { validateRedditTarget } from './publishing-capabilities.ts';
import type { Account, Job, Variant } from './model.ts';

const integrationSchema = z.object({ id: z.string().min(1), name: z.string(), identifier: z.string(), disabled: z.boolean().optional() });
export type Integration = z.infer<typeof integrationSchema>;
const remotePostSchema = z.object({ id: z.string(), content: z.string(), publishDate: z.string(), releaseURL: z.string().nullable().optional(), state: z.string(), error: z.string().nullable().optional(), integration: z.object({ id: z.string(), providerIdentifier: z.string().optional() }) });
export type RemotePost = z.infer<typeof remotePostSchema>;
export class UncertainPublishError extends Error {}
export class RejectedPublishError extends Error {}

function config(): { base: string; key: string } {
  const key = process.env.POSTIZ_API_KEY;
  if (!key) throw new Error('Set POSTIZ_API_KEY in the environment before using the Postiz adapter.');
  const url = new URL(process.env.POSTIZ_BASE_URL ?? 'https://api.postiz.com/public/v1');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Postiz must use HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Postiz base URL cannot contain credentials, query, or fragment.');
  return { base: url.href.replace(/\/$/, ''), key };
}
async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
  const { base, key } = config();
  return fetch(`${base}${path}`, { method, headers: { Authorization: key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30000), ...signal ? [signal] : [], ...accountExecutionSignal() ? [accountExecutionSignal()!] : []]), redirect: 'error' });
}
export async function listIntegrations(): Promise<Integration[]> {
  const response = await request('/integrations');
  if (!response.ok) throw new Error(`Postiz integrations unavailable (HTTP ${response.status}).`);
  return z.array(integrationSchema).parse(await response.json());
}
function matchesPlatform(integration: Integration, account: Account): boolean {
  return integration.identifier === account.platform || (account.platform === 'linkedin' && integration.identifier === 'linkedin-page');
}
export async function verifyIntegration(account: Account): Promise<Integration> {
  const integration = (await listIntegrations()).find(item => item.id === account.integrationId);
  if (!integration || integration.disabled || !matchesPlatform(integration, account)) throw new Error('Postiz integration is missing, disabled, or does not match the selected platform.');
  return integration;
}
export function canonicalPostizContent(variant: Variant): string {
  const tags = variant.tags.map(tag => tag.trim().replace(/^#+/, '')).filter(Boolean).map(tag => `#${tag}`);
  return `${variant.text}${tags.length ? `\n\n${tags.join(' ')}` : ''}`;
}
export function validatePostizVariant(account: Account, variant: Variant): void {
  if (!['x', 'linkedin', 'reddit'].includes(account.platform)) throw new Error('Automatic Postiz publishing currently supports text X, LinkedIn and approved Reddit self posts. Use native handoff for this platform.');
  if (variant.mediaPaths.length) throw new Error('Postiz media upload is not configured. Use native handoff with the original files.');
  if (!account.integrationId) throw new Error('A verified Postiz integration ID is required.');
  const content = canonicalPostizContent(variant);
  if (account.platform === 'reddit') { validateRedditTarget(account); if (variant.title.length < 2 || variant.title.length > 300 || content.length > 40000) throw new Error('Reddit requires a 2–300 character title and at most 40000 characters of text.'); }
  if (account.platform === 'x') assertXText(content);
  if (account.platform === 'linkedin' && content.length > 3000) throw new Error('LinkedIn text and tags exceed 3000 characters.');
}
async function createPostizPostOwned(job: Job, account: Account, variant: Variant, integration: Integration, type: 'now' | 'draft'): Promise<string> {
  if (integration.id !== account.integrationId || integration.disabled || !matchesPlatform(integration, account) || variant.platform !== account.platform) throw new Error('Postiz integration and content must match the selected platform account.');
  validatePostizVariant(account, variant);
  const settings = account.platform === 'reddit' && account.reddit ? { __type: 'reddit', subreddit: [{ value: { subreddit: account.reddit.subreddit, title: variant.title, type: 'self', url: '', is_flair_required: account.reddit.flairRequired, flair: account.reddit.flair } }] } : account.platform === 'x' ? { __type: 'x', who_can_reply_post: 'everyone' } : { __type: integration.identifier };
  const body = { type, date: job.submissionStartedAt ?? new Date().toISOString(), shortLink: false, tags: [], posts: [{ integration: { id: account.integrationId }, value: [{ content: canonicalPostizContent(variant), image: [] }], settings }] };
  const action = type === 'draft' ? 'draft creation' : 'submission';
  let response: Response;
  await markAccountDispatch();
  try { response = await request('/posts', 'POST', body); }
  catch { throw new UncertainPublishError(`Postiz ${action} did not return a response. Reconcile it before creating another job.`); }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new RejectedPublishError(`Postiz rejected this request (HTTP ${response.status}).`);
    throw new UncertainPublishError(`Postiz returned HTTP ${response.status}; the ${action} outcome is unknown. Reconcile before resubmitting.`);
  }
  try {
    const receipts = z.array(z.object({ postId: z.string().min(1), integration: z.string() })).parse(await response.json());
    if (receipts.length !== 1 || receipts[0]?.integration !== account.integrationId) throw new Error('Unexpected receipt');
    return receipts[0].postId;
  } catch { throw new UncertainPublishError('Postiz accepted the request but returned an invalid receipt. Reconcile before resubmitting.'); }
}
export async function submitPostiz(job: Job, account: Account, variant: Variant, integration: Integration): Promise<string> {
  return createPostizPost(job, account, variant, integration, 'now');
}
export async function savePostizDraft(job: Job, account: Account, variant: Variant, integration: Integration): Promise<string> {
  // The receipt identifies a Postiz draft, not a native platform draft or a published post.
  return createPostizPost(job, account, variant, integration, 'draft');
}
export async function listRemotePosts(job: Job, signal?: AbortSignal): Promise<RemotePost[]> {
  const day = 86400000;
  const query = new URLSearchParams({ startDate: new Date(Date.parse(job.submissionStartedAt ?? job.scheduledAt) - day).toISOString(), endDate: new Date(Math.max(Date.now(), Date.parse(job.submissionStartedAt ?? job.scheduledAt)) + day).toISOString() });
  const response = await request(`/posts?${query}`, 'GET', undefined, signal);
  if (!response.ok) throw new Error(`Postiz reconciliation unavailable (HTTP ${response.status}).`);
  return z.object({ posts: z.array(remotePostSchema) }).parse(await response.json()).posts;
}

async function createPostizPost(job: Job, account: Account, variant: Variant, integration: Integration, type: 'now' | 'draft'): Promise<string> {
  return withAccountExecution(account, job.id, 'write', async () => {
    try { return await createPostizPostOwned(job, account, variant, integration, type); }
    catch (error) { if (error instanceof RejectedPublishError) markAccountRejected(); throw error; }
  });
}
