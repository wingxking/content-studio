import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createVerificationCheck, publicationCheckLimits, runDuePublicationChecks } from '../src/core/publication-checks.ts';
import { emptyState, jobSchema, type Job } from '../src/core/model.ts';
import type { mutateState } from '../src/core/store.ts';
import { databaseRequestSignal } from '../src/core/database.ts';

const now = Date.parse('2026-10-14T00:00:00.000Z');
const accepted = (change: Partial<Job> = {}): Job => jobSchema.parse({ id: randomUUID(), draftId: randomUUID(), platform: 'reddit', accountId: randomUUID(), approvedHash: '', status: 'queued', scheduledAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), provider: 'postiz', providerPostId: 'accepted-id', remoteId: null, remoteUrl: null, attempts: 1, error: null, history: [], verificationCheck: { ...createVerificationCheck(now - 60_000), nextAt: new Date(now).toISOString() }, ...change });
function fixture(jobs: Job[], paused = false) {
  const state = { ...emptyState(), jobs, paused }; const reads: string[] = [];
  const mutate: typeof mutateState = async callback => callback(state);
  return { state, reads, dependencies: { read: async () => structuredClone(state), mutate, now: () => now, query: async (job: Job, signal: AbortSignal) => { assert.equal(signal.aborted, false); reads.push(job.id); return state.jobs.find(item => item.id === job.id)!; } } };
}
test('automatic checks are bounded reads for new accepted identifiers only', async () => {
  const jobs = Array.from({ length: 5 }, () => accepted()); const historical = accepted(); delete historical.verificationCheck;
  const data = fixture([...jobs, historical, accepted({ status: 'needs_reconciliation' }), accepted({ providerPostId: null }), accepted({ deliveryAction: 'save_draft' })]);
  assert.equal(await runDuePublicationChecks(undefined, data.dependencies), 3); assert.equal(data.reads.length, publicationCheckLimits.jobsPerTick);
  assert.ok(data.state.jobs.slice(0, 3).every(job => job.attempts === 1 && job.verificationCheck?.attempt === 1)); assert.equal(historical.verificationCheck, undefined);
  assert.equal(data.state.jobs.at(-1)?.verificationCheck?.stoppedReason, null); // Later records remain untouched after the tick budget.
});
test('paused restore, unknown outcomes, draft jobs and ID-free records never invoke a read', async () => {
  const paused = fixture([accepted()], true); assert.equal(await runDuePublicationChecks(undefined, paused.dependencies), 0); assert.equal(paused.reads.length, 0); assert.equal(paused.state.jobs[0]?.verificationCheck?.attempt, 0);
  const excluded = fixture([accepted({ status: 'needs_reconciliation' }), accepted({ providerPostId: null }), accepted({ deliveryAction: 'save_draft' })]);
  assert.equal(await runDuePublicationChecks(undefined, excluded.dependencies), 0); assert.equal(excluded.reads.length, 0); assert.ok(excluded.state.jobs.every(job => job.verificationCheck?.nextAt === null));
});
test('transient query failures back off without submission or raw error disclosure', async () => {
  const data = fixture([accepted()]); let reads = 0;
  await runDuePublicationChecks(undefined, { ...data.dependencies, query: async () => { reads++; throw new Error('network /Users/owner source-body secret'); } });
  const job = data.state.jobs[0]!; assert.equal(reads, 1); assert.equal(job.status, 'queued'); assert.equal(job.attempts, 1); assert.equal(Date.parse(job.verificationCheck!.nextAt!), now + 120_000); assert.doesNotMatch(job.verificationCheck!.lastError!, /owner|secret|source-body/u);
  await runDuePublicationChecks(undefined, data.dependencies); assert.equal(data.reads.length, 0);
});
test('permissions, terminal results, deadlines and attempt budgets stop polling', async () => {
  const permission = fixture([accepted()]); await runDuePublicationChecks(undefined, { ...permission.dependencies, query: async () => { throw new Error('Postiz unavailable (HTTP 403)'); } }); assert.equal(permission.state.jobs[0]?.verificationCheck?.stoppedReason, 'permission_required'); assert.equal(permission.state.jobs[0]?.verificationCheck?.nextAt, null);
  const terminal = fixture([accepted()]); await runDuePublicationChecks(undefined, { ...terminal.dependencies, query: async job => { const current = terminal.state.jobs.find(item => item.id === job.id)!; current.status = 'published'; return current; } }); assert.equal(terminal.state.jobs[0]?.verificationCheck?.stoppedReason, 'terminal');
  const expired = accepted(); expired.verificationCheck!.deadline = new Date(now).toISOString(); const exhausted = accepted(); exhausted.verificationCheck!.attempt = publicationCheckLimits.maxAttempts;
  const capped = fixture([expired, exhausted]); assert.equal(await runDuePublicationChecks(undefined, capped.dependencies), 0); assert.equal(expired.verificationCheck?.stoppedReason, 'window_expired'); assert.equal(exhausted.verificationCheck?.stoppedReason, 'attempt_budget');
});
test('tick timebox and parent cancellation prevent another query', async () => {
  const data = fixture([accepted(), accepted()]); let clock = now; let count = 0;
  await runDuePublicationChecks(undefined, { ...data.dependencies, now: () => clock, query: async job => { count++; clock += publicationCheckLimits.timeboxMs; return job; } }); assert.equal(count, 1);
  const controller = new AbortController(); controller.abort(); const cancelled = fixture([accepted()]); assert.equal(await runDuePublicationChecks(controller.signal, cancelled.dependencies), 0); assert.equal(cancelled.reads.length, 0);
});
test('concurrent terminal state wins over an in-flight query failure', async () => {
  const data = fixture([accepted()]);
  await runDuePublicationChecks(undefined, { ...data.dependencies, query: async (_job, signal) => { assert.equal(databaseRequestSignal(), signal); data.state.jobs[0]!.status = 'published'; throw new Error('network'); } });
  assert.equal(data.state.jobs[0]?.verificationCheck?.nextAt, null); assert.equal(data.state.jobs[0]?.verificationCheck?.stoppedReason, 'terminal'); assert.equal(databaseRequestSignal(), undefined);
});
