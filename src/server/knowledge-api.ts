import { raw, Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { KnowledgeStore, knowledgeLimits } from '../core/knowledge.ts';

export function createKnowledgeApi(store = new KnowledgeStore()): Router {
  const router = Router();
  router.get('/', async (_req, res) => res.json(await store.list()));
  router.get('/mount', async (_req, res) => res.json(await store.mount()));
  router.post('/upload', raw({ type: 'application/octet-stream', limit: knowledgeLimits.fileBytes, inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new Error('Upload a UTF-8 text file as application/octet-stream.');
    res.status(201).json(await store.upload(z.string().min(1).max(200).parse(req.query.name), req.body));
  });
  router.post('/import', async (req, res) => res.status(201).json(await store.import(z.object({ paths: z.array(z.string()).min(1).max(knowledgeLimits.importFiles) }).strict().parse(req.body).paths)));
  router.get('/search', async (req, res) => res.json(await store.search(z.string().trim().min(1).max(200).parse(req.query.q))));
  router.get('/:id/excerpt', async (req, res) => res.json(await store.excerpt(z.uuid().parse(req.params.id), z.string().max(1000).parse(req.query.query ?? ''))));
  const knowledgeError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const message = error instanceof z.ZodError ? 'Invalid knowledge request. Check the file selection or search query.' : error instanceof Error && 'code' in error ? 'Knowledge file is unavailable. Refresh the source list or restore its LocalFS backup.' : error instanceof Error ? error.message : 'Knowledge request failed.';
    res.status(400).json({ error: message });
  };
  router.use(knowledgeError);
  return router;
}
export const knowledgeApi = createKnowledgeApi();
