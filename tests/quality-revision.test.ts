import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { draftSchema } from '../src/core/model.ts';
import { evidenceDocumentSchema, qualityReportSchema } from '../src/contracts/research.ts';
import { EvidenceFiles, documentChunks, evidenceHash, parseEvidencePage } from '../src/core/evidence.ts';
import { assertDraftQuality, draftQuality, requestDraftQualityRefresh } from '../src/core/quality.ts';
import { productionContentHash } from '../src/core/production.ts';

test('quality fails closed on missing run, edited revision, expired report and changed current prices', async () => {
  const env = { ...process.env }; const fetcher = globalThis.fetch; const directory = await mkdtemp(join(tmpdir(), 'studio-quality-'));
  process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_LOCALFS_DIR = directory;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture-only';
  const workspace = randomUUID(); const id = randomUUID(); const timestamp = new Date().toISOString(); const files = new EvidenceFiles();
  const html = `<html><head><title>Pricing reference</title></head><body><article><h1>Pricing</h1><p>${'工具价格为20美元，属于标准方案。实际权限以该版本说明为准。'.repeat(10)}</p></article></body></html>`;
  const parsed = parseEvidencePage(html, 'text/html', 'https://example.org/pricing');
  const documentId = evidenceHash('pricing-fixture');
  const document = evidenceDocumentSchema.parse({ id: documentId, sha256: await files.put({ text: parsed.text }), sourceId: 'official', url: 'https://example.org/pricing', title: 'Pricing', publisher: 'Example', publishedAt: null, fetchedAt: timestamp, parserVersion: 'structured-v3-cjk350', chunks: documentChunks(documentId, parsed.text, parsed.pages), access: 'full', category: 'primary' });
  const draft = draftSchema.parse({ id, title: '价格参考', body: '工具价格为20美元。', brief: { topic: 'Pricing', audience: 'Developers', angle: 'Pricing reference', sources: [{ title: 'Pricing', url: document.url, excerpt: parsed.text }], platforms: ['zhihu'] }, variants: [{ platform: 'zhihu', title: '价格参考', text: '工具价格为20美元。', tags: [], mediaPaths: [] }], revision: 1, approvedHash: null, createdAt: timestamp, generationEvidenceRunId: id });
  let report = qualityReportSchema.parse({ status: 'passed', contentHash: productionContentHash(draft, draft.variants), evidenceHash: evidenceHash(document), draftRevision: 1, checkedAt: timestamp, claims: [{ id: 'price', text: '工具价格为20美元。', critical: true, kind: 'fact', status: 'supported', evidence: [{ documentId, chunkId: document.chunks.find(chunk => parsed.text.slice(chunk.start, chunk.end).includes('工具价格为20美元'))!.id, quote: '工具价格为20美元' }], caveat: '' }], issues: [], checks: [], model: 'fixture', guidanceVersion: 'fixture', judgement: 'model_assisted' });
  let runExists = false; let confirmed = 0; let refreshes = 0;
  const requestedRun = randomUUID(); const operatorRequests: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('workspace_id') ?? `eq.${workspace}`, `eq.${workspace}`);
    if (url.pathname.endsWith('/studio_task_runs')) return Response.json(runExists ? [{ id, task_snapshot: { pipelineVersion: 2 } }] : []);
    if (url.pathname.endsWith('/studio_research_steps')) return Response.json([
      { stage: 'evidence_bundle', status: 'completed', artifact_ref: await files.put({ documents: [document] }), attempts: 1, updated_at: timestamp, model: null },
      { stage: 'quality_final', status: 'completed', artifact_ref: await files.put(report), attempts: 1, updated_at: timestamp, model: null },
    ]);
    if (url.pathname.endsWith('/studio_evidence_documents')) return Response.json([{ last_confirmed_at: null }]);
    if (url.pathname.endsWith('/rpc/studio_confirm_evidence')) { confirmed++; return Response.json(null); }
    if (url.pathname.endsWith('/rpc/studio_request_evidence_refresh')) {
      const request: unknown = JSON.parse(String(init?.body));
      if (request && typeof request === 'object' && 'p_reason' in request && request.p_reason === 'review_requested') { operatorRequests.push(request); return Response.json(requestedRun); }
      refreshes++; return Response.json(randomUUID());
    }
    throw new Error('Unexpected fixture request.');
  };
  try {
    assert.equal((await draftQuality(workspace, draft)).required, true);
    await assert.rejects(assertDraftQuality(workspace, draft), /no passing evidence/);
    runExists = true;
    const edited = { ...draft, revision: 2, title: '人工编辑的价格参考' };
    await assert.rejects(assertDraftQuality(workspace, edited), /changed/);
    assert.equal((await draftQuality(workspace, edited)).current, false);
    assert.deepEqual(await requestDraftQualityRefresh(workspace, edited, 2), { runId: requestedRun, draftId: id, expectedRevision: 2, accepted: true });
    assert.deepEqual(operatorRequests, [{ p_workspace: workspace, p_draft: id, p_revision: 2, p_reason: 'review_requested' }]);
    await assert.rejects(requestDraftQualityRefresh(workspace, edited, 1), /revision changed/);
    assert.equal(operatorRequests.length, 1);
    assert.equal(refreshes, 0);
    report = { ...report, checkedAt: new Date(Date.now() - 25 * 3600000).toISOString() };
    await assert.rejects(assertDraftQuality(workspace, draft), /expired/);
    assert.equal(refreshes, 1);
    report = { ...report, checkedAt: timestamp };
    let pageReads = 0;
    const page = (body: string) => ({ url: document.url, body, bytes: Buffer.from(body), status: 200, location: null, mime: 'text/html' });
    await assertDraftQuality(workspace, draft, async () => { pageReads++; return page(html); });
    assert.equal(pageReads, 1); assert.equal(confirmed, 1);
    await assert.rejects(assertDraftQuality(workspace, draft, async () => page(html.replaceAll('20美元', '30美元'))), /source changed/);
    assert.equal(confirmed, 1); assert.equal(refreshes, 2);
  } finally { globalThis.fetch = fetcher; process.env = env; await rm(directory, { recursive: true, force: true }); }
});

test('a concurrent article edit rejects regeneration at the database compare-and-swap boundary', async () => {
  const env = { ...process.env }; const fetcher = globalThis.fetch;
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_SECRET_KEY = 'fixture-only';
  const workspace = randomUUID(); const draft = draftSchema.parse({ id: randomUUID(), title: 'Reviewed article', body: 'Source-backed explanation.', brief: { topic: 'Topic', audience: 'Reader', angle: 'Practical explanation', sources: [{ title: 'Reference', url: 'https://example.org/reference', excerpt: 'Source-backed explanation.' }], platforms: ['zhihu'] }, variants: [{ platform: 'zhihu', title: 'Reviewed article', text: 'Source-backed explanation.', tags: [], mediaPaths: [] }], revision: 2, approvedHash: null, createdAt: new Date().toISOString(), generationEvidenceRunId: randomUUID() });
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).endsWith('/rpc/studio_request_evidence_refresh'));
    assert.equal(JSON.parse(String(init?.body)).p_revision, 2); requests++;
    return Response.json({ code: 'P0001', message: 'Draft revision changed before evidence refresh' }, { status: 400 });
  };
  try {
    await assert.rejects(requestDraftQualityRefresh(workspace, draft, 2), /revision or execution ownership changed/);
    assert.equal(requests, 1);
    await assert.rejects(requestDraftQualityRefresh(workspace, { ...draft, generationEvidenceRunId: undefined }, 2), /no evidence production task/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = fetcher; process.env = env; }
});
