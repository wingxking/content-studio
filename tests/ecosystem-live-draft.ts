// Manual real Zhihu draft acceptance; never part of the unit test glob.
// Run only in a one-off Docker API process with the existing private bridge configuration
// and the generation acceptance bind mounted separately at /acceptance-live.
// node --import tsx tests/ecosystem-live-draft.ts --confirm-isolated-zhihu-draft --root /acceptance-live/zhihu-live-<suffix>
// Repeating inspects the original job only. --retry permits only failed, never-dispatched
// preflight (attempts=0), using that same job. No approval, public post, scheduler or cleanup.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Draft, Job, StudioState } from '../src/core/model.ts';

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactSchema = z.object({ path: z.string(), bytes: z.number().int().positive().max(2 * 1024 * 1024), sha256: hashSchema }).strict();
const generationSchema = z.object({ version: z.literal(1), workspaceId: z.uuid(), model: z.string().min(1).max(120), createdAt: z.iso.datetime(), sourceId: z.uuid(), sourceSha256: hashSchema, taskId: z.uuid(), runId: z.uuid(), artifacts: z.object({ master: artifactSchema, zhihu: artifactSchema, package: artifactSchema }).strict() }).strict();
const acceptanceSchema = z.object({ version: z.literal(1), workspaceId: z.uuid(), runId: z.uuid(), draftId: z.uuid(), revision: z.literal(1), generationManifestSha256: hashSchema, sourceSha256: hashSchema, targetIdentitySha256: hashSchema, artifactHashes: z.object({ master: hashSchema, zhihu: hashSchema, package: hashSchema }).strict(), title: z.string().min(1).max(300), accountId: z.uuid(), jobId: z.uuid(), contentHash: hashSchema, operationIds: z.array(z.uuid()).max(100), workerInvocations: z.number().int().nonnegative(), phase: z.enum(['prepared', 'worker_intent_saved', 'observed']), observedStatus: z.string().max(50), observedAttempts: z.number().int().nonnegative(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
type Acceptance = z.infer<typeof acceptanceSchema>;
let blockedAt = 'flags'; let root: string | undefined; let workspaceId: string | undefined;
let acceptance: Acceptance | null = null;
let readIsolatedState: (() => Promise<StudioState>) | undefined;
let canonicalReceiptUrl: ((platform: 'zhihu', id: string, value: string) => string) | undefined;

async function privateBytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await file.stat(); assert.ok(info.isFile() && info.size > 0 && info.size <= limit); assert.equal(info.mode & 0o077, 0); const bytes = await file.readFile(); assert.equal(bytes.length, info.size); return bytes; }
  finally { await file.close(); }
}
function safeSummary(job?: Job) {
  const receipt = job?.draftReceipt;
  return { workspaceId, root, jobId: job?.id ?? acceptance?.jobId ?? null, status: job?.status ?? null, attempts: job?.attempts ?? null, deliveryAction: job?.deliveryAction ?? null, receipt: receipt && canonicalReceiptUrl ? { id: receipt.id, url: canonicalReceiptUrl('zhihu', receipt.id, receipt.url), verification: receipt.verification } : null, publicPosts: 0, preserved: true, autoResubmitted: false, retryEligible: job?.status === 'failed' && job.attempts === 0, nextAction: job?.status === 'draft_saved' ? 'Read the existing draft in the intended native account; only then explicitly confirmDraftReceipt. No public publication.' : job && (job.attempts > 0 || job.status === 'needs_reconciliation') ? 'Inspect the original remote outcome. Do not resubmit or create a replacement job.' : 'Inspect the safe stage and existing job. Only a failed preflight with attempts=0 permits explicit --retry.' };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); const retry = args.includes('--retry');
  assert.equal(args.filter(arg => arg === '--confirm-isolated-zhihu-draft').length, 1);
  assert.equal(args.filter(arg => arg === '--root').length, 1); assert.ok(args.filter(arg => arg === '--retry').length <= 1);
  const index = args.indexOf('--root'); const selected = args[index + 1];
  assert.ok(selected && isAbsolute(selected) && !/[\u0000-\u001f]/u.test(selected));
  assert.deepEqual(args.filter((_arg, position) => position !== index && position !== index + 1).sort(), ['--confirm-isolated-zhihu-draft', ...(retry ? ['--retry'] : [])].sort());
  blockedAt = 'runtime';
  const { loadRuntimeEnvironment } = await import('../src/core/runtime-env.ts'); await loadRuntimeEnvironment();
  assert.equal(process.env.STUDIO_CONTAINER, 'true');
  const database = new URL(process.env.SUPABASE_URL ?? ''); assert.equal(database.protocol, 'http:'); assert.ok(['kong', 'localhost', '127.0.0.1'].includes(database.hostname)); assert.ok(process.env.SUPABASE_SECRET_KEY);
  const ownerWorkspace = z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
  const ownerRoots = [resolve(process.env.STUDIO_DATA_DIR ?? '/data'), resolve(process.env.STUDIO_LOCALFS_DIR ?? '/data/media/localfs'), '/data', '/auth', resolve(process.cwd())];
  blockedAt = 'isolated_root';
  const bind = await realpath('/acceptance-live'); root = await realpath(selected);
  assert.equal(root, resolve(selected)); assert.equal(dirname(root), bind); assert.match(basename(root), /^zhihu-live-[A-Za-z0-9_-]+$/u);
  const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
  assert.ok(!ownerRoots.some(ownerRoot => overlaps(root!, ownerRoot))); assert.ok(!overlaps(root, '/tmp'));
  assert.ok((await lstat(root)).isDirectory()); assert.equal((await lstat(root)).mode & 0o077, 0);
  assert.equal(await lstat(join(root, 'runtime.env')).then(() => true, error => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }), false);
  blockedAt = 'generation_manifest';
  const generationBytes = await privateBytes(join(root, 'live-generation.json'), 8192);
  const generation = generationSchema.parse(JSON.parse(generationBytes.toString('utf8'))); workspaceId = generation.workspaceId; assert.notEqual(workspaceId, ownerWorkspace);
  // No state/task/worker imports before the owner workspace has been excluded and all
  // isolated selectors replaced. Runtime loading cannot subsequently restore owner values.
  process.env.STUDIO_WORKSPACE_ID = workspaceId; process.env.STUDIO_DATA_DIR = root; process.env.STUDIO_LOCALFS_DIR = join(root, 'localfs'); process.env.STUDIO_WORKER_ROLE = 'delivery';
  delete process.env.STUDIO_KNOWLEDGE_IMPORT_DIR;
  const { dbRequest } = await import('../src/core/database.ts');
  const { accountSchema, draftSchema, variantSchema } = await import('../src/core/model.ts');
  const { taskRunSchema } = await import('../src/core/task-model.ts');
  const { readState } = await import('../src/core/store.ts');
  const { readDraftRevision } = await import('../src/core/artifacts.ts');
  const { KnowledgeStore, inspectKnowledgeText } = await import('../src/core/knowledge.ts');
  const { listTasks } = await import('../src/core/tasks.ts');
  const { safeDraftUrl, prepareRemoteDrafts, queueRemoteDraft } = await import('../src/core/remote-drafts.ts'); canonicalReceiptUrl = safeDraftUrl;
  const { getOperation, listOperations, handleStudioOperation } = await import('../src/core/editor.ts');
  const { draftAccountIdentity, bindDraftAccount } = await import('../src/core/draft-connectors.ts');
  const { runWorkerOnce, registerWorkerHandler } = await import('../src/server/worker.ts');
  blockedAt = 'artifact_validation';
  const verified: Record<'master' | 'zhihu' | 'package', Buffer> = { master: Buffer.alloc(0), zhihu: Buffer.alloc(0), package: Buffer.alloc(0) };
  for (const key of ['master', 'zhihu', 'package'] as const) {
    const artifact = generation.artifacts[key]; const path = join(root, 'runs', generation.runId, key === 'package' ? 'package.json' : `${key}.md`);
    assert.equal(resolve(artifact.path), path); assert.equal(await realpath(path), path);
    const bytes = await privateBytes(path, 2 * 1024 * 1024); assert.equal(bytes.length, artifact.bytes); assert.equal(sha(bytes), artifact.sha256); verified[key] = bytes;
  }
  const exportedValue: unknown = JSON.parse(verified.package.toString('utf8')); const exported = taskRunSchema.parse(exportedValue);
  const knowledge = z.object({ knowledge: z.object({ ref: z.uuid(), sources: z.array(z.object({ id: z.uuid(), sha256: hashSchema })).length(1) }) }).parse(exportedValue).knowledge;
  assert.equal(exported.status, 'succeeded'); assert.equal(exported.id, generation.runId); assert.equal(exported.taskId, generation.taskId); assert.equal(exported.draftId, generation.runId); assert.ok(exported.master);
  assert.equal(knowledge.ref, generation.runId); assert.equal(knowledge.sources[0]?.id, generation.sourceId); assert.equal(knowledge.sources[0]?.sha256, generation.sourceSha256);
  const row = z.object({ id: z.uuid(), task_id: z.uuid(), draft_id: z.uuid(), status: z.literal('succeeded'), master: taskRunSchema.shape.master, variants: z.array(variantSchema), task_snapshot: z.record(z.string(), z.unknown()) }).parse(z.array(z.unknown()).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${workspaceId}&id=eq.${generation.runId}&limit=1`))[0]);
  const normalizedSnapshot = taskRunSchema.shape.taskSnapshot.parse({ ...row.task_snapshot, createdAt: new Date(z.string().parse(row.task_snapshot.createdAt)).toISOString(), updatedAt: new Date(z.string().parse(row.task_snapshot.updatedAt)).toISOString(), nextRunAt: row.task_snapshot.nextRunAt == null ? null : new Date(z.string().parse(row.task_snapshot.nextRunAt)).toISOString() });
  assert.equal(row.id, exported.id); assert.equal(row.task_id, exported.taskId); assert.equal(row.draft_id, exported.draftId); assert.deepEqual(row.master, exported.master); assert.deepEqual(row.variants, exported.variants); assert.deepEqual(normalizedSnapshot, exported.taskSnapshot);
  // Verify the existing workspace before readState: never initialize a missing one.
  assert.equal(z.array(z.object({ id: z.uuid() })).parse(await dbRequest(`content_studio_workspaces?id=eq.${workspaceId}&select=id`)).length, 1);
  const state = await readState(); readIsolatedState = readState; assert.equal(state.paused, true); assert.equal(state.drafts.length, 1); assert.ok(state.accounts.length <= 1 && state.jobs.length <= 1);
  const draft: Draft = draftSchema.parse(state.drafts[0]); assert.equal(draft.id, exported.draftId); assert.equal(draft.revision, 1); assert.equal(draft.approvedHash, null); assert.equal(draft.generationKnowledgeRef, generation.runId); assert.notEqual(draft.adaptationStatus, 'pending');
  assert.deepEqual(draft, await readDraftRevision(draft.id, 1)); assert.equal(draft.title, exported.master.title); assert.equal(draft.body, exported.master.body); assert.deepEqual(draft.variants, exported.variants);
  assert.equal(draft.variants.length, 1); const variant = draft.variants[0]!; assert.equal(variant.platform, 'zhihu'); assert.equal(variant.format, 'article'); assert.deepEqual(variant.mediaPaths, []);
  assert.equal(verified.master.toString('utf8'), `# ${exported.master.title}\n\n${exported.master.body}\n`);
  assert.equal(verified.zhihu.toString('utf8'), `# ${variant.title}\n\n${variant.text}\n\n${variant.tags.map(tag => `#${tag.replace(/^#/u, '')}`).join(' ')}\n`);
  assert.deepEqual(draft.brief.platforms, ['zhihu']); assert.deepEqual(draft.brief.sources, []); assert.deepEqual(draft.brief.knowledgeIds, [generation.sourceId]);
  inspectKnowledgeText('reviewed-software.md', Buffer.from(`${draft.title}\n${draft.body}\n${variant.title}\n${variant.text}\n${variant.tags.join('\n')}`));
  const tasks = await listTasks(); assert.equal(tasks.length, 1); const task = tasks[0]!;
  assert.equal(task.id, generation.taskId); assert.equal(task.title, '软件备份为什么要验证恢复并固定内容修订？'); assert.equal(task.enabled, false); assert.equal(task.nextRunAt, null); assert.equal(task.kind, 'content'); assert.equal(task.frequency.type, 'once'); assert.equal(task.discoveryAutomation.enabled, false); assert.equal(task.topicOrigin, 'editorial'); assert.deepEqual(task.platforms, ['zhihu']); assert.deepEqual(task.sources, []); assert.deepEqual(task.assetIds, []); assert.deepEqual(task.knowledgeIds, [generation.sourceId]); assert.equal(task.model, generation.model);
  const store = new KnowledgeStore(); const source = await store.get(generation.sourceId); assert.equal(source.name, 'backup-revision-principles.md'); assert.equal(source.sha256, generation.sourceSha256);
  const snapshot = await store.readSnapshot(generation.runId, [generation.sourceId]); assert.equal(snapshot.length, 1); assert.equal(snapshot[0]?.sha256, generation.sourceSha256);
  blockedAt = 'authorized_target';
  // Read only the owner's already-authorized account metadata. Never use owner readState
  // (which can initialize a missing workspace), and never write into that workspace.
  const ownerRows = z.array(z.object({ accounts: z.array(accountSchema) })).parse(await dbRequest(`content_studio_workspaces?id=eq.${ownerWorkspace}&select=accounts:state->accounts`));
  assert.equal(ownerRows.length, 1);
  const authorized = ownerRows[0]!.accounts.filter(account => account.platform === 'zhihu' && account.provider === 'native' && account.status === 'connected' && account.label === '孔涛' && account.draftConnection?.permissionConfirmed);
  assert.equal(authorized.length, 1); const expectedUserId = authorized[0]!.draftConnection!.userId;
  const targetIdentitySha256 = sha(JSON.stringify(['zhihu', expectedUserId]));
  const path = join(root, 'live-draft.json');
  try { acceptance = acceptanceSchema.parse(JSON.parse((await privateBytes(path, 8192)).toString('utf8'))); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const frozen = { workspaceId, runId: generation.runId, draftId: draft.id, revision: 1 as const, generationManifestSha256: sha(generationBytes), sourceSha256: generation.sourceSha256, targetIdentitySha256, artifactHashes: { master: generation.artifacts.master.sha256, zhihu: generation.artifacts.zhihu.sha256, package: generation.artifacts.package.sha256 }, title: variant.title };
  if (acceptance) for (const key of Object.keys(frozen) as (keyof typeof frozen)[]) assert.deepEqual(acceptance[key], frozen[key]);
  const validateJob = (job: Job): void => {
    assert.equal(job.deliveryAction, 'save_draft'); assert.equal(job.platform, 'zhihu'); assert.equal(job.provider, 'native'); assert.equal(job.draftId, draft.id); assert.deepEqual(job.subject, { kind: 'article', id: draft.id, revision: 1 }); assert.equal(job.remoteId, null); assert.equal(job.remoteUrl, null); assert.equal(job.providerPostId, null); assert.ok(job.attempts <= 1);
    assert.ok(['scheduled', 'failed', 'submitting', 'needs_reconciliation', 'draft_saved', 'cancelled'].includes(job.status)); assert.deepEqual(job.snapshot?.draft, draft); assert.deepEqual(job.snapshot?.variant, variant);
    const account = (job.snapshot?.account); assert.ok(account); assert.equal(account.platform, 'zhihu'); assert.equal(account.provider, 'native'); assert.equal(account.label, '孔涛'); assert.equal(account.draftConnection?.permissionConfirmed, true); assert.equal(account.draftConnection?.userId, expectedUserId);
    if (acceptance) { assert.equal(job.id, acceptance.jobId); assert.equal(job.accountId, acceptance.accountId); assert.equal(job.contentHash, acceptance.contentHash); }
  };
  const persist = async (): Promise<void> => {
    assert.ok(acceptance); acceptance.updatedAt = new Date().toISOString(); const temporary = join(root!, `.live-draft.${randomUUID()}.tmp`); const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(acceptanceSchema.parse(acceptance))}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); const directory = await open(root!, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  };
  const existing = state.jobs[0];
  if (existing) {
    validateJob(existing); assert.equal(state.accounts.length, 1); assert.equal(state.accounts[0]?.id, existing.accountId);
    if (!acceptance) { acceptance = acceptanceSchema.parse({ version: 1, ...frozen, accountId: existing.accountId, jobId: existing.id, contentHash: existing.contentHash, operationIds: [], workerInvocations: 0, phase: 'observed', observedStatus: existing.status, observedAttempts: existing.attempts, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); await persist(); console.log(JSON.stringify({ ...safeSummary(existing), recoveredExistingJob: true, dispatchedThisInvocation: false })); return; }
    if (!retry) { console.log(JSON.stringify({ ...safeSummary(existing), inspectedOnly: true, dispatchedThisInvocation: false })); return; }
    assert.equal(existing.status, 'failed'); assert.equal(existing.attempts, 0); assert.equal(existing.submissionStartedAt, null); assert.ok(!existing.history.some(item => ['submitting', 'needs_reconciliation', 'draft_saved'].includes(item.status)));
  } else { assert.equal(acceptance, null); assert.equal(retry, false); }
  blockedAt = 'exclusive_acceptance';
  const lockPath = join(root, '.live-draft.lock'); const lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync();
    const latest = await readState(); assert.equal(latest.paused, true); assert.deepEqual(latest.jobs.map(job => job.id), existing ? [existing.id] : []);
    blockedAt = 'fresh_zhihu_identity';
    const identity = await draftAccountIdentity('zhihu'); assert.equal(identity.error, undefined); assert.equal(identity.isAuthenticated, true); assert.equal(identity.username, '孔涛'); assert.equal(identity.userId, expectedUserId);
    if (!existing) {
      blockedAt = 'isolated_account';
      const account = await bindDraftAccount('zhihu', { expectedUserId, permissionConfirmed: true }); assert.equal(account.label, '孔涛'); assert.equal(account.draftConnection?.userId, expectedUserId);
      blockedAt = 'prepare_draft';
      const prepared = await prepareRemoteDrafts(draft.id, { accountIds: [account.id], expectedRevision: 1 }); assert.equal(prepared.length, 1); const job = prepared[0]!; assert.equal(job.status, 'scheduled'); assert.equal(job.attempts, 0); validateJob(job);
      acceptance = acceptanceSchema.parse({ version: 1, ...frozen, accountId: account.id, jobId: job.id, contentHash: job.contentHash, operationIds: [], workerInvocations: 0, phase: 'prepared', observedStatus: job.status, observedAttempts: job.attempts, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      // Write the job identity before any operation can enqueue or dispatch a remote write.
      await persist();
    } else assert.equal(existing.snapshot?.account.draftConnection?.userId, identity.userId);
    assert.ok(acceptance); blockedAt = 'queue_same_job';
    await queueRemoteDraft(acceptance.jobId);
    const operations = await listOperations(draft.id); const pending = operations.filter(operation => operation.kind === 'publish' && operation.input.jobId === acceptance!.jobId && operation.status === 'queued');
    assert.equal(pending.length, 1); const expectedOperation = pending[0]!;
    assert.ok(!operations.some(operation => ['queued', 'running'].includes(operation.status) && operation.id !== expectedOperation.id));
    if (!acceptance.operationIds.includes(expectedOperation.id)) acceptance.operationIds.push(expectedOperation.id);
    acceptance.phase = 'worker_intent_saved'; acceptance.workerInvocations++; await persist();
    // The delivery role may claim another queue type; guard its handlers before invoking it.
    // Never initialize the daemon, scheduler, public dispatcher or model executor here.
    registerWorkerHandler('studio_operation', async (id, signal) => { assert.equal(id, expectedOperation.id); assert.ok(acceptance!.operationIds.includes(id)); const operation = await getOperation(id); assert.equal(operation.kind, 'publish'); assert.equal(operation.draftId, draft.id); assert.equal(operation.subjectKind, 'article'); assert.equal(operation.input.jobId, acceptance!.jobId); assert.equal(operation.input.expectedRevision, 1); const currentState = await readState(); assert.equal(currentState.paused, true); const current = currentState.jobs.find(job => job.id === acceptance!.jobId); assert.ok(current); validateJob(current); assert.equal(current.attempts, 0); await handleStudioOperation(id, signal); });
    registerWorkerHandler('legacy_publish', async () => { throw new Error('This acceptance refuses dispatcher ticks.'); });
    blockedAt = 'single_delivery_worker';
    assert.equal(process.env.STUDIO_WORKSPACE_ID, workspaceId); assert.equal(process.env.STUDIO_DATA_DIR, root); assert.equal(process.env.STUDIO_WORKER_ROLE, 'delivery');
    assert.equal(await runWorkerOnce(), true);
    blockedAt = 'result';
    const completed = await readState(); assert.equal(completed.paused, true); assert.equal(completed.accounts.length, 1); assert.equal(completed.jobs.length, 1); assert.equal(completed.drafts[0]?.approvedHash, null);
    const job = completed.jobs[0]!; validateJob(job); acceptance.phase = 'observed'; acceptance.observedStatus = job.status; acceptance.observedAttempts = job.attempts; await persist();
    console.log(JSON.stringify({ ...safeSummary(job), consumedOperationId: expectedOperation.id, workerCallsThisInvocation: 1, approved: false }));
    if (job.status !== 'draft_saved') process.exitCode = 1;
  } finally { await lock.close(); await unlink(lockPath); }
}
try { await main(); }
catch {
  let job: Job | undefined;
  if (readIsolatedState && workspaceId && process.env.STUDIO_WORKSPACE_ID === workspaceId) try { job = (await readIsolatedState()).jobs.find(item => item.id === acceptance?.jobId); } catch { /* Preserve uncertain state without exposing raw errors. */ }
  let summary: ReturnType<typeof safeSummary> | undefined; try { summary = safeSummary(job); } catch { /* Never echo malformed remote data. */ }
  console.error(JSON.stringify({ outcome: 'blocked_or_failed', blockedAt, ...summary, preserved: true, noAutomaticRetry: true, errorDetailsOmitted: true })); process.exitCode = 1;
}
