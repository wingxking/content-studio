import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Account, type Draft, type Job } from './model.ts';
import { taskInputSchema, type Task, type TaskInput, type TaskRun } from './task-model.ts';
import { hasAutomaticDelivery, taskDeliveryTargets, type JobAutomation } from '../contracts/task-automation.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const taskConfigHash = (task: TaskInput): string => hash(taskInputSchema.parse(task));
export const accountIdentityHash = (account: Account): string => hash({ platform: account.platform, provider: account.provider, integrationId: account.integrationId, physicalIdentity: account.physicalIdentity?.id, draftUserId: account.draftConnection?.userId, reddit: account.reddit });

/** The server creates the grant; client-supplied authorization fields are never trusted. */
export function authorizeTask(input: TaskInput, accounts: Account[], previous?: Task): Task['authorization'] {
  if (!hasAutomaticDelivery(input.delivery) || !input.enabled) return undefined;
  const configHash = taskConfigHash(input);
  const targets = taskDeliveryTargets(input.delivery).filter(target => target.mode === 'automatic').map(({ accountId: id }) => {
    const account = accounts.find(item => item.id === id);
    if (!account || !input.platforms.includes(account.platform) || account.status !== 'connected') throw new Error('Automatic tasks require connected accounts for the selected platforms.');
    if (!account.integrationId && !account.physicalIdentity?.id && !account.draftConnection) throw new Error('Verify the real account identity before authorizing automation.');
    return { id, identityHash: accountIdentityHash(account) };
  });
  if (previous?.authorization?.configHash === configHash && JSON.stringify(previous.authorization.accounts) === JSON.stringify(targets)) return previous.authorization;
  return { id: randomUUID(), configHash, createdAt: new Date().toISOString(), accounts: targets };
}

/** Resolve a wall clock without silently normalizing nonexistent/ambiguous DST times. */
export function publicationTimeFor(run: TaskRun): string {
  const delivery = run.taskSnapshot.delivery;
  if (!delivery) throw new Error('No delivery configuration.');
  if (run.taskSnapshot.frequency.type === 'once') return z.iso.datetime({ offset: true }).parse(delivery.onceAt);
  const anchor = run.slot.startsWith('scheduled:') ? run.slot.slice(10) : run.createdAt;
  const zone = run.taskSnapshot.frequency.timezone;
  const partsFor = (time: number) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time)).map(part => [part.type, part.value]));
  const parts = partsFor(Date.parse(anchor));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + delivery.dayOffset));
  const [hour, minute] = delivery.publicationTime.split(':').map(Number);
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = wall + delta; const local = partsFor(sample);
    offsets.add(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute)) - sample);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(time => {
    const local = partsFor(time);
    return Number(local.year) === day.getUTCFullYear() && Number(local.month) === day.getUTCMonth() + 1 && Number(local.day) === day.getUTCDate() && Number(local.hour) === hour && Number(local.minute) === minute;
  });
  if (candidates.length !== 1) throw new Error('Publication time is missing or ambiguous in the selected timezone. Choose a different time.');
  return new Date(candidates[0]!).toISOString();
}

export function assertTaskGrant(task: Task, authority: JobAutomation, account: Account): void {
  const grant = task.authorization;
  if (!task.enabled || !hasAutomaticDelivery(task.delivery) || !task.delivery?.authorized || !grant || grant.id !== authority.authorizationId || grant.configHash !== authority.configHash || taskConfigHash(task) !== authority.configHash) throw new Error('Automatic publication authorization was revoked or changed. Review this task.');
  if (!grant.accounts.some(target => target.id === account.id && target.identityHash === accountIdentityHash(account))) throw new Error('The authorized account identity changed. Authorize the current target again.');
}
export async function verifyJobAutomation(job: Job, account: Account): Promise<void> {
  if (!job.automation) return;
  const { getTask } = await import('./tasks.ts');
  assertTaskGrant(await getTask(job.automation.taskId), job.automation, account);
  if (Date.now() < Date.parse(job.scheduledAt)) throw new Error('Publication time has not arrived.');
  if (Date.now() > Date.parse(job.automation.deadlineAt)) throw new Error('Publication time was missed. Review and choose a new time; automatic catch-up is disabled.');
}

