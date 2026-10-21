import { realpath, stat } from 'node:fs/promises';
import { Router } from 'express';
import { z } from 'zod';
import type { Account } from '../core/model.ts';
import { createVideoOperation, listVideoOperations } from '../core/editor.ts';
import { readState } from '../core/store.ts';
import { isManagedMediaPath, resolveMediaLocation } from '../core/media-location.ts';
import { expectedYouTubeChannelId } from '../core/youtube.ts';
import { approveVideoRenderVariant, createVideoTarget, currentVideoRevision, getIndependentVideoProject, listIndependentVideoProjects, updateVideoTarget, videoTargets } from '../core/video.ts';
import { prepareVideoTargetPublication } from '../core/video-delivery.ts';
import { videoSettingsSchema, type VideoProject } from '../core/video-model.ts';
import { videoFileHash } from '../core/video-tools.ts';
import type { VideoProjectView } from '../contracts/video.ts';
import { safeRuntimeError, safeRuntimePhase } from '../core/runtime-overview.ts';

export function videoProjectView(project: VideoProject, accounts: Account[]): VideoProjectView {
  const { renders, targets: _targets, deliveryApproval: _legacyApproval, ...details } = project;
  return { ...details, targets: videoTargets(project).map(target => {
    const { approval, ...fields } = target; const account = accounts.find(item => item.id === target.accountId);
    const automatic = target.platform === 'youtube' && account?.status === 'connected' && account.provider === 'native' && account.integrationId === expectedYouTubeChannelId;
    return { ...fields, approval: approval ? { approvalHash: approval.approvalHash, outputHash: approval.outputHash, at: approval.at } : null,
      capability: { automatic, remoteDraft: false, reason: automatic ? null : target.platform === 'bilibili' ? '当前尚未接入经验证的B站官方视频上传适配器及应用授权；可下载成片和复制文案完成原生投稿。' : '选择已授权的 YouTube 频道后可使用官方上传；当前可导出手动发布。' } };
  }), renders: renders.map(render => ({ ...render, error: safeRuntimeError(render.error), phase: safeRuntimePhase(render.phase, render.status), output: render.output ? { hash: render.output.hash, duration: render.output.duration, width: render.output.width, height: render.output.height, reusedStages: render.output.reusedStages,
    mediaUrl: `/api/video-projects/${project.id}/renders/${render.id}/media`, captionsUrl: render.output.captionsPath ? `/api/video-projects/${project.id}/renders/${render.id}/captions` : null } : null })) };
}

export async function videoRenderDownload(project: VideoProject, renderId: string, kind: 'media' | 'captions'): Promise<string> {
  const render = project.renders.find(item => item.id === z.uuid().parse(renderId));
  if (!render?.output || render.status !== 'succeeded') throw new Error('A completed video render is required.');
  const stored = kind === 'media' ? render.output.videoPath : render.output.captionsPath;
  if (!stored) throw new Error('This render has no caption sidecar.');
  const path = await realpath(await resolveMediaLocation(stored));
  if (!await isManagedMediaPath(path) || !(await stat(path)).isFile()) throw new Error('Video artifact is unavailable.');
  if (kind === 'media' && await videoFileHash(path) !== render.output.hash) throw new Error('Video artifact integrity failed.');
  return path;
}

export const videoTargetApi = Router();
const id = (value: unknown): string => z.uuid().parse(value);
async function view(project: VideoProject): Promise<VideoProjectView> { return videoProjectView(project, (await readState()).accounts); }
videoTargetApi.get('/video-projects/views', async (_req, res) => { const [projects, state] = await Promise.all([listIndependentVideoProjects(), readState()]); res.json(projects.map(project => videoProjectView(project, state.accounts))); });
videoTargetApi.get('/video-projects/:id/view', async (req, res) => res.json(await view(await getIndependentVideoProject(id(req.params.id)))));
videoTargetApi.get('/video-projects/:id/operations', async (req, res) => res.json((await listVideoOperations(id(req.params.id))).map(operation => ({ id: operation.id, status: operation.status, phase: safeRuntimePhase(operation.phase, operation.status), error: safeRuntimeError(operation.error), kind: operation.kind }))));
videoTargetApi.post('/video-projects/:id/targets', async (req, res) => res.json(await view(await createVideoTarget(id(req.params.id), req.body))));
videoTargetApi.put('/video-projects/:id/targets/:targetId', async (req, res) => res.json(await view(await updateVideoTarget(id(req.params.id), id(req.params.targetId), req.body))));
videoTargetApi.post('/video-projects/:id/targets/:targetId/publish', async (req, res) => {
  const projectId = id(req.params.id); const job = await prepareVideoTargetPublication(projectId, id(req.params.targetId), req.body);
  const settings = z.object({ deliverySettings: z.object({ youtube: z.unknown().optional() }) }).safeParse(job.snapshot?.video);
  if (job.status === 'scheduled') await createVideoOperation(projectId, 'publish', { jobId: job.id, ...(settings.success ? { youtubeSettings: settings.data.deliverySettings.youtube } : {}) });
  res.json({ id: job.id, status: job.status, platform: job.platform, accountId: job.accountId });
});
videoTargetApi.post('/video-projects/:id/render-variants', async (req, res) => {
  const input = z.object({ expectedRevision: z.number().int().positive(), settings: videoSettingsSchema.partial().default({}), approved: z.literal(true) }).strict().parse(req.body);
  const projectId = id(req.params.id); const approved = await approveVideoRenderVariant(projectId, input.expectedRevision, input.settings);
  const settings = videoSettingsSchema.parse({ ...currentVideoRevision(approved).settings, ...input.settings });
  res.json(await createVideoOperation(projectId, 'video_render', { expectedRevision: input.expectedRevision, settings }));
});
for (const kind of ['media', 'captions'] as const) videoTargetApi.get(`/video-projects/:id/renders/:renderId/${kind}`, async (req, res) => {
  const project = await getIndependentVideoProject(id(req.params.id)); const path = await videoRenderDownload(project, id(req.params.renderId), kind);
  const extension = kind === 'media' ? 'mp4' : 'srt';
  res.setHeader('Content-Disposition', `${req.query.download === 'true' || kind === 'captions' ? 'attachment' : 'inline'}; filename="${project.id}-${id(req.params.renderId)}.${extension}"`);
  res.type(kind === 'media' ? 'video/mp4' : 'application/x-subrip').sendFile(path, { dotfiles: 'allow' });
});
