import { checkAccountConnection } from '../core/pipeline.ts';
import { articlePackageHtml } from '../core/article-package.ts';
import { publishingCapabilities } from '../core/publishing-capabilities.ts';
import { listIntegrations } from '../core/postiz.ts';
import { expectedYouTubeChannelId } from '../core/youtube.ts';
import { createStreamingAssetRouter, createUploadRouter } from './uploads.ts';
import express, { type ErrorRequestHandler } from 'express';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createServer } from 'vite';
import { accountSchema, briefSchema, generatedSchema, platformSchema } from '../core/model.ts';
import { readState } from '../core/store.ts';
import { doctor } from '../core/doctor.ts';
import { generateContent } from '../core/generator.ts';
import { addAccount, approveDraft, cancelJob, confirmPublication, createDraft, pausePublishing, recordMetrics, replaceDraft, scheduleJob, updateAccount, verifyDraftApproval } from '../core/pipeline.ts';
import { buildMedia } from '../core/media.ts';
import { loadRuntimeEnvironment } from '../core/runtime-env.ts';
import { registerGeneratedAsset } from '../core/assets.ts';
import { createDeliveryRecoveryOperation, saveEditedDraft } from '../core/editor.ts';
import { isManagedMediaPath, resolveMediaLocation } from '../core/media-location.ts';
import { studioApi } from './studio-api.ts';
import { draftConnectorApi } from './draft-api.ts';
import { draftBridgeStatus } from '../core/draft-connectors.ts';

await loadRuntimeEnvironment();

