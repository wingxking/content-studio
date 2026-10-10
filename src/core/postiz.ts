import { z } from 'zod';
import { assertXText } from './text-limits.ts';
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
async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const { base, key } = config();
  return fetch(`${base}${path}`, { method, headers: { Authorization: key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
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
  if (!['x', 'linkedin'].includes(account.platform)) throw new Error('Automatic Postiz publishing currently supports text X and LinkedIn. Use native handoff for this platform.');
  if (variant.mediaPaths.length) throw new Error('Postiz media upload is not configured. Use native handoff with the original files.');
  if (!account.integrationId) throw new Error('A verified Postiz integration ID is required.');
  const content = canonicalPostizContent(variant);
  if (account.platform === 'x') assertXText(content);
  if (account.platform === 'linkedin' && content.length > 3000) throw new Error('LinkedIn text and tags exceed 3000 characters.');
}
export async function submitPostiz(job: Job, account: Account, variant: Variant, integration: Integration): Promise<string> {
  validatePostizVariant(account, variant);
  const settings = account.platform === 'x' ? { __type: 'x', who_can_reply_post: 'everyone' } : { __type: integration.identifier };
  const body = { type: 'now', date: job.submissionStartedAt ?? new Date().toISOString(), shortLink: false, tags: [], posts: [{ integration: { id: account.integrationId }, value: [{ content: canonicalPostizContent(variant), image: [] }], settings }] };
  let response: Response;
  try { response = await request('/posts', 'POST', body); }
  catch { throw new UncertainPublishError('Postiz submission did not return a response. Reconcile it before creating another job.'); }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new RejectedPublishError(`Postiz rejected this request (HTTP ${response.status}).`);
    throw new UncertainPublishError(`Postiz returned HTTP ${response.status}; the publish outcome is unknown. Reconcile before resubmitting.`);
  }
  try {
    const receipts = z.array(z.object({ postId: z.string().min(1), integration: z.string() })).parse(await response.json());
    if (receipts.length !== 1 || receipts[0]?.integration !== account.integrationId) throw new Error('Unexpected receipt');
    return receipts[0].postId;
  } catch { throw new UncertainPublishError('Postiz accepted the request but returned an invalid receipt. Reconcile before resubmitting.'); }
}
export async function listRemotePosts(job: Job): Promise<RemotePost[]> {
  const day = 86400000;
  const query = new URLSearchParams({ startDate: new Date(Date.parse(job.submissionStartedAt ?? job.scheduledAt) - day).toISOString(), endDate: new Date(Math.max(Date.now(), Date.parse(job.submissionStartedAt ?? job.scheduledAt)) + day).toISOString() });
  const response = await request(`/posts?${query}`);
  if (!response.ok) throw new Error(`Postiz reconciliation unavailable (HTTP ${response.status}).`);
  return z.object({ posts: z.array(remotePostSchema) }).parse(await response.json()).posts;
}
