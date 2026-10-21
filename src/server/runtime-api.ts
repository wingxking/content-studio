import { Router } from 'express';
import { z } from 'zod';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dbRequest } from '../core/database.ts';
import { doctor } from '../core/doctor.ts';
import { draftBridgeStatus } from '../core/draft-connectors.ts';
import { knowledgeStore } from '../core/knowledge.ts';
import { localfsDirectory } from '../core/localfs.ts';
import { listDiscoveryPromotions } from '../core/discovery-automation.ts';
import { readState } from '../core/store.ts';
import { publishingCapabilities } from '../core/publishing-capabilities.ts';
import { expectedYouTubeChannelId } from '../core/youtube.ts';
import { summarizeRuntimeActivity, summarizeRuntimeSetup, type KnowledgeSummary } from '../core/runtime-overview.ts';
import { readRuntimeRelease } from '../core/runtime-release.ts';
import { runtimeObservation, startRuntimeObservation, stopRuntimeObservation } from '../core/runtime-observation.ts';

export const runtimeApi = Router();
export async function runtimeKnowledgeSummary(store = knowledgeStore()): Promise<KnowledgeSummary> {
  const [mount, sources] = await Promise.all([store.mount().catch(() => null), store.list()]);
  return { configured: Boolean(process.env.STUDIO_KNOWLEDGE_IMPORT_DIR), available: mount?.available ?? false, importedSources: sources.length, mountFiles: mount?.files.length ?? 0 };
}
export async function runtimeSetup() {
  const [readinessResult, stateResult, bridgeResult, knowledgeResult, localfsResult] = await Promise.allSettled([doctor(), readState(), draftBridgeStatus(), runtimeKnowledgeSummary(), access(localfsDirectory(), constants.W_OK)]);
  const readiness = readinessResult.status === 'fulfilled' ? { ...readinessResult.value, localfsWritable: localfsResult.status === 'fulfilled' } : null;
  const state = stateResult.status === 'fulfilled' ? stateResult.value : null;
  const bridge = bridgeResult.status === 'fulfilled' ? bridgeResult.value : null;
  const knowledge = knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null;
  const capabilities = state ? publishingCapabilities(state.accounts, { postizConfigured: Boolean(process.env.POSTIZ_API_KEY), expectedYoutubeChannel: expectedYouTubeChannelId, draftBridgeConnected: bridge?.connected, draftBridgeExtensionId: bridge?.extensionId }) : [];
  return { ...summarizeRuntimeSetup({ readiness, state, bridge, knowledge, capabilities }), release: await readRuntimeRelease() };
}
const timestamp = z.string().transform(value => z.iso.datetime().parse(new Date(value).toISOString()));
const runSummarySchema = z.object({ id: z.uuid(), task_id: z.uuid(), draft_id: z.uuid().nullable(), status: z.enum(['queued', 'researching', 'generating', 'succeeded', 'failed', 'cancelled']), phase: z.string(), progress: z.number().min(0).max(100), attempt: z.number().int().nonnegative(), updated_at: timestamp, error: z.string().nullable() });
const operationSummarySchema = z.object({ id: z.uuid(), draft_id: z.uuid().nullable(), subject_kind: z.enum(['article', 'video']), subject_id: z.uuid().nullable(), kind: z.enum(['sync', 'refine', 'video_script', 'video_render', 'publish', 'delivery_recovery', 'collect_metrics', 'article_export']), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']), phase: z.string(), updated_at: timestamp, error: z.string().nullable(), job_id: z.uuid().nullable(), recovery_action: z.enum(['continue', 'reconcile', 'resume', 'dispatch', 'verify_channel']).nullable().optional() });
const renderSchema = z.object({ id: z.uuid(), operationId: z.uuid().optional(), status: z.enum(['running', 'succeeded', 'failed', 'cancelled']), phase: z.string(), attempt: z.number().int().positive(), heartbeatAt: timestamp, finishedAt: timestamp.nullable(), error: z.string().nullable() });
export async function runtimeActivity() {
  const configuredWorkspace = z.uuid().safeParse(process.env.STUDIO_WORKSPACE_ID);
  if (!configuredWorkspace.success) return summarizeRuntimeActivity({ paused: null, jobs: [], runs: [], operations: [], renders: [], warnings: ['工作区尚未配置，请先检查 Docker 配置。'] });
  const workspace = configuredWorkspace.data;
  const [stateResult, runsResult, operationsResult, videosResult, promotionsResult] = await Promise.allSettled([
    readState(),
    dbRequest(`studio_task_runs?workspace_id=eq.${workspace}&select=id,task_id,draft_id,status,phase,progress,attempt,updated_at,error&order=updated_at.desc&limit=100`).then(value => z.array(runSummarySchema).parse(value)),
    dbRequest(`studio_operations?workspace_id=eq.${workspace}&select=id,draft_id,subject_kind,subject_id,kind,status,phase,updated_at,error,job_id:input->>jobId,recovery_action:input->>action&order=updated_at.desc&limit=100`).then(value => z.array(operationSummarySchema).parse(value)),
    dbRequest(`studio_video_projects?workspace_id=eq.${workspace}&select=id,renders:content->renders&order=updated_at.desc&limit=100`).then(value => z.array(z.object({ id: z.uuid(), renders: z.array(renderSchema) })).parse(value)),
    listDiscoveryPromotions(workspace),
  ]);
  const state = stateResult.status === 'fulfilled' ? stateResult.value : null;
  const warnings: string[] = [];
  if (!state) warnings.push('发布记录暂不可读取。');
  if (runsResult.status !== 'fulfilled') warnings.push('任务运行摘要暂不可读取。');
  if (operationsResult.status !== 'fulfilled') warnings.push('文章与视频操作摘要暂不可读取。');
  if (videosResult.status !== 'fulfilled') warnings.push('独立视频渲染摘要暂不可读取。');
  if (promotionsResult.status !== 'fulfilled') warnings.push('发现任务与子任务的关联暂不可读取。');
  return summarizeRuntimeActivity({ paused: state?.paused ?? null, jobs: state?.jobs ?? [], runs: runsResult.status === 'fulfilled' ? runsResult.value : [], operations: operationsResult.status === 'fulfilled' ? operationsResult.value : [], renders: videosResult.status === 'fulfilled' ? videosResult.value.flatMap(project => project.renders.map(render => ({ ...render, projectId: project.id }))) : [], warnings, promotions: promotionsResult.status === 'fulfilled' ? promotionsResult.value : [] });
}
runtimeApi.get('/runtime/setup', async (_req, res) => res.json(await runtimeSetup()));
runtimeApi.get('/runtime/release', async (_req, res) => res.json({ release: await readRuntimeRelease() }));
runtimeApi.get('/runtime/observation', async (_req, res) => res.json(await runtimeObservation()));
runtimeApi.post('/runtime/observation/start', async (_req, res) => res.json(await startRuntimeObservation()));
runtimeApi.post('/runtime/observation/stop', async (_req, res) => res.json(await stopRuntimeObservation()));
runtimeApi.get('/runtime/activity', async (_req, res) => res.json(await runtimeActivity()));
