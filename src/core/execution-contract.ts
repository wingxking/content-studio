import { z } from 'zod';

export const executionVersion = 1;
export const executionStageSchema = z.enum(['preflight', 'editor', 'images', 'symbols', 'dispatch', 'receipt', 'reconcile', 'metrics']);
export const executionErrorSchema = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/), stage: executionStageSchema, retryable: z.boolean(), message: z.string().min(1).max(500) }).strict();
const identity = z.object({ platform: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), accountId: z.string().min(1).max(200) }).strict();
const remote = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), url: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }), account: identity, visibility: z.enum(['public', 'unlisted', 'private', 'unknown']), processing: z.enum(['ready', 'pending', 'rejected', 'unknown']) }).strict();
export const executionResultSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('rejected'), noSideEffect: z.literal(true), error: executionErrorSchema }).strict(),
  z.object({ version: z.literal(1), status: z.literal('accepted'), attemptId: z.uuid(), remote: remote.optional() }).strict(),
  z.object({ version: z.literal(1), status: z.literal('unknown'), attemptId: z.uuid(), error: executionErrorSchema }).strict(),
  z.object({ version: z.literal(1), status: z.literal('verified'), attemptId: z.uuid(), remote }).strict(),
]);
export type ExecutionResult = z.infer<typeof executionResultSchema>;
export function verifiedExecutionStatus(result: ExecutionResult, expected: { platform: string; accountId: string; visibility: 'public' | 'unlisted' | 'private' }): 'published' | 'delivered' | 'queued' | 'needs_reconciliation' | 'failed' {
  if (result.status === 'rejected') return 'failed';
  if (result.status === 'unknown') return 'needs_reconciliation';
  if (result.status === 'accepted') return 'queued';
  if (result.remote.account.platform !== expected.platform || result.remote.account.accountId !== expected.accountId) return 'needs_reconciliation';
  if (!canonicalExecutionReceipt(result.remote.account.platform, result.remote.account.accountId, result.remote.id, result.remote.url)) return 'needs_reconciliation';
  if (result.remote.processing !== 'ready') return 'needs_reconciliation';
  if (result.remote.visibility !== expected.visibility) return 'needs_reconciliation';
  return expected.visibility === 'public' ? 'published' : 'delivered';
}
export const financeSymbolSchema = z.object({ market: z.enum(['SH', 'SZ', 'HK', 'US']), code: z.string().regex(/^[A-Z0-9.-]{1,16}$/), name: z.string().trim().min(1).max(80) }).strict();
export const executorRequestSchema = z.object({ version: z.literal(1), operation: z.enum(['preflight', 'publish', 'reconcile', 'collect_metrics']), platform: z.enum(['xueqiu', 'gelonghui', 'guba']), sessionId: z.uuid(), expectedAccountId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), jobId: z.uuid(), attemptId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), ownerToken: z.uuid(), deadline: z.iso.datetime(), title: z.string().max(300), text: z.string().max(60000), symbols: z.array(financeSymbolSchema).max(20), assets: z.array(z.object({ id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().regex(/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/), bytes: z.number().int().min(1).max(10 * 1024 * 1024) }).strict()).max(20), remoteId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional() }).strict();

export function canonicalExecutionReceipt(platform: string, accountId: string, id: string, value: string): boolean {
  try {
    const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return false;
    if (platform === 'xueqiu') return /^\d+$/.test(accountId) && /^\d+$/.test(id) && url.hostname === 'xueqiu.com' && url.pathname === `/${accountId}/${id}`;
    if (platform === 'gelonghui') return /^\d+$/.test(id) && url.hostname === 'www.gelonghui.com' && url.pathname === `/p/${id}`;
    // Guba's exact reviewed community code is essential; it cannot be guessed from a post ID.
    return false;
  } catch { return false; }
}
