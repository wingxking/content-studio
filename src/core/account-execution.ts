import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dbRpc } from './database.ts';
import { readState } from './store.ts';
import type { Account, Job } from './model.ts';

type Purpose = 'write' | 'reconcile' | 'resume' | 'metrics' | 'handoff';
type Fence = { key: string; token: string; workspace: string; jobId: string; purpose: Purpose; controller: AbortController; until: number; rejected: boolean; durable: boolean };
const context = new AsyncLocalStorage<Fence>();
const local = new Set<string>();
export class AccountExecutionBusyError extends Error {}
export function accountExecutionKey(account: Account): string {
  const uid = account.physicalIdentity?.id || account.draftConnection?.userId || (account.platform === 'youtube' && account.provider === 'native' ? account.integrationId : '');
  const identity = uid ? `remote:${uid}` : account.provider === 'postiz' && account.integrationId ? `postiz:${account.integrationId}` : `legacy:${account.id}`;
  return createHash('sha256').update(JSON.stringify([account.platform, identity])).digest('hex');
}
export function accountExecutionFence(): Pick<Fence, 'key' | 'token' | 'workspace'> | null {
  const fence = context.getStore();
  if (!fence?.durable) return null;
  assertAccountExecutionOwnership(); return fence;
}
export function assertAccountExecutionOwnership(): void {
  const fence = context.getStore(); if (!fence) return;
  if (fence.controller.signal.aborted || Date.now() >= fence.until) throw new Error('Account execution ownership lost; reconcile any dispatched request.');
}
export function accountExecutionSignal(): AbortSignal | undefined { return context.getStore()?.controller.signal; }
export async function markAccountDispatch(): Promise<void> {
  const fence = context.getStore(); if (!fence) return;
  assertAccountExecutionOwnership();
  if (fence.durable && await dbRpc('studio_mark_account_dispatch', { p_workspace: fence.workspace, p_key: fence.key, p_token: fence.token, p_job: fence.jobId }) !== true) { fence.controller.abort(); throw new Error('Account dispatch ownership lost.'); }
}
export function markAccountRejected(): void { const fence = context.getStore(); if (fence) fence.rejected = true; }
export async function withAccountExecution<T>(account: Account, jobId: string, purpose: Purpose, run: () => Promise<T>): Promise<T> {
  const key = accountExecutionKey(account); const current = context.getStore();
  if (current) { if (current.key !== key || current.jobId !== jobId) throw new Error('Nested account execution targets a different account or job.'); assertAccountExecutionOwnership(); return run(); }
  const durable = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
  if (process.env.STUDIO_CONTAINER === 'true' && !durable) throw new Error('Docker account execution requires Supabase.');
  const workspace = durable ? z.uuid().parse(process.env.STUDIO_WORKSPACE_ID) : '';
  const fence: Fence = { key, token: randomUUID(), workspace, jobId, purpose, controller: new AbortController(), until: Date.now() + 50_000, rejected: false, durable };
  if (durable) {
    if (await dbRpc('studio_acquire_account_execution', { p_workspace: workspace, p_key: key, p_token: fence.token, p_job: jobId, p_purpose: purpose }) !== true) throw new AccountExecutionBusyError('This account is busy or has an unresolved submission. Reconcile its original task first.');
  } else { if (local.has(key)) throw new AccountExecutionBusyError('This account is busy.'); local.add(key); }
  let renewing = false;
  const heartbeat = setInterval(() => { if (renewing) return; renewing = true; const renewedFrom = Date.now(); void (async () => { if (durable && await dbRpc('studio_renew_account_execution', { p_workspace: workspace, p_key: key, p_token: fence.token }) !== true) throw new Error('Account lease expired.'); fence.until = renewedFrom + 50_000; if (Date.now() >= fence.until) throw new Error('Account renewal arrived after its safe deadline.'); })().catch(() => fence.controller.abort()).finally(() => { renewing = false; }); }, 10_000);
  heartbeat.unref();
  try { return await context.run(fence, async () => { const result = await run(); assertAccountExecutionOwnership(); return result; }); }
  finally {
    clearInterval(heartbeat);
    if (durable) {
      let job: Job | undefined;
      try { job = (await readState()).jobs.find(item => item.id === jobId); } catch { /* Preserve the dispatch barrier if final state cannot be read. */ }
      const resolved = fence.rejected || Boolean(job && ['published', 'delivered', 'draft_saved'].includes(job.status));
      await dbRpc('studio_release_account_execution', { p_workspace: workspace, p_key: key, p_token: fence.token, p_resolved: resolved }).catch(() => undefined);
    } else local.delete(key);
    fence.controller.abort();
  }
}
export async function withJobExecution<T>(id: string, purpose: Purpose, run: () => Promise<T>): Promise<T> {
  const state = await readState(); const job = state.jobs.find(item => item.id === id);
  if (!job) throw new Error('Publication not found.');
  const account = job.snapshot?.account ?? state.accounts.find(item => item.id === job.accountId);
  if (!account) throw new Error('Publication account is missing.');
  return withAccountExecution(account, id, purpose, run);
}
