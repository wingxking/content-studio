import { raw, Router } from 'express';
import { z } from 'zod';
import { sourcePreferenceSchema, evidenceDocumentSchema, testRecordSchema, publicSourceUrl } from '../contracts/research.ts';
import { listSources, saveSource, probeSource } from '../core/source-registry.ts';
import { taskWorkspaceId, getTaskRun } from '../core/tasks.ts';
import { dbRequest, dbRpc } from '../core/database.ts';
import { EvidenceFiles, evidenceText, knowledgeTools, saveEvidence, searchEvidence, parseEvidencePage } from '../core/evidence.ts';
import { fetchPublicPage } from '../core/research.ts';
import { runResearchArtifacts, draftQuality, requestDraftQualityRefresh } from '../core/quality.ts';
import { knowledgeStore } from '../core/knowledge.ts';
import { readState } from '../core/store.ts';

export const evidenceApi = Router();
// Initialize a new isolated workspace before writing FK-bound source/evidence rows.
evidenceApi.use(['/sources', '/evidence', '/production'], async (_req, _res, next) => { await readState(); next(); });
evidenceApi.get('/production/metrics', async (_req, res) => res.json(await dbRpc('studio_production_metrics', { p_workspace: await taskWorkspaceId() })));
evidenceApi.get('/sources', async (_req, res) => res.json(await listSources(await taskWorkspaceId())));
evidenceApi.put('/sources/:id', async (req, res) => {
  const source = sourcePreferenceSchema.parse(req.body); if (source.id !== req.params.id) throw new Error('Source identity differs from URL.');
  res.json(await saveSource(await taskWorkspaceId(), source));
});
evidenceApi.post('/sources/:id/collect', async (req, res) => {
  const workspace = await taskWorkspaceId(); const source = (await listSources(workspace)).find(item => item.source.id === req.params.id)?.source;
  if (!source) throw new Error('Source not found.');
  await saveSource(workspace, source);
  const input = z.object({ commandId: z.uuid() }).strict().parse(req.body);
  res.status(202).json({ id: await dbRpc('studio_queue_source', { p_workspace: workspace, p_source: source.id, p_slot: `manual:${input.commandId}` }) });
});
evidenceApi.post('/sources/:id/probe', async (req, res) => {
  const workspace = await taskWorkspaceId(); const source = (await listSources(workspace)).find(item => item.source.id === req.params.id)?.source;
  if (!source) throw new Error('Source not found.');
  await saveSource(workspace, source); res.json(await probeSource(workspace, source));
});
evidenceApi.get('/evidence/documents', async (_req, res) => {
  const rows = z.array(z.object({ metadata: evidenceDocumentSchema })).parse(await dbRequest(`studio_evidence_documents?workspace_id=eq.${await taskWorkspaceId()}&select=metadata&order=created_at.desc&limit=500`));
  res.json(rows.map(row => row.metadata));
});
evidenceApi.get('/evidence/search', async (req, res) => res.json(await searchEvidence(await taskWorkspaceId(), z.string().trim().min(1).max(2000).parse(req.query.q))));
evidenceApi.get('/evidence/documents/:id', async (req, res) => {
  const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(req.params.id);
  const document = z.array(z.object({ metadata: evidenceDocumentSchema })).parse(await dbRequest(`studio_evidence_documents?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${id}&select=metadata`))[0]?.metadata;
  if (!document) { res.status(404).json({ error: 'Evidence document not found.' }); return; }
  const text = await evidenceText(document); const chunk = req.query.chunk ? document.chunks.find(item => item.id === req.query.chunk) : document.chunks[0];
  if (!chunk) throw new Error('Evidence span not found.');
  res.json({ document, chunk, text: text.slice(chunk.start, chunk.end) });
});
evidenceApi.get('/evidence/documents/:id/original', async (req, res) => {
  const id = z.string().regex(/^[a-f0-9]{64}$/u).parse(req.params.id);
  const document = z.array(z.object({ metadata: evidenceDocumentSchema })).parse(await dbRequest(`studio_evidence_documents?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${id}&select=metadata`))[0]?.metadata;
  if (!document?.originalRef) { res.status(404).json({ error: 'Original evidence file is unavailable.' }); return; }
  const original: unknown = await new EvidenceFiles().read(document.originalRef);
  const file = z.object({ mime: z.string(), content: z.string() }).safeParse(original);
  const bytes = file.success ? Buffer.from(file.data.content, 'base64') : Buffer.from(JSON.stringify(original, null, 2));
  res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="evidence-${id.slice(0, 16)}.${file.success && file.data.mime === 'application/pdf' ? 'pdf' : 'txt'}"`);
  res.send(bytes);
});
evidenceApi.post('/evidence/index-knowledge', async (_req, res) => {
  const store = knowledgeStore(); const workspace = await taskWorkspaceId(); const documents = [];
  for (const source of await store.list()) documents.push(await saveEvidence(workspace, { title: source.name, text: await store.readText(source.id), publisher: 'Owner supplied', publishedAt: null, access: 'full' }, { url: `studio-knowledge:${source.id}`, sourceId: source.id, category: 'owner' }));
  res.json({ indexed: documents.length });
});
evidenceApi.post('/evidence/web', async (req, res) => {
  const { url } = z.object({ url: publicSourceUrl }).strict().parse(req.body);
  const page = await fetchPublicPage(url); const parsed = parseEvidencePage(page.body, page.mime, page.url);
  if (parsed.access !== 'full') throw new Error('Only partial content is available; bookmark withheld from evidence.');
  parsed.originalRef = await new EvidenceFiles().put({ mime: page.mime, content: page.bytes.toString('base64') });
  const source = (await listSources(await taskWorkspaceId())).find(item => item.source.url === url)?.source;
  res.status(201).json(await saveEvidence(await taskWorkspaceId(), parsed, { url: page.url, sourceId: source?.id ?? 'owner-bookmark', category: source?.category ?? 'media', confirmedAt: new Date().toISOString() }));
});
evidenceApi.post('/evidence/test-record', async (req, res) => {
  const record = testRecordSchema.parse(req.body);
  if (Date.parse(record.performedAt) > Date.now() + 300000) throw new Error('Test record timestamp is in the future.');
  const original = await new EvidenceFiles().put(record);
  const text = `# ${record.title}\n\n执行时间：${record.performedAt}\n\n环境：${record.environment}\n\n步骤：${record.procedure}\n\n观察记录：${record.observations}\n\n限制：${record.limitations}`;
  res.status(201).json(await saveEvidence(await taskWorkspaceId(), { title: record.title, text, originalRef: original, publisher: 'Owner attested execution record', publishedAt: record.performedAt, access: 'full', evidenceType: 'test_record' }, { url: `studio-knowledge:test:${original}`, sourceId: `test-${original}`, category: 'owner' }));
});
evidenceApi.post('/evidence/pdf', raw({ type: 'application/octet-stream', limit: '50mb', inflate: false }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Upload a PDF document.');
  const name = z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f]+\.pdf$/iu).parse(req.query.name);
  const parsed = await knowledgeTools('pdf', { content: req.body.toString('base64') }, z.object({ text: z.string(), pages: z.array(z.object({ page: z.number().int(), start: z.number().int(), end: z.number().int(), heading: z.string() })), sha256: z.string(), parserVersion: z.string() }));
  const original = await new EvidenceFiles().put({ mime: 'application/pdf', content: req.body.toString('base64') });
  const document = await saveEvidence(await taskWorkspaceId(), { title: name, text: parsed.text, pages: parsed.pages, parserVersion: parsed.parserVersion, originalRef: original, publisher: 'Owner supplied', publishedAt: null, access: 'full' }, { url: `studio-knowledge:pdf:${original}`, sourceId: `pdf-${original}`, category: 'owner' });
  res.status(201).json(document);
});
evidenceApi.get('/runs/:id/evidence', async (req, res) => { const run = await getTaskRun(z.uuid().parse(req.params.id)); res.json(await runResearchArtifacts(await taskWorkspaceId(), run.id)); });
evidenceApi.get('/drafts/:id/quality', async (req, res) => {
  const draft = (await readState()).drafts.find(item => item.id === req.params.id); if (!draft) { res.status(404).json({ error: 'Draft not found.' }); return; }
  res.json(await draftQuality(await taskWorkspaceId(), draft));
});
evidenceApi.post('/drafts/:id/quality/refresh', async (req, res) => {
  const id = z.uuid().parse(req.params.id);
  const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(req.body);
  const draft = (await readState()).drafts.find(item => item.id === id);
  if (!draft) { res.status(404).json({ error: 'Draft not found.' }); return; }
  res.status(202).json(await requestDraftQualityRefresh(await taskWorkspaceId(), draft, input.expectedRevision));
});
