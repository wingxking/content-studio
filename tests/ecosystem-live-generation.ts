// Manual, real-model generation only. Never invoked by the unit test glob.
// Run in a one-off Docker application process with the configured private runtime environment,
// real model executor and a separate persistent bind mounted at /acceptance-live.
// New: node --import tsx tests/ecosystem-live-generation.ts --confirm-isolated-generation --root /acceptance-live --model <catalog-id>
// Retry: same command with --retry --root /acceptance-live/zhihu-live-<suffix> (model is frozen).
// No approval, account pairing, remote draft save, public delivery, scheduler or automatic cleanup.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, realpath, rename, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const retry = args.includes('--retry');
if (!args.includes('--confirm-isolated-generation') || !value('--root') || (!retry && !value('--model'))) throw new Error('Explicit Docker execution requires --confirm-isolated-generation --root <separate persistent bind> and --model <catalog-id>; retry uses --retry --root <existing isolated run directory>.');
const { loadRuntimeEnvironment } = await import('../src/core/runtime-env.ts');
await loadRuntimeEnvironment();
if (process.env.STUDIO_CONTAINER !== 'true' || !process.env.STUDIO_MODEL_EXECUTOR_URL) throw new Error('Run in a one-off Docker process with the existing real model executor; native or mocked generation is forbidden.');
const database = new URL(process.env.SUPABASE_URL ?? '');
if (database.protocol !== 'http:' || !['kong', 'localhost', '127.0.0.1'].includes(database.hostname)) throw new Error('Only the configured local Docker Supabase is permitted.');
const ownerWorkspace = z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
const ownerRoots = [resolve(process.env.STUDIO_DATA_DIR ?? '/data'), resolve(process.env.STUDIO_LOCALFS_DIR ?? '/data/media/localfs'), resolve('/data'), resolve(process.cwd())];
const selectedRoot = value('--root')!;
if (!isAbsolute(selectedRoot) || /[\u0000-\u001f]/u.test(selectedRoot)) throw new Error('Provide an absolute private acceptance bind directory.');
// The operator supplies an existing persistent bind; resolve before creating anything.
const parentRoot = await realpath(selectedRoot); if (!(await stat(parentRoot)).isDirectory()) throw new Error('The acceptance bind must be an existing directory.');
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
if (ownerRoots.some(ownerRoot => overlaps(parentRoot, ownerRoot)) || parentRoot === '/tmp' || parentRoot.startsWith('/tmp/')) throw new Error('Acceptance storage must be persistent and separate from owner data, configuration and repository paths.');
const root = retry ? parentRoot : await mkdtemp(join(parentRoot, 'zhihu-live-'));
const artifactSchema = z.object({ path: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const manifestSchema = z.object({ version: z.literal(1), workspaceId: z.uuid(), model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u), createdAt: z.iso.datetime(), sourceId: z.uuid().optional(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), taskId: z.uuid().optional(), runId: z.uuid().optional(), artifacts: z.object({ master: artifactSchema, zhihu: artifactSchema, package: artifactSchema }).optional() }).strict();
type Manifest = z.infer<typeof manifestSchema>;
const manifestPath = join(root, 'live-generation.json');
let manifest: Manifest;
if (retry) {
  const info = await stat(manifestPath); if (!info.isFile() || info.size > 8192) throw new Error('The isolated acceptance manifest is missing or invalid.');
  manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (value('--model') && value('--model') !== manifest.model) throw new Error('Retry cannot change the frozen model. Start a separate acceptance run for a different model.');
} else manifest = manifestSchema.parse({ version: 1, workspaceId: randomUUID(), model: value('--model'), createdAt: new Date().toISOString() });
if (manifest.workspaceId === ownerWorkspace) throw new Error('Refusing to reuse the owner workspace.');
const persist = async (): Promise<void> => {
  const temporary = join(root, `.live-generation.${randomUUID()}.tmp`); const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(manifest)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, manifestPath); const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
};
await persist();
process.env.STUDIO_WORKSPACE_ID = manifest.workspaceId; process.env.STUDIO_DATA_DIR = root; process.env.STUDIO_LOCALFS_DIR = join(root, 'localfs'); process.env.STUDIO_WORKER_ROLE = 'article';
delete process.env.STUDIO_KNOWLEDGE_IMPORT_DIR;
console.log(JSON.stringify({ warning: 'ISOLATED REAL GENERATION ONLY: owner workspace is excluded; no approval, pairing, remote write, public publication or scheduler is requested. Keep this separately mounted directory for review or retry.', root, workspaceId: manifest.workspaceId, retry, preserved: true }));
const { dbRpc } = await import('../src/core/database.ts');
const { modelExecutorOrigin } = await import('../src/core/model-executor.ts');
const { listModels } = await import('../src/core/models.ts');
const { KnowledgeStore } = await import('../src/core/knowledge.ts');
const { taskInputSchema } = await import('../src/core/task-model.ts');
const { createTask, getTask, enqueueTaskRun, getTaskRun, retryTaskRun } = await import('../src/core/tasks.ts');
const { runWorkerOnce } = await import('../src/server/worker.ts');
const { mutateState, readState } = await import('../src/core/store.ts');
const { readDraftRevision } = await import('../src/core/artifacts.ts');
const { resolveGenerationContext } = await import('../src/core/generation-context.ts');
type Stage = 'initialization' | 'readiness' | 'catalog' | 'database' | 'workspace' | 'knowledge' | 'task' | 'enqueue' | 'generation' | 'artifact_validation';
let blockedAt: Stage = 'initialization'; let workspaceInitializationAttempted = false;
const artifactEvidence = async (path: string): Promise<z.infer<typeof artifactSchema>> => {
  const resolved = await realpath(path); assert.ok(resolved.startsWith(`${root}${sep}`), 'Generated artifact escaped the isolated root.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const info = await file.stat(); assert.ok(info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024, 'Generated artifact must be a nonempty bounded regular file.'); const bytes = await file.readFile(); assert.equal(bytes.length, info.size, 'Generated artifact changed during verification.'); return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
  finally { await file.close(); }
};

// Synthesized public software principles, not a report of a real backup or a verified product test.
const evidence = `# Software backup and immutable revision principles — synthetic acceptance source
This short source is intentionally public, non-private instructional fixture material.
A software backup should identify which data and configuration it contains. A backup that was never restored is not evidence of successful recovery.
Restoration can be checked in a separate test instance so the original instance remains available. Compare the restored files with their recorded cryptographic hashes and inspect the application state.
A SHA-256 digest identifies exact file bytes; a changed file has a different content digest in ordinary integrity checks. Matching digests establish byte integrity, not factual truth, copyright permission or platform approval.
Keep a selected content revision and its evidence references fixed while reviewing it. Import changed evidence as a new revision; existing generation retries should continue from their original snapshot.
Generate content separately from publishing. A local generated article is a reviewable draft and does not establish an external saved draft or a published post.
These are generic engineering principles, not guaranteed recovery outcomes. No personal experience, benchmark, real backup completion, product feature, live account permission or remote publication is asserted.
`;
try {
  blockedAt = 'readiness';
  const readiness = await fetch(`${modelExecutorOrigin()}/readyz`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  const ready = z.object({ ready: z.boolean() }).safeParse(await readiness.json());
  if (!readiness.ok || !ready.success || !ready.data.ready) throw new Error('Model executor authentication is not ready. Complete container login before explicitly retrying.');
  blockedAt = 'catalog';
  assert.ok((await listModels()).some(model => model.id === manifest.model), 'Choose an available model from the real executor catalog.');
  blockedAt = 'database';
  z.object({ database: z.literal(true), pgmq: z.literal(true) }).parse(await dbRpc('studio_runtime_health'));
  blockedAt = 'workspace'; workspaceInitializationAttempted = true;
  const state = await readState(); assert.equal(state.accounts.length, 0, 'The isolated generation workspace must have no accounts.'); assert.equal(state.jobs.length, 0, 'The isolated generation workspace must have no deliveries.');
  await mutateState(current => { current.paused = true; });
  blockedAt = 'knowledge';
  const store = new KnowledgeStore();
  if (!manifest.sourceId) { const source = await store.upload('backup-revision-principles.md', Buffer.from(evidence)); manifest.sourceId = source.id; manifest.sourceSha256 = source.sha256; await persist(); }
  const source = await store.get(manifest.sourceId); assert.equal(source.sha256, manifest.sourceSha256);
  blockedAt = 'task';
  if (!manifest.taskId) {
    const task = await createTask(taskInputSchema.parse({ title: '软件备份为什么要验证恢复并固定内容修订？', prompt: '用中文生成可供人工审查的知乎专栏文章，解释软件备份恢复验证与固定证据修订的实用原则。只根据选定合成知识来源写作，明确其为通用工程说明；不得写成本人做过恢复实验、实测某产品或已获得平台许可。给出具体检查步骤、边界与限制，引用来源名称和 SHA-256。知乎版本必须为 format article。只生成母稿和知乎文章；不浏览、不创建视频、不保存远端草稿、不发布。', audience: '需要理解备份与内容修订的中文软件使用者', angle: '用独立测试实例与固定证据解释可复核的检查过程', model: manifest.model, platforms: ['zhihu'], sources: [], knowledgeIds: [source.id], assetIds: [], kind: 'content', topicOrigin: 'editorial', frequency: { type: 'once', time: '09:00', timezone: 'Asia/Singapore' }, enabled: false, discoveryAutomation: { enabled: false, maxDrafts: 1 } }));
    manifest.taskId = task.id; await persist();
  }
  const task = await getTask(manifest.taskId); assert.equal(task.enabled, false); assert.equal(task.kind, 'content'); assert.equal(task.nextRunAt, null); assert.deepEqual(task.platforms, ['zhihu']); assert.deepEqual(task.knowledgeIds, [source.id]); assert.deepEqual(task.sources, []); assert.equal(task.discoveryAutomation.enabled, false); assert.equal(task.model, manifest.model);
  blockedAt = 'enqueue';
  if (!manifest.runId) { const run = await enqueueTaskRun(task.id, { requestId: task.id }); manifest.runId = run.id; await persist(); }
  let run = await getTaskRun(manifest.runId);
  assert.equal(process.env.STUDIO_WORKSPACE_ID, manifest.workspaceId); assert.equal(process.env.STUDIO_DATA_DIR, root); assert.equal(process.env.STUDIO_LOCALFS_DIR, join(root, 'localfs')); assert.equal(process.env.STUDIO_WORKER_ROLE, 'article'); assert.equal(process.env.STUDIO_KNOWLEDGE_IMPORT_DIR, undefined);
  assert.equal(run.taskId, task.id); assert.equal(run.taskSnapshot.id, task.id); assert.equal(run.taskSnapshot.model, manifest.model); assert.equal(run.taskSnapshot.kind, 'content'); assert.equal(run.taskSnapshot.enabled, false); assert.equal(run.taskSnapshot.nextRunAt, null); assert.equal(run.taskSnapshot.topicOrigin, 'editorial');
  assert.deepEqual(run.taskSnapshot.platforms, ['zhihu']); assert.deepEqual(run.taskSnapshot.knowledgeIds, [source.id]); assert.deepEqual(run.taskSnapshot.sources, []); assert.deepEqual(run.taskSnapshot.assetIds, []); assert.deepEqual(run.taskSnapshot.discoveryAutomation, { enabled: false, maxDrafts: 1 });
  assert.equal(run.taskSnapshot.frequency.type, 'once'); assert.equal(run.taskSnapshot.frequency.onceAt, undefined); assert.deepEqual(run.taskSnapshot.frequency, task.frequency); assert.equal(run.taskSnapshot.prompt, task.prompt); assert.equal(run.taskSnapshot.title, task.title); assert.equal(run.taskSnapshot.audience, task.audience); assert.equal(run.taskSnapshot.angle, task.angle);
  if (retry && ['failed', 'cancelled'].includes(run.status)) run = await retryTaskRun(run.id);
  blockedAt = 'generation';
  // An interrupted one-off process can leave an active run. Explicit retry consumes only its
  // original delivery after queue/run leases expire; it never enqueues a duplicate occurrence.
  if (run.status === 'queued' || retry && ['researching', 'generating'].includes(run.status)) { assert.equal(await runWorkerOnce(), true, 'The original isolated queue delivery is unavailable or still leased; retain this directory and retry after its lease expires.'); run = await getTaskRun(run.id); }
  if (run.status !== 'succeeded') {
    console.error(JSON.stringify({ status: run.status, blockedAt, phase: run.phase, runId: run.id, workspaceId: manifest.workspaceId, root, preserved: true, action: 'Keep the isolated run and knowledge snapshot. Fix the reported run blocker, then execute --retry against this root; no automatic retry or cleanup occurs.' })); process.exitCode = 1;
  } else {
    blockedAt = 'artifact_validation';
    const completedState = await readState(); const draft = completedState.drafts.find(item => item.id === run.draftId); assert.ok(draft); assert.equal(completedState.accounts.length, 0); assert.equal(completedState.jobs.length, 0); assert.equal(draft.approvedHash, null); assert.equal(draft.generationKnowledgeRef, run.id); assert.equal(draft.variants.length, 1); assert.equal(draft.variants[0]?.platform, 'zhihu'); assert.equal(draft.variants[0]?.format, 'article');
    assert.equal((await readDraftRevision(draft.id, draft.revision)).generationKnowledgeRef, run.id); assert.equal((await resolveGenerationContext(draft)).knowledgeRef, run.id); const snapshot = await store.readSnapshot(run.id, [source.id]); assert.equal(snapshot[0]?.sha256, source.sha256);
    const artifacts = { master: await artifactEvidence(join(root, 'runs', run.id, 'master.md')), zhihu: await artifactEvidence(join(root, 'runs', run.id, 'zhihu.md')), package: await artifactEvidence(join(root, 'runs', run.id, 'package.json')) };
    const exported = z.object({ id: z.uuid(), draftId: z.uuid(), status: z.literal('succeeded'), knowledge: z.object({ ref: z.uuid(), sources: z.array(z.object({ id: z.uuid(), sha256: z.string() })) }) }).parse(JSON.parse(await readFile(artifacts.package.path, 'utf8'))); assert.equal(exported.id, run.id); assert.equal(exported.draftId, draft.id); assert.equal(exported.knowledge.ref, run.id); assert.equal(exported.knowledge.sources.length, 1); assert.equal(exported.knowledge.sources[0]?.id, source.id); assert.equal(exported.knowledge.sources[0]?.sha256, source.sha256);
    manifest.artifacts = artifacts; await persist();
    console.log(JSON.stringify({ status: 'succeeded', realModelExecutor: true, workspaceId: manifest.workspaceId, root, runId: run.id, draftId: draft.id, revision: draft.revision, sourceId: source.id, sourceSha256: source.sha256, generationKnowledgeRef: draft.generationKnowledgeRef, artifacts, approved: false, remoteDraftWrites: 0, publicPosts: 0, preservedForReview: true, editorialAssessment: 'model-reported; requires human review' }));
  }
} catch {
  console.error(JSON.stringify({ status: 'blocked_or_failed', blockedAt, workspaceInitializationAttempted, workspaceId: manifest.workspaceId, root, taskId: manifest.taskId ?? null, runId: manifest.runId ?? null, preserved: true, action: 'Inspect the reported safe stage and this isolated run through trusted local tools. Keep its manifest, data and immutable knowledge for explicit --retry. No caught errors, model logs, credentials or generated text are printed.' })); process.exitCode = 1;
}