export function assertGeneratedRelease(draft: Draft, run: TaskRun): void {
  if (draft.id !== run.draftId || draft.revision !== 1 || draft.lastOperationId || draft.lastAppliedProposalId || draft.adaptationStatus === 'pending') throw new Error('The generated article changed. Review this revision manually.');
  if (!run.sources.length || !draft.brief.sources.length || run.sources.some(source => !source.excerpt.trim())) throw new Error('Automatic release requires readable public source evidence.');
  if (run.warnings.length) throw new Error('Research or generation warnings require review before public release.');
  if (!draft.variants.length || draft.variants.some(variant => !['article', 'text'].includes(variant.format ?? 'text') || !variant.title.trim() || !variant.text.trim() || !draft.brief.sources.some(source => variant.text.includes(source.url)))) throw new Error('Automatic article release requires source-linked article variants.');
}

/** Idempotent repair after generation commits; no browser-side schedule owner is added. */
export async function deliverGeneratedArticle(run: TaskRun): Promise<string[]> {
  const delivery = run.taskSnapshot.delivery;
  if (!run.draftId || !delivery) return [];
  const { readState } = await import('./store.ts');
  const { getTask } = await import('./tasks.ts');
  const { saveRemoteDrafts } = await import('./remote-drafts.ts');
  const { publishingCapability } = await import('./publishing-capabilities.ts');
  const { approveDraft, preparePublication } = await import('./pipeline.ts');
  const state = await readState(); const draft = state.drafts.find(item => item.id === run.draftId);
  if (!draft || draft.revision !== 1) return ['Article changed after generation. Automatic delivery needs review.'];
  const warnings: string[] = [];
  let authority: JobAutomation | undefined;
  if (hasAutomaticDelivery(delivery)) {
    try {
      const grant = run.taskSnapshot.authorization;
      if (!grant) throw new Error('This historical run has no publication authorization.');
      const at = publicationTimeFor(run);
      if (Date.parse(at) <= Date.now()) throw new Error('Publication time was missed; automatic catch-up is disabled.');
      authority = { taskId: run.taskId, runId: run.id, authorizationId: grant.id, configHash: grant.configHash, deadlineAt: new Date(Date.parse(at) + 90000).toISOString() };
      const task = await getTask(run.taskId);
      for (const { accountId: id } of taskDeliveryTargets(delivery).filter(target => target.mode === 'automatic')) { const account = state.accounts.find(item => item.id === id); if (!account) throw new Error('Target account is unavailable.'); assertTaskGrant(task, authority, account); }
    } catch (error) { authority=undefined;warnings.push(error instanceof Error ? error.message : 'Authorization needs review.'); }
  }
  for (const { accountId, mode } of taskDeliveryTargets(delivery)) {
    try {
      const account = state.accounts.find(item => item.id === accountId);
      if (!account || !run.taskSnapshot.platforms.includes(account.platform)) throw new Error('Target account does not match the generated platform.');
      const capability = publishingCapability(account.platform, 'article', account, { postizConfigured: Boolean(process.env.POSTIZ_API_KEY) });
      if (mode === 'automatic' && capability.automatic && authority) {
        assertGeneratedRelease(draft, run);
        await approveDraft(draft.id, 1);
        await preparePublication({ draftId: draft.id, accountId, expectedRevision: 1, automatic: true, scheduledAt: publicationTimeFor(run), automation: authority });
      } else if (mode === 'automatic') {
        warnings.push(`${account.platform} · ${account.label}: automatic public release is unavailable. No draft or public submission was requested; review this target.`);
      } else if (mode === 'draft') {
        await saveRemoteDrafts(draft.id, { expectedRevision: 1, accountIds: [accountId] });
      } else warnings.push(`${account.platform} · ${account.label}: article ready for manual publication.`);
    } catch (error) { warnings.push(`${accountId}: ${error instanceof Error ? error.message : 'Delivery needs attention.'}`); }
  }
  return warnings;
}
