import { deliveryCalendar, deliveryCalendarDay } from "../application/delivery-calendar.ts";
import { Router } from 'express';
import { z } from 'zod';
import { articleDetail, articleEditor, cloneRun, contentPage, createFromQuestion, publicArticleOperation, publicTaskRun, runsPage, submitDeliveryBatch, tasksPage, workspaceSummary } from '../application/workspace.ts';
import { getTaskRun, repairRunArtifacts } from '../core/tasks.ts';
import { getOperation } from '../core/editor.ts';
import { publicArticleJob } from '../core/article-media.ts';
import { readState } from '../core/store.ts';
import { taskRefSchema } from '../contracts/workbench.ts';
import { taskIndex, taskContext, contextContent, contextResources, contextActivity, resolveContent, captureResource, library, linkResource, unlinkResource, updatePresentation, deliveryPage } from '../application/task-context.ts';
import { deliveryPreflight } from '../core/delivery-preflight.ts';
import { createDeliveryBatch, deliveryBatch } from '../application/delivery-batches.ts';

export const workspaceApi = Router();
const id = (input: unknown) => z.uuid().parse(input);
workspaceApi.get('/workspace/task-index', async (req,res) => res.json(await taskIndex(req.query)));
workspaceApi.get('/workspace/delivery-calendar/day', async (req,res) => res.json(await deliveryCalendarDay(req.query)));
workspaceApi.get('/workspace/delivery-calendar', async (req,res) => res.json(await deliveryCalendar(req.query)));
workspaceApi.get('/workspace/deliveries', async (req,res) => res.json(await deliveryPage(req.query)));
workspaceApi.get('/workspace/resolve-article/:id', async (req,res) => res.json(await resolveContent(id(req.params.id))));
workspaceApi.get('/workspace/task-context/:kind/:id/resources', async (req,res) => res.json(await contextResources(taskRefSchema.parse(req.params))));
workspaceApi.get('/workspace/task-context/:kind/:id', async (req,res) => res.json(await taskContext(taskRefSchema.parse(req.params),req.query)));
workspaceApi.get('/workspace/task-context/:kind/:id/episodes/:episodeId/:section', async (req,res) => {
  const ref = taskRefSchema.parse({kind:req.params.kind,id:req.params.id}); const episode = id(req.params.episodeId);
  if (req.params.section === 'content') { res.json(await contextContent(ref,episode,z.string().optional().parse(req.query.cursor))); return; }
  if (req.params.section === 'resources') { res.json(await contextResources(ref,episode)); return; }
  if (req.params.section === 'activity') { res.json(await contextActivity(ref,episode)); return; }
  throw new Error('Task section not found.');
});
workspaceApi.post('/workspace/task-context/:kind/:id/presentation', async (req,res) => res.json(await updatePresentation(taskRefSchema.parse(req.params),req.body)));
workspaceApi.post('/workspace/deliveries/preflight', async (req,res) => res.json(await deliveryPreflight(req.body)));
workspaceApi.post('/workspace/delivery-batches', async (req,res) => res.status(202).json(await createDeliveryBatch(req.body)));
workspaceApi.get('/workspace/delivery-batches/:id', async (req,res) => res.json(await deliveryBatch(id(req.params.id))));
workspaceApi.post('/workspace/captures', async (req,res) => res.status(201).json(await captureResource(req.body)));
workspaceApi.get('/workspace/library', async (req,res) => res.json(await library(req.query)));
workspaceApi.post('/workspace/resource-links', async (req,res) => res.json(await linkResource(req.body)));
workspaceApi.delete('/workspace/resource-links/:id', async (req,res) => res.json(await unlinkResource(id(req.params.id))));
workspaceApi.get('/workspace/summary', async (_req, res) => res.json(await workspaceSummary()));
workspaceApi.get('/workspace/content', async (req, res) => res.json(await contentPage(req.query)));
workspaceApi.get('/workspace/tasks', async (req, res) => res.json(await tasksPage(req.query)));
workspaceApi.get('/workspace/runs', async (req, res) => res.json(await runsPage(req.query)));
workspaceApi.get('/workspace/runs/:id', async (req, res) => {
  const run = await getTaskRun(id(req.params.id));
  res.json(publicTaskRun(run));
});
workspaceApi.get('/workspace/articles/:id', async (req, res) => res.json(await articleDetail(id(req.params.id), req.query.revision ? z.coerce.number().int().positive().parse(req.query.revision) : undefined)));
workspaceApi.get('/workspace/articles/:id/editor', async (req, res) => res.json(await articleEditor(id(req.params.id))));
workspaceApi.get('/workspace/video-projects/:id/jobs', async (req, res) => {
  const projectId = id(req.params.id);
  res.json({ jobs: (await readState()).jobs.filter(job => job.subject?.kind === 'video' && job.subject.id === projectId).map(publicArticleJob) });
});
workspaceApi.post('/workspace/runs/:id/clone-task', async (req, res) => res.status(201).json(await cloneRun(id(req.params.id), req.body)));
workspaceApi.post('/workspace/from-question', async (req, res) => res.status(201).json(await createFromQuestion(req.body)));
workspaceApi.post('/workspace/deliveries/batch', async (req, res) => res.status(202).json(await submitDeliveryBatch(req.body)));
workspaceApi.post('/workspace/runs/:id/repair-exports', async (req, res) => {
  const run = await getTaskRun(id(req.params.id));
  if (run.status !== 'succeeded') throw new Error('Only completed executions can repair exports.');
  res.json(await repairRunArtifacts(run));
});
workspaceApi.get('/workspace/operations/:id', async (req, res) => {
  const operation = await getOperation(id(req.params.id));
  const draft = (await readState()).drafts.find(item => item.id === operation.draftId);
  res.json(publicArticleOperation(operation, draft));
});
