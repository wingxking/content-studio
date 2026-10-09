import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createServer } from 'vite';
import { accountSchema, briefSchema, generatedSchema, platformSchema } from '../core/model.ts';
import { readState } from '../core/store.ts';
import { doctor } from '../core/doctor.ts';
import { generateContent } from '../core/generator.ts';
import { addAccount, approveDraft, cancelJob, confirmPublication, createDraft, exportJob, pausePublishing, reconcileJob, recordMetrics, replaceDraft, runDueJobs, scheduleJob, updateAccount, verifyDraftApproval } from '../core/pipeline.ts';
import { buildMedia } from '../core/media.ts';

const app = express(); const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT ?? '4310');
const dataDir = resolve(process.env.STUDIO_DATA_DIR ?? '.studio'); const mediaRoot = resolve(dataDir, 'media');
app.disable('x-powered-by');
app.use((req, res, next) => {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? '') || (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin))) { res.status(403).json({ error: 'Use this studio through its local address.' }); return; }
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.post('/api/assets', express.raw({ type: 'application/octet-stream', limit: '500mb' }), async (req, res) => {
  const name = z.string().max(200).parse(req.headers['x-file-name']); const extension = extname(name).toLowerCase();
  if (!['.mp4', '.mov', '.png', '.jpg', '.jpeg', '.webp'].includes(extension) || !Buffer.isBuffer(req.body) || req.body.length === 0) throw new Error('Upload a non-empty MP4, MOV, PNG, JPEG, or WebP file.');
  const folder = resolve(mediaRoot, randomUUID()); await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = resolve(folder, `asset${extension}`); await writeFile(path, req.body, { mode: 0o600 }); res.json({ path });
});
app.use(express.json({ limit: '2mb', strict: true }));
app.get('/api/status', async (_req, res) => res.json({ state: await readState(), readiness: await doctor() }));
app.post('/api/drafts/import', async (req, res) => { const input = z.object({ brief: briefSchema, content: generatedSchema }).parse(req.body); res.json(await createDraft(input.brief, input.content)); });
let generating = false;
app.post('/api/drafts/generate', async (req, res) => {
  if (generating) { res.status(409).json({ error: 'Generation is already running. Wait for its result.' }); return; }
  const brief = briefSchema.parse(req.body); generating = true;
  try { res.json(await createDraft(brief, await generateContent(brief))); } finally { generating = false; }
});
app.put('/api/drafts/:id', async (req, res) => { const revision = z.number().int().positive().parse(req.body.expectedRevision); res.json(await replaceDraft(z.uuid().parse(req.params.id), generatedSchema.parse(req.body), revision)); });
app.post('/api/drafts/:id/approve', async (req, res) => res.json(await approveDraft(z.uuid().parse(req.params.id))));
app.post('/api/drafts/:id/media', async (req, res) => {
  const platform = platformSchema.parse(req.body.platform); const id = z.uuid().parse(req.params.id);
  const draft = (await readState()).drafts.find(item => item.id === id); if (!draft) throw new Error('Draft not found.');
  await verifyDraftApproval(draft);
  const media = await buildMedia(draft, platform);
  try {
    const updated = await replaceDraft(id, { title: draft.title, body: draft.body, variants: draft.variants.map(variant => variant.platform === platform ? { ...variant, mediaPaths: media.files.filter(file => /\.(png|jpg|jpeg|mp4)$/i.test(file)) } : variant) }, draft.revision);
    res.json({ media, draft: updated });
  } catch (error) {
    const first = media.files[0]; if (first && dirname(first).startsWith(`${mediaRoot}${sep}`)) await rm(dirname(first), {recursive: true, force: true});
    throw error;
  }
});
app.post('/api/accounts', async (req, res) => res.json(await addAccount(accountSchema.omit({ id: true }).parse(req.body))));
app.put('/api/accounts/:id', async (req, res) => res.json(await updateAccount(z.uuid().parse(req.params.id), accountSchema.omit({ id: true }).parse(req.body))));
app.post('/api/jobs', async (req, res) => res.json(await scheduleJob(z.object({ draftId: z.uuid(), accountId: z.uuid(), scheduledAt: z.iso.datetime() }).parse(req.body))));
app.post('/api/jobs/run', async (_req, res) => res.json(await runDueJobs()));
app.post('/api/pause', async (req, res) => { const paused = z.boolean().parse(req.body.paused); await pausePublishing(paused); res.json({ paused }); });
app.post('/api/jobs/:id/cancel', async (req, res) => res.json(await cancelJob(z.uuid().parse(req.params.id))));
app.post('/api/jobs/:id/reconcile', async (req, res) => res.json(await reconcileJob(z.uuid().parse(req.params.id))));
app.post('/api/jobs/:id/receipt', async (req, res) => { const input = z.object({ remoteUrl: z.url(), remoteId: z.string().min(1).max(500) }).parse(req.body); res.json(await confirmPublication(z.uuid().parse(req.params.id), input.remoteUrl, input.remoteId)); });
app.post('/api/jobs/:id/metrics', async (req, res) => { const input = z.object({ views: z.number().nonnegative().nullable(), likes: z.number().nonnegative().nullable(), comments: z.number().nonnegative().nullable(), clicks: z.number().nonnegative().nullable(), notes: z.string().max(2000) }).parse(req.body); res.json(await recordMetrics(z.uuid().parse(req.params.id), input)); });
app.get('/api/jobs/:id/export', async (req, res) => { const bundle = await exportJob(z.uuid().parse(req.params.id)); res.setHeader('Content-Disposition', `attachment; filename="${bundle.job.id}.json"`); res.json(bundle); });
app.get('/api/media', async (req, res) => {
  const path = await realpath(resolve(z.string().parse(req.query.path))); const root = await realpath(mediaRoot); if (!path.startsWith(`${root}${sep}`)) { res.status(403).end(); return; }
  const info = await stat(path); if (!info.isFile() || info.size > 500 * 1024 * 1024) throw new Error('Media file is unavailable.');
  res.setHeader('Content-Disposition', `inline; filename="${basename(path).replace(/[^\w.-]/g, '_')}"`); res.sendFile(path);
});
app.get('/api/docs/:name', async (req, res) => {
  const name = z.enum(['research', 'accounts', 'architecture', 'acceptance']).parse(req.params.name);
  res.type('text/markdown').send(await readFile(resolve('docs', `${name}.md`), 'utf8'));
});
const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'Request failed.';
  res.status(400).json({ error: message });
};
app.use(errors);
if (process.env.NODE_ENV === 'production') app.use(express.static(resolve('dist')));
else { const vite = await createServer({ server: { middlewareMode: true, allowedHosts: ['localhost', '127.0.0.1'], hmr: { host: '127.0.0.1', port: port + 1 } }, appType: 'spa' }); app.use(vite.middlewares); }
let dispatching = false;
const timer = setInterval(() => { if (dispatching) return; dispatching = true; void runDueJobs().catch(() => undefined).finally(() => { dispatching = false; }); }, 30000);
timer.unref();
void runDueJobs().catch(() => undefined);
app.listen(port, '127.0.0.1', () => process.stdout.write(`Content Studio: http://127.0.0.1:${port}\nChrome profile: radarxai@gmail.com\n`));
