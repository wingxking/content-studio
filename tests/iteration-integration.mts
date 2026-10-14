import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { uploadAsset, resolveAssetPath } from '../src/core/assets.ts';
import { adaptArticleImage } from '../src/core/article-tools.ts';
import { createDraft, approveDraft, verifyDraftApproval } from '../src/core/pipeline.ts';
import { attachAssets, saveEditedDraft, getOperation } from '../src/core/editor.ts';
import { dbRequest } from '../src/core/database.ts';
import { readState, mutateState } from '../src/core/store.ts';
import { jobSchema, accountSchema } from '../src/core/model.ts';
import { queueMetricCollection, getJobMetrics } from '../src/core/metrics.ts';
import { runWorkerOnce } from '../src/server/worker.ts';
import { browserPublisherConfig, browserPublisherStatus } from '../src/core/browser-publisher.ts';
assert.equal(process.env.STUDIO_CONTAINER, 'true', 'Execute this acceptance only inside the Docker application runtime.');
const workspace = randomUUID(); process.env.STUDIO_WORKSPACE_ID = workspace;
process.env.STUDIO_DATA_DIR = `/data/media/iteration-${workspace}`;
process.env.STUDIO_LOCALFS_DIR = `${process.env.STUDIO_LOCALFS_DIR ?? '/data/media/localfs'}/iteration-${workspace}`;
process.env.STUDIO_WORKER_ROLE = 'delivery';
const now = new Date().toISOString(); const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
 await mutateState(state => { state.paused = true; });
 const png = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
 const original = await uploadAsset('isolated-original.png', png);
 const result = await adaptArticleImage(original.asset.id, { preset: 'finance-community-v1', platform: 'xueqiu' });
 const cached = await adaptArticleImage(original.asset.id, { preset: 'finance-community-v1', platform: 'xueqiu' });
 assert.equal(cached.asset.id, result.asset.id); assert.ok('rendition' in cached && cached.rendition.cached); assert.equal(result.asset.mime, 'image/jpeg');
 const path = await resolveAssetPath(result.asset.id); const bytes = await readFile(path);
 assert.equal(sha(bytes), result.asset.hash); assert.deepEqual(await readFile(await resolveAssetPath(original.asset.id)), png);
 const metadata = await sharp(bytes).metadata(); assert.equal(metadata.width, 1600); assert.equal(metadata.height, 800);
 const variant = { platform: 'xueqiu' as const, title: 'Isolated fixture', text: 'First paragraph.\n\nSecond paragraph.', tags: [], mediaPaths: [], format: 'image_note' as const, finance: { symbols: [{ market: 'SH' as const, code: '600000', name: 'Owner-reviewed fixture' }] } };
 const draft = await createDraft({ topic: 'Original fixture', audience: 'Internal acceptance', angle: 'No publication', sources: [{ title: 'Local fixture', url: 'https://example.com/fixture', excerpt: 'Original acceptance fixture.' }], platforms: ['xueqiu'] }, { title: variant.title, body: variant.text, variants: [variant] });
 await approveDraft(draft.id); const attached = await attachAssets(draft.id, 'xueqiu', [result.asset.id], draft.revision);
 assert.equal(attached.revision, 2); assert.equal(attached.approvedHash, null);
 const approved = await approveDraft(draft.id); await writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]));
 await assert.rejects(verifyDraftApproval(approved)); await writeFile(path, bytes);
 const configuration = await browserPublisherConfig(); const available = (await browserPublisherStatus()).available === true;
 const account = accountSchema.parse({ id: randomUUID(), platform: 'xueqiu', provider: 'native', label: 'Isolated fixture account', integrationId: '', status: 'connected', note: 'Fixture only', verifiedAt: now, physicalIdentity: { id: `fixture:${configuration.sessionId}`, verification: 'fixture', verifiedAt: now } });
 const makeJob = (video: boolean) => jobSchema.parse({ id: randomUUID(), draftId: video ? null : draft.id, subject: { kind: video ? 'video' : 'article', id: video ? randomUUID() : draft.id, revision: 2 }, platform: 'xueqiu', accountId: account.id, approvedHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), snapshot: { account, variant: approved.variants[0], ...(video ? { video: { projectId: randomUUID(), revision: 2, renderId: randomUUID(), renderHash: 'c'.repeat(64), approvalHash: 'd'.repeat(64), sources: [] } } : { draft: approved }), executorKind: 'browser-fixture', executorVersion: 1, executorSessionId: configuration.sessionId, executorAccountId: '123' }, status: 'delivered', scheduledAt: now, createdAt: now, provider: 'native', remoteId: 'fixture-456', remoteUrl: null, attempts: 1, error: null, metrics: [{ at: now, views: 7, likes: null, comments: null, clicks: null, notes: 'Preserved historical manual observation' }], history: [{ at: now, status: 'delivered', message: 'Explicit isolated fixture confirmation' }] });
 const article = makeJob(false); const video = makeJob(true);
 await mutateState(state => { state.accounts.push(account); state.jobs.push(article, video); });
 // The current article revision changes after the work snapshot; collection must still use the historical job.
 await saveEditedDraft(draft.id, { ...approved, variants: approved.variants.map(item => ({ ...item, title: 'Newer current article title' })) }, approved.revision);
 for (const job of [article, video]) {
  const queued = await queueMetricCollection(job.id); assert.equal((await queueMetricCollection(job.id)).operationId, queued.operationId);
  assert.equal(await runWorkerOnce(), true); const operation = await getOperation(queued.operationId);
  const metrics = await getJobMetrics(job.id); const automated = metrics.observations.filter(value => value.source === 'fixture');
  assert.equal(metrics.observations.filter(value => value.source === 'historical_manual').length, 1);
  if (available) { assert.equal(operation.status, 'succeeded'); assert.equal(automated.length, 1); assert.equal(automated[0]?.values.views, 0); assert.equal(automated[0]?.values.comments, null); }
  else { assert.equal(operation.status, 'failed'); assert.equal(automated.length, 0); assert.equal(metrics.attempts.length, 1); }
 }
 assert.equal((await readState()).drafts[0]?.revision, 3);
 console.log(JSON.stringify({ isolatedWorkspace: workspace, originalUnchanged: true, renditionCacheReused: true, finalImage: '1600x800 JPEG', approvalInvalidatedOnAttach: true, changedBytesRejected: true, queueSlotDeduplicated: true, historicalArticleAndIndependentVideo: true, metrics: available ? 'real Docker fixture zero/null observations' : 'unavailable executor recorded as errors with no observation', manualHistoryPreserved: true, publicPosts: 0 }));
} finally {
 // Only this newly-created workspace and its private fixture files are removed.
 for (const table of ['studio_metric_observations', 'studio_metric_attempts', 'studio_metric_polls', 'studio_operations', 'studio_revisions', 'studio_editor_state', 'studio_asset_renditions', 'studio_assets', 'studio_account_execution_leases']) await dbRequest(`${table}?workspace_id=eq.${workspace}`, { method: 'DELETE' });
 await dbRequest(`content_studio_workspaces?id=eq.${workspace}`, { method: 'DELETE' });
 await rm(process.env.STUDIO_DATA_DIR, { recursive: true, force: true }); await rm(process.env.STUDIO_LOCALFS_DIR, { recursive: true, force: true });
}
