import type { Job } from './model.ts';
import { mutateState, readState } from './store.ts';
import { withDatabaseRequestSignal } from './database.ts';

const minute = 60_000;
export const publicationCheckLimits = { jobsPerTick: 3, timeboxMs: 55_000, maxAttempts: 48, windowMs: 24 * 60 * minute } as const;
export function createVerificationCheck(at = Date.now()): NonNullable<Job['verificationCheck']> { return { nextAt: new Date(at + minute).toISOString(), deadline: new Date(at + publicationCheckLimits.windowMs).toISOString(), attempt: 0, checkedAt: null, lastError: null, stoppedReason: null }; }
export function isAcceptedPublicationCheck(job: Job): boolean {
  return !job.deliveryAction && (job.provider === 'postiz' && job.status === 'queued' && Boolean(job.providerPostId) || job.provider === 'native' && job.platform === 'youtube' && ['queued', 'delivered'].includes(job.status) && Boolean(job.remoteId));
}
type CheckDependencies = { read: typeof readState; mutate: typeof mutateState; query: (job: Job, signal: AbortSignal) => Promise<Job>; now: () => number };
const defaultQuery = async (job: Job, signal: AbortSignal): Promise<Job> => job.provider === 'postiz' ? (await import('./pipeline.ts')).reconcileJob(job.id, { signal }) : (await import('./youtube.ts')).reconcileYouTubeJob(job.id, { readOnly: true, signal });
function failure(error: unknown): { message: string; permission: boolean } {
  const text = error instanceof Error ? error.message : '';
  const permission = /(?:HTTP\s*(?:401|403)|auth|permission|credential|api.key|token|different.*channel|ambiguous.*channel)/iu.test(text);
  return { permission, message: permission ? '授权或目标账号需要复核，自动核验已停止。' : '远端状态查询暂不可用；原任务保留，等待退避后只读核验。' };
}
export async function runDuePublicationChecks(signal?: AbortSignal, supplied: Partial<CheckDependencies> = {}): Promise<number> {
  const deadline = AbortSignal.timeout(publicationCheckLimits.timeboxMs); const tickSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try { return await withDatabaseRequestSignal(tickSignal, () => runPublicationChecks(tickSignal, supplied)); }
  catch (error) { if (signal?.aborted) throw error; if (deadline.aborted) return 0; throw error; }
}
async function runPublicationChecks(signal: AbortSignal, supplied: Partial<CheckDependencies>): Promise<number> {
  const dependencies = { read: readState, mutate: mutateState, query: defaultQuery, now: Date.now, ...supplied };
  const started = dependencies.now(); const deadline = started + publicationCheckLimits.timeboxMs;
  const tickSignal = signal;
  const initial = await dependencies.read(); if (initial.paused || tickSignal.aborted) return 0;
  const ids = initial.jobs.filter(job => job.verificationCheck?.nextAt && Date.parse(job.verificationCheck.nextAt) <= started).sort((a, b) => a.verificationCheck!.nextAt!.localeCompare(b.verificationCheck!.nextAt!)).map(job => job.id);
  let checks = 0;
  for (const id of ids) {
    if (checks >= publicationCheckLimits.jobsPerTick || dependencies.now() >= deadline || tickSignal.aborted) break;
    const claimed = await dependencies.mutate(state => {
      const job = state.jobs.find(item => item.id === id); const polling = job?.verificationCheck;
      if (state.paused || !job || !polling?.nextAt || Date.parse(polling.nextAt) > dependencies.now()) return null;
      if (!isAcceptedPublicationCheck(job)) { polling.nextAt = null; polling.stoppedReason = ['published', 'failed', 'cancelled', 'draft_saved'].includes(job.status) ? 'terminal' : 'uncertain'; return null; }
      if (Date.parse(polling.deadline) <= dependencies.now() || polling.attempt >= publicationCheckLimits.maxAttempts) { polling.nextAt = null; polling.stoppedReason = polling.attempt >= publicationCheckLimits.maxAttempts ? 'attempt_budget' : 'window_expired'; return null; }
      polling.attempt++; polling.checkedAt = new Date(dependencies.now()).toISOString();
      // Claim in durable state before a read; a crash leaves a bounded retry delay.
      polling.nextAt = new Date(dependencies.now() + 5 * minute).toISOString(); return structuredClone(job);
    });
    if (!claimed) continue;
    checks++;
    let problem: ReturnType<typeof failure> | null = null;
    try { tickSignal.throwIfAborted(); const current = await dependencies.read(); if (current.paused) break; await dependencies.query(claimed, tickSignal); }
    catch (error) { problem = failure(error); }
    await dependencies.mutate(state => {
      const job = state.jobs.find(item => item.id === id); const polling = job?.verificationCheck;
      if (!job || !polling || polling.attempt !== claimed.verificationCheck?.attempt) return;
      polling.checkedAt = new Date(dependencies.now()).toISOString();
      polling.lastError = problem?.message ?? null;
      if (!isAcceptedPublicationCheck(job)) { polling.nextAt = null; polling.stoppedReason = job.status === 'needs_reconciliation' ? 'uncertain' : 'terminal'; }
      else if (problem?.permission) { polling.nextAt = null; polling.stoppedReason = 'permission_required'; }
      else if (polling.attempt >= publicationCheckLimits.maxAttempts || dependencies.now() >= Date.parse(polling.deadline)) { polling.nextAt = null; polling.stoppedReason = polling.attempt >= publicationCheckLimits.maxAttempts ? 'attempt_budget' : 'window_expired'; }
      else { const interval = problem ? Math.min(60 * minute, minute * 2 ** Math.min(polling.attempt, 6)) : 5 * minute; polling.nextAt = new Date(Math.min(dependencies.now() + interval, Date.parse(polling.deadline))).toISOString(); }
    });
  }
  return checks;
}
