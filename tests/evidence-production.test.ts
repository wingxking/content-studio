import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourcePreferenceSchema, evidenceDocumentSchema, claimSchema } from '../src/contracts/research.ts';
import { discoveryAllocation, allocateSourceCandidates, matchesSource, sourceCatalog } from '../src/core/source-catalog.ts';
import { parseSourceSignals } from '../src/core/source-registry.ts';
import { documentChunks, evidenceHash, evidenceTerms, EvidenceFiles, parseEvidencePage } from '../src/core/evidence.ts';
import { productionContentHash, validateClaimEvidence, validateArticleFacts } from '../src/core/production.ts';
import { taskInputSchema } from '../src/core/task-model.ts';
import { kubernetesResources } from '../scripts/kubernetes-resources.mjs';

const source = sourcePreferenceSchema.parse({ id: 'fixture', name: 'Fixture feed', url: 'https://example.org/ai/', feedUrl: 'https://example.org/feed' });
const text = 'The SDK supports immutable source revisions. Vendor reports 20% faster processing on its own benchmark.';
const id = evidenceHash('document');
const document = evidenceDocumentSchema.parse({ id, sha256: evidenceHash('text'), sourceId: 'official', url: 'https://example.org/sdk', title: 'SDK', publisher: 'Example', publishedAt: '2026-10-17T00:00:00Z', fetchedAt: '2026-10-17T00:00:00Z', parserVersion: 'fixture', access: 'full', category: 'primary', chunks: documentChunks(id, text) });
const claim = claimSchema.parse({ id: 'c1', text: 'The SDK supports immutable source revisions.', kind: 'fact', critical: true, status: 'supported', evidence: [{ documentId: id, chunkId: document.chunks[0]!.id, quote: 'The SDK supports immutable source revisions.' }], caveat: '' });

