import { browserPublisherStatus, controlBrowserFixtureSession } from '../core/browser-publisher.ts';
import { getJobMetrics, queueMetricCollection, configureMetricPolling } from '../core/metrics.ts';
import { adaptArticleImage, imageAdaptationInputSchema } from '../core/article-tools.ts';
import { createDeliveryRecoveryOperation, createVideoOperation, listVideoOperations } from '../core/editor.ts';
import { createVideoProject, getIndependentVideoProject, listIndependentVideoProjects, updateVideoProject, approveVideoRevision, applyVideoRefinement, cancelVideoRender } from '../core/video.ts';
import { videoCreateInputSchema, videoEditInputSchema } from '../core/video-model.ts';
import { prepareVideoPublication, videoPublicationInputSchema } from '../core/video-delivery.ts';
import { youtubeSettingsSchema } from '../core/youtube.ts';
import { dbRpc } from '../core/database.ts';
import { modelExecutorOrigin } from '../core/model-executor.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Router } from 'express';
import { join } from 'node:path';
import { z } from 'zod';
import { listAssets, resolveAssetPath } from '../core/assets.ts';
import { createTask, updateTask, listTasks, getTask, enqueueTaskRun, listTaskRuns, getTaskRun, cancelTaskRun, retryTaskRun, readRunArtifact } from '../core/tasks.ts';
import { readPrivateJson } from '../core/youtube-oauth.ts';
import { dataDirectory } from '../core/store.ts';
import { listModels } from '../core/models.ts';
import { taskInputSchema } from '../core/task-model.ts';
import { getEditor, createOperation, getOperation, applyOperation, cancelOperation, listVideos, editVideo, attachVideo, requestVideoRender, attachAssets, videoSchema } from '../core/editor.ts';
import { publicationHandoff, publishDraft, publishInputSchema } from '../core/delivery.ts';
import { platformSchema } from '../core/model.ts';
import { draftDirectory } from '../core/artifacts.ts';
import { readState } from '../core/store.ts';