const app = express(); const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT ?? '4310');
const dataDir = resolve(process.env.STUDIO_DATA_DIR ?? '.studio'); const mediaRoot = resolve(dataDir, 'media');
app.disable('x-powered-by');
app.use((req, res, next) => {
  const publicOrigin = process.env.STUDIO_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
  const parsedOrigin = new URL(publicOrigin);
  const hosts = [...new Set([`127.0.0.1:${port}`, `localhost:${port}`, parsedOrigin.host])];
  const origins = [...new Set(hosts.map(host => `http://${host}`).concat(publicOrigin))];
  if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !origins.includes(req.headers.origin))) { res.status(403).json({ error: 'Use this studio through its local address.' }); return; }
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(await createUploadRouter());
app.use(createStreamingAssetRouter());
app.use(express.json({ limit: '2mb', strict: true }));
app.use('/api', studioApi);
app.use('/api', draftConnectorApi);
app.get('/healthz', (_req, res) => res.json({ ready: true }));
app.get('/api/status', async (_req, res) => res.json({ state: await readState(), readiness: await doctor() }));
app.post('/api/drafts/import', async (req, res) => { const input = z.object({ brief: briefSchema, content: generatedSchema }).parse(req.body); res.json(await createDraft(input.brief, input.content)); });
let generating = false;
app.post('/api/drafts/generate', async (req, res) => {
  if (generating) { res.status(409).json({ error: 'Generation is already running. Wait for its result.' }); return; }
  const brief = briefSchema.parse(req.body); generating = true;
  try { res.json(await createDraft(brief, await generateContent(brief))); } finally { generating = false; }
});
app.put('/api/drafts/:id', async (req, res) => { const revision = z.number().int().positive().parse(req.body.expectedRevision); res.json(await saveEditedDraft(z.uuid().parse(req.params.id), generatedSchema.parse(req.body), revision, z.string().optional().parse(req.body.model))); });
app.post('/api/drafts/:id/approve', async (req, res) => res.json(await approveDraft(z.uuid().parse(req.params.id), z.number().int().positive().parse(req.body.expectedRevision))));
app.post('/api/drafts/:id/media', async (req, res) => {
  const platform = platformSchema.parse(req.body.platform); const id = z.uuid().parse(req.params.id);
  if (['youtube', 'tiktok', 'bilibili', 'kuaishou', 'douyin'].includes(platform)) throw new Error('Create and render a separate video project before attaching it to this platform.');
  const draft = (await readState()).drafts.find(item => item.id === id); if (!draft) throw new Error('Draft not found.');
  await verifyDraftApproval(draft);
  const media = await buildMedia(draft, platform);
  try {
    for (const path of media.files) await registerGeneratedAsset(path);
    const updated = await replaceDraft(id, { title: draft.title, body: draft.body, variants: draft.variants.map(variant => variant.platform === platform ? { ...variant, mediaPaths: media.files.filter(file => /\.(png|jpg|jpeg|mp4)$/i.test(file)) } : variant) }, draft.revision);
    res.json({ media, draft: updated });
  } catch (error) {
    const first = media.files[0]; if (first && dirname(first).startsWith(`${mediaRoot}${sep}`)) await rm(dirname(first), {recursive: true, force: true});
    throw error;
  }
});
app.get('/api/schemas/content', (_req, res) => res.json(z.toJSONSchema(z.object({ brief: briefSchema, content: generatedSchema }))));
app.get('/api/publishing/capabilities', async (_req, res) => {
  const [state, bridge] = await Promise.all([readState(), draftBridgeStatus()]);
  res.json(publishingCapabilities(state.accounts, { postizConfigured: Boolean(process.env.POSTIZ_API_KEY), expectedYoutubeChannel: expectedYouTubeChannelId, draftBridgeConnected: bridge.connected, draftBridgeExtensionId: bridge.extensionId }));
});
app.get('/api/publishing/integrations', async (_req, res) => res.json(await listIntegrations()));
app.post('/api/accounts/:id/check', async (req, res) => res.json(await checkAccountConnection(z.uuid().parse(req.params.id))));
app.post('/api/accounts', async (req, res) => res.json(await addAccount(accountSchema.omit({ id: true }).parse(req.body))));
app.put('/api/accounts/:id', async (req, res) => res.json(await updateAccount(z.uuid().parse(req.params.id), accountSchema.omit({ id: true }).parse(req.body))));
app.post('/api/jobs', async (req, res) => res.json(await scheduleJob(z.object({ draftId: z.uuid(), accountId: z.uuid(), scheduledAt: z.iso.datetime() }).parse(req.body))));
app.post('/api/jobs/run', async (_req, res) => res.json(await createDeliveryRecoveryOperation(null, 'dispatch')));
app.post('/api/pause', async (req, res) => { const paused = z.boolean().parse(req.body.paused); await pausePublishing(paused); res.json({ paused }); });
app.post('/api/jobs/:id/cancel', async (req, res) => res.json(await cancelJob(z.uuid().parse(req.params.id))));
app.post('/api/jobs/:id/reconcile', async (req, res) => res.json(await createDeliveryRecoveryOperation(z.uuid().parse(req.params.id), 'reconcile')));
app.post('/api/jobs/:id/receipt', async (req, res) => { const input = z.object({ remoteUrl: z.url(), remoteId: z.string().min(1).max(500) }).parse(req.body); res.json(await confirmPublication(z.uuid().parse(req.params.id), input.remoteUrl, input.remoteId)); });
app.post('/api/jobs/:id/metrics', async (req, res) => { const input = z.object({ views: z.number().nonnegative().nullable(), likes: z.number().nonnegative().nullable(), comments: z.number().nonnegative().nullable(), clicks: z.number().nonnegative().nullable(), notes: z.string().max(2000) }).parse(req.body); res.json(await recordMetrics(z.uuid().parse(req.params.id), input)); });
app.get('/api/jobs/:id/article.html', async (req, res) => { const job = (await readState()).jobs.find(item => item.id === z.uuid().parse(req.params.id)); if (!job?.snapshot || job.subject?.kind === 'video') throw new Error('An immutable article snapshot is required.'); res.setHeader('Content-Disposition', `attachment; filename="${job.id}.html"`); res.type('html').send(articlePackageHtml(job.snapshot.variant)); });
app.get('/api/jobs/:id/export', async (req, res) => { const job = (await readState()).jobs.find(item => item.id === z.uuid().parse(req.params.id)); if (!job) throw new Error('Publication not found.'); res.setHeader('Content-Disposition', `attachment; filename="${job.id}.json"`); res.json({ job, ...job.snapshot }); });
app.get('/api/media', async (req, res) => {
  const path = await realpath(await resolveMediaLocation(z.string().parse(req.query.path))); if (!await isManagedMediaPath(path)) { res.status(403).end(); return; }
  const info = await stat(path); if (!info.isFile() || info.size > 500 * 1024 * 1024) throw new Error('Media file is unavailable.');
  res.setHeader('Content-Disposition', `inline; filename="${basename(path).replace(/[^\w.-]/g, '_')}"`); res.sendFile(path, { dotfiles: 'allow' });
});
app.get('/api/docs/:name', async (req, res) => {
  const name = z.enum(['publishing-ecosystem-2026-10-13.zh-CN', 'research', 'accounts', 'architecture', 'acceptance', 'web-product-design.zh-CN', 'web-technical-architecture.zh-CN', 'research-web-workflows-2026-10-10.zh-CN', 'local-system-delivery.zh-CN', 'publishing-capabilities-upgrade-2026-10-11.zh-CN', 'publishing-competitors-and-codex-browser-2026-10-11']).parse(req.params.name);
  res.type('text/markdown').send(await readFile(resolve('docs', `${name}.md`), 'utf8'));
});
const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'Request failed.';
  res.status(400).json({ error: message });
};
app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found. Restart the local application after an upgrade.' }); });
app.use(errors);
if (process.env.NODE_ENV === 'production') app.use(express.static(resolve('dist')));
else { const vite = await createServer({ server: { middlewareMode: true, allowedHosts: ['localhost', '127.0.0.1'], hmr: { host: '127.0.0.1', port: port + 1 } }, appType: 'spa' }); app.use(vite.middlewares); }
app.listen(port, process.env.STUDIO_LISTEN_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1', () => process.stdout.write(`Content Studio: http://127.0.0.1:${port}\nChrome profile: radarxai@gmail.com\n`));