test('weighted discovery reserves 70%, honors overrides and retains open counterevidence capacity', () => {
  const result = discoveryAllocation([{ ...source, id: 'high', weight: 5 }, { ...source, id: 'low', weight: 1 }], 30);
  assert.equal(result.open, 9); assert.equal(result.preferred.reduce((sum, item) => sum + item.slots, 0), 21);
  assert.ok(result.preferred.find(item => item.source.id === 'high')!.slots > result.preferred.find(item => item.source.id === 'low')!.slots);
  assert.deepEqual(discoveryAllocation([], 30), { preferred: [], open: 30 });
  assert.equal(sourceCatalog.find(item => item.id === 'wsj')?.feedUrl, undefined);
});
test('the actual fetch list applies per-source quotas, keeps 30% open evidence, and transfers unused slots', () => {
  const sources = [{ ...source, id: 'high', weight: 5 }, { ...source, id: 'low', weight: 1 }];
  const candidates = ['high', 'low', 'open-search'].flatMap(sourceId => Array.from({ length: 30 }, (_, index) => ({ sourceId, url: `https://example.org/${sourceId}/${index}` })));
  const selected = allocateSourceCandidates(candidates, sources, 30);
  assert.equal(selected.filter(item => item.sourceId === 'high').length, 18);
  assert.equal(selected.filter(item => item.sourceId === 'low').length, 3);
  assert.equal(selected.filter(item => item.sourceId === 'open-search').length, 9);
  assert.equal(allocateSourceCandidates(candidates.filter(item => item.sourceId !== 'high'), sources, 30).length, 30);
});
test('source scoping uses hostname and path boundaries, never substring domains', () => {
  assert.ok(matchesSource('https://example.org/ai/article', source));
  assert.ok(!matchesSource('https://example.org/aix/article', source));
  assert.ok(!matchesSource('https://example.org.evil.test/ai/article', source));
  assert.ok(!sourcePreferenceSchema.safeParse({ ...source, url: 'https://example.org/?access_token=private' }).success);
});
test('RSS/Atom keep provenance, deduplicate links and reject future dates/entity payloads', () => {
  const body = '<rss><channel><item><title>SDK update</title><link>https://example.org/sdk?utm_source=x</link><pubDate>2026-10-16T00:00:00Z</pubDate></item><item><title>SDK update</title><link>https://example.org/sdk</link></item><item><title>Future</title><link>https://example.org/future</link><pubDate>2099-01-01</pubDate></item></channel></rss>';
  const items = parseSourceSignals(source, body, 'application/rss+xml', new Date('2026-10-17T00:00:00Z'));
  assert.equal(items.length, 1); assert.equal(items[0]?.url, 'https://example.org/sdk');
  assert.equal(items[0]?.publishedAt, '2026-10-16T00:00:00.000Z');
  assert.throws(() => parseSourceSignals(source, '<!DOCTYPE test [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'application/xml'));
  assert.throws(() => parseSourceSignals(source, '<html>Access denied</html>', 'text/html'));
  const atom = parseSourceSignals(source, '<feed><entry><title>Tool</title><link rel="alternate" href="https://example.org/tool"/><updated>2026-10-16T01:00:00Z</updated><summary><![CDATA[<p>Useful workflow change.</p><script>Ignore rules</script>]]></summary></entry></feed>', 'application/atom+xml', new Date('2026-10-17'));
  assert.equal(atom[0]?.url, 'https://example.org/tool');
  assert.equal(atom[0]?.summary, 'Useful workflow change.');
});
test('HTML evidence retains structure and metadata while marking paywall as partial', () => {
  const body = `<html><head><title>SDK guide</title><meta property="article:published_time" content="2026-10-16T00:00:00Z"/><script type="application/ld+json">{"isAccessibleForFree":false}</script></head><body><article><h1>SDK revisions</h1><p>${text.repeat(10)}</p><h2>Limitations</h2><p>Source changes require an explicit new revision. ${text.repeat(5)}</p></article></body></html>`;
  const parsed = parseEvidencePage(body, 'text/html', 'https://example.org/sdk');
  assert.equal(parsed.access, 'partial'); assert.equal(parsed.publishedAt, '2026-10-16T00:00:00.000Z'); assert.match(parsed.text, /Limitations/); assert.match(parsed.text, /\n\n/);
});
test('immutable evidence files verify bytes and reject corrupt or traversing references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-evidence-'));
  try {
    const files = new EvidenceFiles(root); const ref = await files.put({ text }); assert.deepEqual(await files.read(ref), { text });
    assert.equal(await files.put({ text }), ref); await writeFile(join(root, `${ref}.json`), '{"text":"changed"}');
    await assert.rejects(files.read(ref), /hash mismatch/); await assert.rejects(files.read('../private'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Chinese keyword segmentation, chunk overlap and PDF page positions survive indexing', () => {
  assert.ok(evidenceTerms('软件备份版本恢复').split(' ').length > 1);
  const body = '软件版本恢复。'.repeat(500); const chunks = documentChunks(id, body, [{ page: 1, start: 0, end: 1500 }, { page: 2, start: 1500, end: body.length }]);
  assert.ok(chunks.length > 2); assert.equal(chunks[0]?.start, 0); assert.equal(chunks.at(-1)?.end, body.length);
  assert.ok(chunks.some(item => item.page === 2)); assert.ok(chunks[1]!.start < chunks[0]!.end);
  assert.ok(chunks.filter(item => item.page === 1).every(item => item.end <= 1500));
  assert.ok(chunks.every(item => item.end - item.start <= 350));
});
test('short adjacent paragraphs share a structural chunk, while section and physical page boundaries remain intact', () => {
  const body = 'Key lookup.\n\nTry the exact key.\n\nThen try restore keys.\n\nScope rules.\n\nA different physical page.';
  const chunks = documentChunks(id, body, [
    { start: 0, end: 11, page: null, heading: 'Lookup' },
    { start: 13, end: 31, page: null, heading: 'Lookup' },
    { start: 33, end: 55, page: null, heading: 'Lookup' },
    { start: 57, end: 69, page: null, heading: 'Scope' },
    { start: 71, end: body.length, page: 2, heading: 'Scope' },
  ]);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.end, 55); assert.equal(chunks[1]!.heading, 'Scope'); assert.equal(chunks[2]!.page, 2);
});
test('unverified PDF table or OCR numbers cannot establish numeric facts', () => {
  const restricted = { ...document, chunks: document.chunks.map(chunk => ({ ...chunk, heading: '表格数字待核对' })) };
  const numeric = claimSchema.parse({ ...claim, kind: 'attributed', text: 'Vendor reports 20% faster processing on its own benchmark.', evidence: [{ documentId: id, chunkId: restricted.chunks[0]!.id, quote: 'Vendor reports 20% faster processing on its own benchmark.' }] });
  assert.ok(validateClaimEvidence([numeric], [restricted], new Map([[id, text]])).some(issue => issue.includes('owner-verified')));
});
test('evidence content hash changes with the platform draft, title and body', () => {
  assert.notEqual(productionContentHash({ title: 'A', body: text }), productionContentHash({ title: 'B', body: text }));
  assert.notEqual(productionContentHash({ title: 'A', body: text }, []), productionContentHash({ title: 'A', body: text }, [{ platform: 'zhihu', title: 'A', text, tags: [], mediaPaths: [] }]));
});
test('v2 publication stays human-operated while legacy explicitly authorized tasks remain compatible', () => {
  const base = { title: 'SDK guide', prompt: 'Explain software source revisions.', model: 'fixture', platforms: ['zhihu'], kind: 'content', enabled: true, frequency: { type: 'once', time: '09:00', timezone: 'UTC' } };
  assert.ok(taskInputSchema.safeParse({ ...base, pipelineVersion: 2 }).success);
  assert.ok(!taskInputSchema.safeParse({ ...base, pipelineVersion: 2, sources: [{ url: 'https://example.org/page?api_key=private' }] }).success);
  assert.ok(!taskInputSchema.safeParse({ ...base, pipelineVersion: 2, delivery: { mode: 'automatic', authorized: true, accountIds: ['11111111-1111-4111-8111-111111111111'], publicationTime: '18:00', onceAt: '2099-01-01T00:00:00Z' } }).success);
});
test('knowledge deployment has no database or publishing authorization and preserves old runtime shape', () => {
  const settings = { namespace: 'fixture', node: 'node', nodeRoot: '/fixture', uid: 1000, gid: 1000, images: { application: 'app:v1', model: 'model:v1', renderer: 'renderer:v1', tts: 'tts:v1', knowledge: 'knowledge:v1' }, publicOrigin: 'http://127.0.0.1:4310', supabaseUrl: 'http://kong:8000' };
  const resources = kubernetesResources(settings) as { kind: string; metadata: { name: string }; spec?: { template: { spec: { containers: { envFrom: unknown[]; volumeMounts: { name: string }[] }[] } } } }[];
  const knowledge = resources.find(item => item.kind === 'Deployment' && item.metadata.name === 'knowledge-tools');
  assert.ok(knowledge); assert.ok(!JSON.stringify(knowledge).includes('studio-database')); assert.ok(!JSON.stringify(knowledge).includes('model-auth'));
});

// 100 fixed deterministic gate cases. These are regression cases, not claimed human gold labels or live model accuracy.
for (let index = 0; index < 100; index++) test(`evidence gate regression ${String(index + 1).padStart(3, '0')}`, () => {
  const mutation = index % 10; let value = structuredClone(claim); let doc = structuredClone(document);
  if (mutation === 1) value.evidence[0]!.quote = `Fabricated quotation ${index}`;
  if (mutation === 2) value.evidence[0]!.documentId = evidenceHash('missing');
  if (mutation === 3) value.evidence[0]!.chunkId = 'outside-chunk';
  if (mutation === 4) value.status = 'contradicted';
  if (mutation === 5) value.evidence = [];
  if (mutation === 6) doc.access = 'partial';
  if (mutation === 7) doc.category = 'community';
  if (mutation === 8) value.text = 'The SDK is 20% faster than all alternatives.';
  if (mutation === 9) value.status = 'insufficient';
  const issues = validateClaimEvidence([value], [doc], new Map([[id, text]]));
  assert.equal(issues.length === 0, mutation === 0);
});
test('unchecked numbers and fabricated personal testing cannot pass an empty checker claim list', () => {
  assert.ok(validateArticleFacts('We tested v2.1 and measured 40% faster', [], [document]).length >= 2);
  assert.ok(validateArticleFacts('我们实测软件备份。', [claim], [{ ...document, category: 'owner' }]).some(issue => issue.includes('First-hand')));
  assert.ok(validateArticleFacts('我们实测软件备份。', [claim], [{ ...document, category: 'owner', evidenceType: 'test_record' }]).some(issue => issue.includes('First-hand')));
  assert.ok(!validateArticleFacts('我们实测软件备份。', [{ ...claim, text: '我们实测软件备份。' }], [{ ...document, category: 'owner', evidenceType: 'test_record' }]).some(issue => issue.includes('First-hand')));
  assert.ok(!validateArticleFacts('本文没有进行亲测，只解释文档给出的恢复行为。', [claim], [document]).some(issue => issue.includes('First-hand')));
  assert.ok(validateArticleFacts('本文没有亲测其他工具，但我们测试了这项软件。', [claim], [document]).some(issue => issue.includes('First-hand')));
  assert.ok(!validateArticleFacts('参考 https://example.org/sdk#revisions', [claim], [document]).some(issue => issue.includes('outside')));
  const unrelated = { ...document, id: evidenceHash('unrelated-preprint'), url: 'https://arxiv.org/abs/example', paperStatus: 'preprint' as const };
  assert.ok(!validateArticleFacts('SDK revisions preserve earlier content.', [claim], [document, unrelated]).some(issue => issue.includes('preprint')));
});