export const studioApi = Router();
const id = (value: unknown): string => z.uuid().parse(value);
studioApi.get('/youtube/status', async (_req, res) => {
  const operation = await createDeliveryRecoveryOperation(null, 'verify_channel');
  let previous: unknown = null; try { previous = await readPrivateJson(join(dataDirectory(), 'publication-journals', 'channel-status.json')); } catch { /* Pending worker verification is explicit below. */ }
  for (let attempt = 0; attempt < 30; attempt++) { const current = await getOperation(operation.id); if (current.status === 'succeeded') { res.json({ available: true, ...z.object({ channelId: z.string() }).parse(current.output) }); return; } if (current.status === 'failed') { res.json({ available: false, error: current.error }); return; } await delay(500); }
  res.json({ available: false, pending: true, operationId: operation.id, previous, error: 'Channel authorization verification queued in the delivery worker. Refresh after it completes.' });
});
studioApi.get('/runtime/scheduler', async (_req, res) => res.json(await dbRpc('studio_scheduler_status')));
studioApi.post('/runtime/scheduler', async (req, res) => res.json(await dbRpc('studio_set_scheduler', { p_enabled: z.boolean().parse(req.body.enabled) })));
studioApi.get('/models', async (_req, res) => res.json(await listModels()));
studioApi.post('/models/refresh', async (_req, res) => { const response = await fetch(`${modelExecutorOrigin()}/models/refresh`, { method: 'POST', signal: AbortSignal.timeout(35000), redirect: 'error' }); if (!response.ok) throw new Error('Authorize the model container, then refresh models.'); res.json(await response.json()); });
studioApi.get('/tasks', async (_req, res) => res.json(await listTasks()));
studioApi.post('/tasks', async (req, res) => res.json(await createTask(taskInputSchema.parse(req.body))));
studioApi.get('/tasks/:id', async (req, res) => res.json(await getTask(id(req.params.id))));
studioApi.put('/tasks/:id', async (req, res) => res.json(await updateTask(id(req.params.id), taskInputSchema.parse(req.body))));
studioApi.post('/tasks/:id/run', async (req, res) => res.json(await enqueueTaskRun(id(req.params.id), { manual: true })));
studioApi.get('/tasks/:id/runs', async (req, res) => res.json(await listTaskRuns(id(req.params.id))));
studioApi.get('/runs', async (_req, res) => res.json(await listTaskRuns()));
studioApi.get('/runs/:id', async (req, res) => res.json(await getTaskRun(id(req.params.id))));
studioApi.post('/runs/:id/cancel', async (req, res) => res.json(await cancelTaskRun(id(req.params.id))));
studioApi.post('/runs/:id/retry', async (req, res) => res.json(await retryTaskRun(id(req.params.id))));
studioApi.post('/assets/:id/adapt', async (req, res) => res.json(await adaptArticleImage(id(req.params.id), imageAdaptationInputSchema.parse(req.body))));
studioApi.get('/assets/library', async (_req, res) => res.json(await listAssets()));
studioApi.get('/assets/:id/file', async (req, res) => { const path = await resolveAssetPath(id(req.params.id)); res.sendFile(path, { dotfiles: 'allow' }); });
studioApi.get('/drafts/:id/editor', async (req, res) => res.json(await getEditor(id(req.params.id))));
studioApi.post('/drafts/:id/assets', async (req, res) => { const value = z.object({ platform: platformSchema, assetIds: z.array(z.uuid()).max(20), expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await attachAssets(id(req.params.id), value.platform, value.assetIds, value.expectedRevision)); });
studioApi.post('/drafts/:id/refine', async (req, res) => { const input = z.object({ scope: z.union([z.literal('master'), platformSchema]), prompt: z.string().min(3).max(4000), model: z.string().optional(), assetIds: z.array(z.uuid()).max(12).optional(), expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await createOperation(id(req.params.id), 'refine', input)); });
studioApi.post('/drafts/:id/sync', async (req, res) => { const input = z.object({ model: z.string().optional(), expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await createOperation(id(req.params.id), 'sync', input)); });
studioApi.get('/operations/:id', async (req, res) => res.json(await getOperation(id(req.params.id))));
studioApi.post('/operations/:id/apply', async (req, res) => res.json(await applyOperation(id(req.params.id), z.number().int().positive().parse(req.body.expectedRevision))));
studioApi.post('/operations/:id/cancel', async (req, res) => res.json(await cancelOperation(id(req.params.id))));
studioApi.get('/video-projects', async (_req, res) => res.json(await listIndependentVideoProjects()));
studioApi.post('/video-projects', async (req, res) => res.json(await createVideoProject(videoCreateInputSchema.parse(req.body))));
studioApi.get('/video-projects/:id', async (req, res) => { const projectId = id(req.params.id); res.json({ project: await getIndependentVideoProject(projectId), operations: await listVideoOperations(projectId) }); });
studioApi.put('/video-projects/:id', async (req, res) => res.json(await updateVideoProject(id(req.params.id), videoEditInputSchema.parse(req.body))));
studioApi.post('/video-projects/:id/script', async (req, res) => { const input = z.object({ expectedRevision: z.number().int().positive(), model: z.string().optional() }).parse(req.body); res.json(await createVideoOperation(id(req.params.id), 'video_script', input)); });
studioApi.post('/video-projects/:id/refine', async (req, res) => { const input = z.object({ expectedRevision: z.number().int().positive(), instruction: z.string().min(3).max(4000), sceneId: z.string().nullable().optional(), model: z.string().optional() }).parse(req.body); res.json(await createVideoOperation(id(req.params.id), 'refine', input)); });
studioApi.post('/video-projects/:id/proposals/:proposalId/apply', async (req, res) => res.json(await applyVideoRefinement(id(req.params.id), id(req.params.proposalId), z.number().int().positive().parse(req.body.expectedRevision))));
studioApi.post('/video-projects/:id/approve-render', async (req, res) => res.json(await approveVideoRevision(id(req.params.id), req.body)));
studioApi.post('/video-projects/:id/render', async (req, res) => res.json(await createVideoOperation(id(req.params.id), 'video_render', { expectedRevision: z.number().int().positive().parse(req.body.expectedRevision) })));
studioApi.post('/video-projects/:id/renders/:renderId/cancel', async (req, res) => res.json(await cancelVideoRender(id(req.params.id), id(req.params.renderId))));
studioApi.post('/video-projects/:id/publish', async (req, res) => {
  const input = videoPublicationInputSchema.extend({ youtubeSettings: youtubeSettingsSchema.optional() }).parse(req.body);
  if (input.automatic && !input.youtubeSettings) throw new Error('Explicit YouTube visibility and disclosure settings are required.');
  const projectId = id(req.params.id); const job = await prepareVideoPublication(projectId, input);
  if (input.automatic && job.status === 'scheduled') await createVideoOperation(projectId, 'publish', { jobId: job.id, youtubeSettings: input.youtubeSettings });
  res.json(job);
});
studioApi.post('/jobs/:id/resume-upload', async (req, res) => res.json(await createDeliveryRecoveryOperation(id(req.params.id), 'resume')));
studioApi.get('/videos', async (req, res) => res.json(await listVideos(req.query.draftId ? id(req.query.draftId) : undefined)));
studioApi.post('/drafts/:id/videos', async (req, res) => { const input = z.object({ platform: videoSchema.shape.platform, prompt: z.string().min(3).max(4000), model: z.string().optional(), assetIds: z.array(z.uuid()).max(12).default([]) }).parse(req.body); res.json(await createOperation(id(req.params.id), 'video_script', input)); });
studioApi.put('/videos/:id', async (req, res) => { const input = z.object({ title: videoSchema.shape.title, narration: videoSchema.shape.narration, assetIds: videoSchema.shape.assetIds, expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await editVideo(id(req.params.id), input)); });
studioApi.post('/videos/:id/render', async (req, res) => res.json(await requestVideoRender(id(req.params.id))));
studioApi.post('/videos/:id/attach', async (req, res) => res.json(await attachVideo(id(req.params.id), z.number().int().positive().parse(req.body.expectedRevision))));
studioApi.post('/drafts/:id/publish', async (req, res) => res.json(await publishDraft(id(req.params.id), publishInputSchema.parse(req.body))));
studioApi.post('/jobs/:id/continue', async (req, res) => res.json(await createDeliveryRecoveryOperation(id(req.params.id), 'continue')));
studioApi.get('/jobs/:id/handoff', async (req, res) => res.json(await publicationHandoff(id(req.params.id))));

async function draftFiles(draftId: string): Promise<string[]> {
  const draft = (await readState()).drafts.find(item => item.id === draftId); if (!draft) throw new Error('Draft not found.');
  return ['master.md', ...(draft.document ? ['master.html'] : []), 'sources.md', 'content.json', ...draft.variants.map(item => `${item.platform}.md`)];
}
studioApi.get('/drafts/:id/files', async (req, res) => { const draftId = id(req.params.id); const names = await draftFiles(draftId); res.json(names.map(name => ({ name, url: `/api/drafts/${draftId}/files/${name}` }))); });
studioApi.get('/drafts/:id/files/:name', async (req, res) => {
  const draftId = id(req.params.id); const name = z.string().parse(req.params.name); if (!(await draftFiles(draftId)).includes(name)) throw new Error('File not found.');
  res.download(join(draftDirectory(draftId), name), name, { dotfiles: 'allow' });
});
async function runFiles(runId: string): Promise<{ name: string; path: string }[]> {
  const run = await getTaskRun(runId); if (!run.outputPaths) return [];
  const names = [run.outputPaths.master, run.outputPaths.package, ...Object.values(run.outputPaths.platforms)];
  const result: { name: string; path: string }[] = [];
  for (const name of names) { const file = await readRunArtifact(runId, name); result.push({ name, path: file.path }); }
  return result;
}
studioApi.get('/runs/:id/files', async (req, res) => { const runId = id(req.params.id); res.json((await runFiles(runId)).map(file => ({ name: file.name, url: `/api/runs/${runId}/files/${encodeURIComponent(file.name)}` }))); });
studioApi.get('/runs/:id/files/:name', async (req, res) => { const file = (await runFiles(id(req.params.id))).find(item => item.name === req.params.name); if (!file) throw new Error('File not found.'); res.download(file.path, file.name, { dotfiles: 'allow' }); });

studioApi.get('/jobs/:id/metrics', async (req, res) => res.json(await getJobMetrics(id(req.params.id))));
studioApi.post('/jobs/:id/metrics/collect', async (req, res) => res.json(await queueMetricCollection(id(req.params.id))));
studioApi.post('/jobs/:id/metrics/poll', async (req, res) => res.json(await configureMetricPolling(id(req.params.id), req.body)));

studioApi.get('/browser-publisher/status', async (_req, res) => res.json(await browserPublisherStatus()));
studioApi.post('/browser-publisher/session', async (req, res) => res.json(await controlBrowserFixtureSession(req.body)));
