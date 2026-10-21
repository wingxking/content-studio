// Explicit Docker acceptance: actual isolated Supabase/pgmq, fixture model and extension only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { WebSocket } from 'ws';
import { z } from 'zod';

const { loadRuntimeEnvironment } = await import('../src/core/runtime-env.ts');
const { isTrustedDatabaseOrigin } = await import('../src/core/database.ts');
await loadRuntimeEnvironment();
if (process.env.STUDIO_CONTAINER !== 'true' || !process.env.SUPABASE_URL) throw new Error('Run explicitly inside configured local Docker networking.');
const database = new URL(process.env.SUPABASE_URL);
const kubernetesDatabase = process.env.STUDIO_ORCHESTRATOR === 'kubernetes' && database.hostname === 'host.orb.internal' && isTrustedDatabaseOrigin(database);
if (database.protocol !== 'http:' || !['kong', 'localhost', '127.0.0.1'].includes(database.hostname) && !kubernetesDatabase) throw new Error('This acceptance requires isolated local Supabase, never a hosted database.');
const environment = { ...process.env }; const originalFetch = globalThis.fetch; const workspaceId = randomUUID(); const directory = await mkdtemp(join(tmpdir(), 'ecosystem-acceptance-'));
process.env.STUDIO_WORKSPACE_ID = workspaceId; process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_LOCALFS_DIR = join(directory, 'localfs');
process.env.STUDIO_KNOWLEDGE_IMPORT_DIR = join(directory, 'knowledge-inbox'); process.env.STUDIO_WORKER_ROLE = 'article';
process.env.CODEX_HOME = join(directory, 'model-fixture'); delete process.env.STUDIO_MODEL_EXECUTOR_URL;
process.env.STUDIO_DRAFT_BRIDGE_CONFIG = join(directory, 'bridge/config.json');
await mkdir(process.env.CODEX_HOME); await mkdir(process.env.STUDIO_KNOWLEDGE_IMPORT_DIR);
await writeFile(join(process.env.CODEX_HOME, 'studio-models.json'), JSON.stringify({ models: [{ slug: 'ecosystem-fixture-model', display_name: 'Fixture model', description: 'No actual model execution.' }] }));
const { dbRequest, dbRpc } = await import('../src/core/database.ts');
const { KnowledgeStore } = await import('../src/core/knowledge.ts');
const { createKnowledgeApi } = await import('../src/server/knowledge-api.ts');
const { taskInputSchema } = await import('../src/core/task-model.ts');
const { createTask, enqueueTaskRun, getTaskRun, getTask, retryTaskRun, configureTaskRuntime, enqueueWork, updateTask } = await import('../src/core/tasks.ts');
const { listDiscoveryPromotions } = await import('../src/core/discovery-automation.ts');
const { mutateState, readState } = await import('../src/core/store.ts');
const { approveDraft } = await import('../src/core/pipeline.ts');
const { readDraftRevision } = await import('../src/core/artifacts.ts');
const { resolveGenerationContext } = await import('../src/core/generation-context.ts');
const { runWorkerOnce } = await import('../src/server/worker.ts');
const { createDraftBridge } = await import('../src/server/draft-bridge.ts');
const { draftConnectorApi } = await import('../src/server/draft-api.ts');
const { readDraftBridgeConfig } = await import('../src/core/draft-bridge-config.ts');
const { listOperations } = await import('../src/core/editor.ts');
const store = new KnowledgeStore(); const app = express(); app.use(express.json()); app.use('/api/knowledge', createKnowledgeApi(store)); app.use('/api', draftConnectorApi);
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(accept => server.once('listening', accept)); const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}/api`;
const post = async (path: string, body: unknown): Promise<unknown> => { const response = await fetch(`${origin}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); };
const bridge = createDraftBridge({ host: '127.0.0.1', wsPort: 0, httpPort: 0 }); let socket: WebSocket | undefined; let bridgeStarted = false; let draftWrites = 0;
const platforms = ['wechat', 'zhihu', 'bilibili'] as const;
const publicSource = { title: 'Explicit W3C fixture evidence', url: 'https://www.w3.org/', excerpt: 'Acceptance fixture source; no real web research or publishable claim.' };
const localOriginal = 'Frozen owner-supplied knowledge fixture: software workflows require review.'; let masters = 0; let failAdaptation = true;
try {
  const health = z.object({ database: z.literal(true), pgmq: z.literal(true) }).parse(await dbRpc('studio_runtime_health')); assert.equal(health.pgmq, true);
  // Read-only availability check for migration 016; no schema mutation or new scheduler.
  assert.deepEqual(await listDiscoveryPromotions(workspaceId), []);
  await mutateState(state => { state.paused = true; });
  const uploadedResponse = await fetch(`${origin}/knowledge/upload?name=uploaded.md`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'Additional immutable uploaded knowledge fixture.' }); assert.equal(uploadedResponse.status, 201); const uploaded = z.object({ id: z.uuid() }).parse(await uploadedResponse.json());
  await writeFile(join(process.env.STUDIO_KNOWLEDGE_IMPORT_DIR!, 'workflow.txt'), localOriginal);
  const importedResponse = await fetch(`${origin}/knowledge/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['workflow.txt'] }) }); assert.equal(importedResponse.status, 201); const imported = z.array(z.object({ id: z.uuid(), sha256: z.string() })).parse(await importedResponse.json())[0]!;
  configureTaskRuntime({
    resolveImagePaths: async () => [],
    research: async (_task, options) => { assert.equal(options?.knowledge?.[1]?.excerpt, localOriginal); return { sources: [publicSource], warnings: ['Deterministic research fixture; not real web verification.'] }; },
    structured: async (schema, _prompt, options) => { assert.equal(options?.knowledge?.[1]?.sha256, imported.sha256); return schema.parse({ questions: [{ question: 'How can software teams review practical workflows?', audienceNeed: 'Help software teams create useful documentation.', angle: 'Reviewable practical workflow steps.', sourceUrls: [publicSource.url], platforms: [...platforms], assessment: { status: 'allowed', reasons: ['Explicit permitted software fixture.'] } }], skipped: [] }); },
    generateMaster: async (_brief, _instruction, options) => { masters++; assert.equal(options.knowledge?.[1]?.excerpt, localOriginal); return { title: 'Isolated software workflow fixture', body: 'Reviewable acceptance fixture. Source: https://www.w3.org/' }; },
    adaptMaster: async (_brief, _master, platform, _instruction, options) => { assert.equal(options.knowledge?.[1]?.sha256, imported.sha256); assert.equal(options.knowledge?.[1]?.excerpt, localOriginal); if (failAdaptation && platform === 'zhihu') throw new Error('Intentional ecosystem adaptation failure.'); return { platform, title: 'Software workflow fixture', text: 'Reviewable fixture content. https://www.w3.org/', tags: [], mediaPaths: [], format: 'article' }; },
  });
  const parent = await createTask(taskInputSchema.parse({ title: 'Isolated ecosystem discovery', prompt: 'Find permitted useful software workflow questions using fixture evidence.', model: 'ecosystem-fixture-model', platforms: [...platforms], kind: 'discovery', knowledgeIds: [uploaded.id, imported.id], sources: [publicSource], frequency: { type: 'once', time: '09:00', timezone: 'UTC' }, enabled: false, discoveryAutomation: { enabled: true, maxDrafts: 1 } }));
  const parentRun = await enqueueTaskRun(parent.id); assert.equal(await runWorkerOnce(), true); assert.equal((await getTaskRun(parentRun.id)).status, 'succeeded');
  const promotion = (await listDiscoveryPromotions(workspaceId, parentRun.id))[0]!; assert.ok(promotion);
  const child = await getTask(promotion.childTaskId); assert.deepEqual(child.knowledgeIds, parent.knowledgeIds); assert.equal(child.frequency.type, 'once'); assert.equal(child.nextRunAt, null); assert.equal(child.discoveryAutomation.enabled, false);
  assert.equal((await getTaskRun(promotion.childRunId)).status, 'queued');
  assert.equal(await runWorkerOnce(), true); const partial = await getTaskRun(promotion.childRunId); assert.equal(partial.status, 'failed'); assert.ok(partial.master); assert.equal(partial.variants.length, 1);
  await writeFile(join(process.env.STUDIO_KNOWLEDGE_IMPORT_DIR!, 'workflow.txt'), 'Changed mounted knowledge must not alter an existing child run.'); const newer = (await store.import(['workflow.txt']))[0]!; assert.notEqual(newer.id, imported.id);
  failAdaptation = false; await retryTaskRun(promotion.childRunId); assert.equal(await runWorkerOnce(), true); const completed = await getTaskRun(promotion.childRunId); assert.equal(completed.status, 'succeeded'); assert.equal(completed.attempt, 2); assert.equal(masters, 1);
  // Immutable file exports now follow the committed article through its existing worker outbox.
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Drain only this random fixture workspace. */ }
  assert.equal(await runWorkerOnce(), false);
  const exports = (await listOperations(completed.draftId!)).filter(operation => operation.kind === 'article_export');
  assert.ok(exports.length > 0); assert.equal(exports.every(operation => operation.status === 'succeeded'), true);
  const draft = (await readState()).drafts.find(item => item.id === completed.draftId)!; assert.ok(draft); assert.equal(draft.generationKnowledgeRef, completed.id);
  assert.equal((await readDraftRevision(draft.id, draft.revision)).generationKnowledgeRef, completed.id); assert.equal((await resolveGenerationContext(draft)).knowledgeRef, completed.id);
  assert.equal((await store.readSnapshot(completed.id, child.knowledgeIds))[1]?.sha256, imported.sha256);
  const packageText = await readFile(join(directory, 'runs', completed.id, 'package.json'), 'utf8'); assert.ok(packageText.includes(imported.sha256)); assert.ok(!packageText.includes(localOriginal));
  const storedRuns = await dbRequest(`studio_task_runs?workspace_id=eq.${workspaceId}`); const storedWorkspace = await dbRequest(`content_studio_workspaces?id=eq.${workspaceId}`); assert.ok(!JSON.stringify([storedRuns, storedWorkspace]).includes(localOriginal));
  await enqueueWork('task_run', parentRun.id); assert.equal(await runWorkerOnce(), true); assert.equal((await listDiscoveryPromotions(workspaceId, parentRun.id)).length, 1); assert.equal(await runWorkerOnce(), false);
  const approved = await approveDraft(draft.id, draft.revision); assert.ok(approved.approvedHash);
  const ports = await bridge.start(); bridgeStarted = true; process.env.STUDIO_DRAFT_BRIDGE_URL = `http://127.0.0.1:${ports.httpPort}`;
  await post('publishing/draft-connectors/bridge', { extensionId: 'a'.repeat(32), extensionToken: 'ecosystem-fixture-only-token' }); const config = await readDraftBridgeConfig(); assert.ok(config);
  socket = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/connect?key=${config.pairingKey}`, { origin: `chrome-extension://${config.extensionId}` });
  socket.on('message', raw => {
    const message = z.object({ id: z.string(), method: z.string(), token: z.string(), params: z.record(z.string(), z.unknown()) }).parse(JSON.parse(raw.toString())); assert.equal(message.token, config.extensionToken); let result: unknown;
    if (message.method === 'studio.hello') result = { protocol: 'content-studio-drafts', version: 1, draftOnly: true, platforms: ['weixin', 'zhihu', 'bilibili'] };
    else if (message.method === 'checkAuth') result = { isAuthenticated: true, userId: `ecosystem-${workspaceId}-${String(message.params.platform)}`, username: 'Isolated fixture' };
    else { assert.equal(message.method, 'syncArticle'); draftWrites++; const parameters = z.object({ platforms: z.tuple([z.enum(['weixin', 'zhihu', 'bilibili'])]), article: z.object({ content: z.string() }) }).parse(message.params); assert.match(parameters.article.content, /https:\/\/www.w3.org/u); const platform = parameters.platforms[0]; const id = String(7000 + draftWrites); const postUrl = platform === 'weixin' ? `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=${id}&token=fixture-only-secret` : platform === 'zhihu' ? `https://zhuanlan.zhihu.com/p/${id}/edit` : `https://member.bilibili.com/platform/upload/text/edit?aid=${id}`; result = { execution: message.params.execution, results: [{ platform, success: true, draftOnly: true, postId: id, postUrl }] }; }
    socket?.send(JSON.stringify({ id: message.id, result }));
  });
  await new Promise<void>((accept, reject) => { socket!.once('open', accept); socket!.once('error', reject); });
  let connected = false;
  for (let attempt = 0; attempt < 100 && !connected; attempt++) {
    const response: Response = await fetch(`http://127.0.0.1:${ports.httpPort}/status`, { headers: { Authorization: `Bearer ${config.serviceKey}` } });
    assert.equal(response.status, 200); connected = z.object({ connected: z.boolean() }).parse(await response.json()).connected;
    if (!connected) await delay(10);
  }
  assert.equal(connected, true, 'Fixture extension must complete the local authentication probe.');
  const accountIds: string[] = []; for (const platform of platforms) accountIds.push(z.object({ id: z.uuid() }).parse(await post('publishing/draft-connectors/accounts', { platform, expectedUserId: `ecosystem-${workspaceId}-${platform === 'wechat' ? 'weixin' : platform}`, permissionConfirmed: true })).id);
  const deliveryInput = { accountIds, expectedRevision: approved.revision }; const operations = z.array(z.object({ id: z.uuid() })).parse(await post(`drafts/${approved.id}/save-drafts`, deliveryInput)); assert.equal(operations.length, 3);
  process.env.STUDIO_WORKER_ROLE = 'delivery'; for (let index = 0; index < 3; index++) assert.equal(await runWorkerOnce(), true);
  const state = await readState(); assert.equal(state.jobs.length, 3); assert.equal(state.paused, true); assert.equal(draftWrites, 3);
  for (const job of state.jobs) { assert.equal(job.status, 'draft_saved'); assert.equal(job.attempts, 1); assert.ok(job.draftReceipt?.id); assert.equal(job.remoteId, null); assert.equal(job.remoteUrl, null); }
  assert.ok(!JSON.stringify(state).includes('fixture-only-secret')); assert.equal((await listOperations(draft.id)).every(operation => operation.status === 'succeeded'), true);
  const repeated = z.array(z.object({ id: z.uuid() })).parse(await post(`drafts/${approved.id}/save-drafts`, deliveryInput)); assert.deepEqual(repeated, operations); assert.equal(await runWorkerOnce(), false); assert.equal(draftWrites, 3);
  console.log(JSON.stringify({ workspaceId, isolated: true, docker: true, kubernetes: process.env.STUDIO_ORCHESTRATOR === 'kubernetes', realSupabase: true, realPgmq: true, fixtureModelAndResearch: true, immutableKnowledgeSources: 3, discoveryPromotions: 1, retryAttempts: completed.attempt, masterGenerations: masters, verifiedLocalRevision: true, articleExportOperations: exports.length, frozenKnowledgeReused: true, adapterDraftReceipts: 3, duplicateWrites: 0, publicPosts: 0, realPlatformAcceptance: false }));
  // New task-policy acceptance uses the same isolated workspace and transport.
  // It cannot publish: the three native targets have no official public adapter.
  const { defaultBrandProfile } = await import('../src/contracts/brand.ts');
  const { taskInputSchema: configSchema } = await import('../src/core/task-model.ts');
  configureTaskRuntime({
    research: async () => ({ sources: [publicSource], warnings: [] }),
    generateMaster: async (_brief, instruction) => { assert.match(instruction, /Content Studio brand profile/u); return { title: 'Branded software fixture', body: 'Fixture source: https://www.w3.org/' }; },
    adaptMaster: async (_brief, _master, platform, instruction) => { assert.match(instruction, /Content Studio brand profile/u); return { platform, format: 'article', title: 'Branded software fixture', text: 'Fixture source: https://www.w3.org/', tags: [], mediaPaths: [] }; },
  });
  const autoConfig = configSchema.parse({ title: 'Automatic brand fixture', prompt: 'Explain a permitted software workflow using supplied fixture sources.', model: 'ecosystem-fixture-model', platforms: [...platforms], kind: 'content', topicOrigin: 'editorial', sources: [publicSource], brand: defaultBrandProfile, frequency: { type: 'once', time: '09:00', timezone: 'UTC' }, enabled: true, delivery: { mode: 'automatic', accountIds, authorized: true, publicationTime: '18:00', dayOffset: 0, onceAt: new Date(Date.now() + 3600000).toISOString() } });
  const autoTask = await createTask(autoConfig); assert.ok(autoTask.authorization);
  process.env.STUDIO_WORKER_ROLE = 'article'; const autoRun = await enqueueTaskRun(autoTask.id);
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Isolated article/export work only. */ }
  const autoCompleted = await getTaskRun(autoRun.id); assert.equal(autoCompleted.status, 'succeeded'); assert.equal(autoCompleted.warnings.length, 3); assert.deepEqual(autoCompleted.taskSnapshot.brand, defaultBrandProfile);
  process.env.STUDIO_WORKER_ROLE = 'delivery';
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Three native drafts, no public posts. */ }
  assert.equal(draftWrites, 6); assert.equal((await readState()).jobs.length, 6);
  process.env.STUDIO_WORKER_ROLE = 'article'; await enqueueWork('task_run', autoRun.id);
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Repair must reuse the original jobs. */ }
  process.env.STUDIO_WORKER_ROLE = 'delivery'; assert.equal(await runWorkerOnce(), false); assert.equal(draftWrites, 6);
  const revokedRun = await enqueueTaskRun(autoTask.id);
  const revoked = await updateTask(autoTask.id, { ...autoConfig, enabled: false }); assert.equal(revoked.authorization, undefined);
  process.env.STUDIO_WORKER_ROLE = 'article';
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Old frozen grant cannot authorize a new write. */ }
  assert.ok((await getTaskRun(revokedRun.id)).warnings.some(warning => /revoked or changed/u.test(warning)));
  process.env.STUDIO_WORKER_ROLE = 'delivery'; assert.equal(await runWorkerOnce(), false); assert.equal(draftWrites, 6);
  const lateTask = await createTask({ ...autoConfig, delivery: { ...autoConfig.delivery!, onceAt: new Date(Date.now() - 60000).toISOString() } });
  const lateRun = await enqueueTaskRun(lateTask.id); process.env.STUDIO_WORKER_ROLE = 'article';
  for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Missed publication times never catch up. */ }
  assert.ok((await getTaskRun(lateRun.id)).warnings.some(warning => /missed/u.test(warning)));
  assert.equal((await readState()).jobs.length, 6); assert.equal(draftWrites, 6);
  console.log(JSON.stringify({ taskAutomation: true, brandSnapshot: true, nativeDraftFallbacks: 3, revokedGrantBlocked: true, missedTimeBlocked: true, duplicateWrites: 0, publicPosts: 0 }));
  if (process.argv.includes('--confirm-interactive-fixture')) await (await import('./workflow-web-fixture.ts')).awaitWorkflowWebFixture(directory, workspaceId);
  // Exercise the already-supported API adapter with deterministic HTTP responses.
  // Only requests to the fixture origin are intercepted; nothing reaches Postiz.
  let providerPosts = 0; let loseResponse = false;
  process.env.POSTIZ_API_KEY = 'isolated-fixture-only'; process.env.POSTIZ_BASE_URL = 'https://postiz-fixture.invalid/public/v1';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'postiz-fixture.invalid') return originalFetch(input, init);
    if (url.pathname.endsWith('/integrations')) return Response.json([{ id: 'auto-integration', name: 'Fixture account', identifier: 'linkedin', disabled: false }]);
    if (url.pathname === '/public/v1/posts' && init?.method !== 'POST') return Response.json({ posts: [{ id: 'fixture-post-1', content: 'Scheduled API fixture. Source: https://www.w3.org/', publishDate: new Date().toISOString(), releaseURL: 'https://www.linkedin.com/feed/update/urn:li:activity:123456789/', state: 'PUBLISHED', integration: { id: 'auto-integration', providerIdentifier: 'linkedin' } }] });
    assert.equal(url.pathname, '/public/v1/posts'); assert.equal(init?.method, 'POST'); providerPosts++;
    if (loseResponse) throw new TypeError('Intentional fixture response loss');
    return Response.json([{ postId: `fixture-post-${providerPosts}`, integration: 'auto-integration' }]);
  };
  const linkedInId = randomUUID();
  await mutateState(state => { state.paused = false; state.accounts.push({ id: linkedInId, platform: 'linkedin', provider: 'postiz', integrationId: 'auto-integration', label: 'Fixture API account', status: 'connected', note: 'Isolated fixture', verifiedAt: new Date().toISOString() }); });
  configureTaskRuntime({ research: async () => ({ sources: [publicSource], warnings: [] }), generateMaster: async () => ({ title: 'API fixture', body: 'Source: https://www.w3.org/' }), adaptMaster: async (brief, _master, platform) => ({ platform, format: 'text', title: brief.topic, text: `${brief.topic}. Source: https://www.w3.org/`, tags: [], mediaPaths: [] }) });
  const { runDueJobs } = await import('../src/core/pipeline.ts');
  const generateAutomatic = async (title: string) => {
    const config = configSchema.parse({ ...autoConfig, title, platforms: ['linkedin'], delivery: { ...autoConfig.delivery!, accountIds: [linkedInId], onceAt: new Date(Date.now() + 5000).toISOString() } });
    const task = await createTask(config); const run = await enqueueTaskRun(task.id); process.env.STUDIO_WORKER_ROLE = 'article';
    for (let index = 0; index < 20 && await runWorkerOnce(); index++) { /* Production + exports. */ }
    const completed = await getTaskRun(run.id); assert.equal(completed.status, 'succeeded'); assert.deepEqual(completed.warnings, []);
    const job = (await readState()).jobs.find(item => item.draftId === completed.draftId)!; assert.ok(job?.automation); assert.equal(job.automation.authorizationId, task.authorization!.id);
    return { task, config, job };
  };
  const scheduled = await generateAutomatic('Scheduled API fixture');
  assert.equal((await runDueJobs()).length, 0); assert.equal(providerPosts, 0);
  await delay(Math.max(0, Date.parse(scheduled.job.scheduledAt) - Date.now() + 30));
  await runDueJobs(); assert.equal(providerPosts, 1); assert.equal((await readState()).jobs.find(job => job.id === scheduled.job.id)?.status, 'queued');
  await runDueJobs(); assert.equal(providerPosts, 1);
  const { reconcileJob } = await import('../src/core/pipeline.ts');
  assert.equal((await reconcileJob(scheduled.job.id)).status, 'published');
  const revokePublic = await generateAutomatic('Revoked API fixture');
  await updateTask(revokePublic.task.id, { ...revokePublic.config, enabled: false });
  await mutateState(state => { state.jobs.find(job => job.id === revokePublic.job.id)!.scheduledAt = new Date(Date.now() - 1).toISOString(); });
  await runDueJobs(); assert.equal(providerPosts, 1); assert.equal((await readState()).jobs.find(job => job.id === revokePublic.job.id)?.status, 'failed');
  const uncertain = await generateAutomatic('Unknown API fixture'); loseResponse = true;
  await delay(Math.max(0, Date.parse(uncertain.job.scheduledAt) - Date.now() + 30));
  await runDueJobs(); assert.equal(providerPosts, 2); assert.equal((await readState()).jobs.find(job => job.id === uncertain.job.id)?.status, 'needs_reconciliation');
  await runDueJobs(); assert.equal(providerPosts, 2);
  console.log(JSON.stringify({ scheduledApiFixture: true, submissionRequests: providerPosts, replayRequests: 0, revokedPublicSubmissionBlocked: true, unknownSubmissionNotRetried: true, realExternalPublications: 0 }));
  globalThis.fetch = originalFetch;
} finally {
  globalThis.fetch = originalFetch;
  socket?.terminate(); if (bridgeStarted) await bridge.close(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
  const cleanupFailures: string[] = [];
  for (let index = 0; index < 30; index++) { const claim = z.object({ msgId: z.number(), token: z.uuid() }).nullable().parse(await dbRpc('studio_claim_role_work', { p_workspace: workspaceId, p_role: 'all' }).catch(() => null)); if (!claim) break; await dbRpc('studio_ack_work', { p_workspace: workspaceId, p_msg: claim.msgId, p_token: claim.token }).catch(() => { cleanupFailures.push('fixture_queue'); }); }
  for (const table of ['studio_discovery_promotions', 'studio_run_events', 'studio_task_runs', 'studio_tasks', 'studio_video_projects', 'studio_operations', 'studio_revisions', 'studio_editor_state', 'studio_account_execution_leases', 'studio_queue_leases', 'studio_article_commands', 'content_studio_workspaces']) {
    const path = `${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspaceId}`;
    try { await dbRequest(path, { method: 'DELETE' }); assert.deepEqual(await dbRequest(path), []); } catch { cleanupFailures.push(table); }
  }
  await rm(directory, { recursive: true, force: true }); process.env = environment;
  if (cleanupFailures.length) { console.error(JSON.stringify({ fixtureCleanupFailed: cleanupFailures, workspaceId })); process.exitCode = 1; }
}
