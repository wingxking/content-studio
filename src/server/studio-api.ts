import { Router } from 'express';
import { join } from 'node:path';
import { z } from 'zod';
import { listAssets, resolveAssetPath } from '../core/assets.ts';
import { createTask, updateTask, listTasks, getTask, enqueueTaskRun, listTaskRuns, getTaskRun, cancelTaskRun, retryTaskRun, readRunArtifact } from '../core/tasks.ts';
import { verifyYouTubeChannel } from '../core/youtube.ts';
import { listModels } from '../core/models.ts';
import { taskInputSchema } from '../core/task-model.ts';
import { getEditor, createOperation, getOperation, applyOperation, cancelOperation, listVideos, editVideo, attachVideo, requestVideoRender, attachAssets, videoSchema } from '../core/editor.ts';
import { continuePublication, publicationHandoff, publishDraft, publishInputSchema } from '../core/delivery.ts';
import { platformSchema } from '../core/model.ts';
import { draftDirectory } from '../core/artifacts.ts';
import { readState } from '../core/store.ts';

export const studioApi = Router();
const id = (value: unknown): string => z.uuid().parse(value);
studioApi.get('/youtube/status', async (_req, res) => { try { res.json({ available: true, ...await verifyYouTubeChannel() }); } catch (error) { res.json({ available: false, error: error instanceof Error ? error.message : 'YouTube authorization is unavailable.' }); } });
studioApi.get('/models', async (_req, res) => res.json(await listModels()));
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
studioApi.get('/assets/library', async (_req, res) => res.json(await listAssets()));
studioApi.get('/assets/:id/file', async (req, res) => { const path = await resolveAssetPath(id(req.params.id)); res.sendFile(path, { dotfiles: 'allow' }); });
studioApi.get('/drafts/:id/editor', async (req, res) => res.json(await getEditor(id(req.params.id))));
studioApi.post('/drafts/:id/assets', async (req, res) => { const value = z.object({ platform: platformSchema, assetIds: z.array(z.uuid()).max(20), expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await attachAssets(id(req.params.id), value.platform, value.assetIds, value.expectedRevision)); });
studioApi.post('/drafts/:id/refine', async (req, res) => { const input = z.object({ scope: z.union([z.literal('master'), platformSchema]), prompt: z.string().min(3).max(4000), model: z.string().optional(), assetIds: z.array(z.uuid()).max(12).optional(), expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await createOperation(id(req.params.id), 'refine', input)); });
studioApi.post('/drafts/:id/sync', async (req, res) => { const input = z.object({ model: z.string().optional(), expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await createOperation(id(req.params.id), 'sync', input)); });
studioApi.get('/operations/:id', async (req, res) => res.json(await getOperation(id(req.params.id))));
studioApi.post('/operations/:id/apply', async (req, res) => res.json(await applyOperation(id(req.params.id), z.number().int().positive().parse(req.body.expectedRevision))));
studioApi.post('/operations/:id/cancel', async (req, res) => res.json(await cancelOperation(id(req.params.id))));
studioApi.get('/videos', async (req, res) => res.json(await listVideos(req.query.draftId ? id(req.query.draftId) : undefined)));
studioApi.post('/drafts/:id/videos', async (req, res) => { const input = z.object({ platform: videoSchema.shape.platform, prompt: z.string().min(3).max(4000), model: z.string().optional(), assetIds: z.array(z.uuid()).max(12).default([]) }).parse(req.body); res.json(await createOperation(id(req.params.id), 'video_script', input)); });
studioApi.put('/videos/:id', async (req, res) => { const input = z.object({ title: videoSchema.shape.title, narration: videoSchema.shape.narration, assetIds: videoSchema.shape.assetIds, expectedRevision: z.number().int().positive() }).parse(req.body); res.json(await editVideo(id(req.params.id), input)); });
studioApi.post('/videos/:id/render', async (req, res) => res.json(await requestVideoRender(id(req.params.id))));
studioApi.post('/videos/:id/attach', async (req, res) => res.json(await attachVideo(id(req.params.id), z.number().int().positive().parse(req.body.expectedRevision))));
studioApi.post('/drafts/:id/publish', async (req, res) => res.json(await publishDraft(id(req.params.id), publishInputSchema.parse(req.body))));
studioApi.post('/jobs/:id/continue', async (req, res) => res.json(await continuePublication(id(req.params.id))));
studioApi.get('/jobs/:id/handoff', async (req, res) => res.json(await publicationHandoff(id(req.params.id))));

async function draftFiles(draftId: string): Promise<string[]> {
  const draft = (await readState()).drafts.find(item => item.id === draftId); if (!draft) throw new Error('Draft not found.');
  return ['master.md', 'sources.md', 'content.json', ...draft.variants.map(item => `${item.platform}.md`)];
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
