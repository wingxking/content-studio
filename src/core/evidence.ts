import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { evidenceDocumentSchema, type EvidenceDocument, type EvidenceHit } from '../contracts/research.ts';
import { localfsDirectory } from './localfs.ts';
import { dbRequest, dbRpc } from './database.ts';

export const evidenceHash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const EVIDENCE_EMBEDDING_VERSION = 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3';
export function evidenceTerms(text: string): string {
  return [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(text.toLowerCase())].filter(item => item.isWordLike).map(item => item.segment).slice(0, 30000).join(' ');
}
export class EvidenceFiles {
  constructor(readonly root = join(localfsDirectory(), 'evidence')) {}
  async put(value: unknown): Promise<string> {
    const text = JSON.stringify(value); const hash = evidenceHash(text); await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${hash}.${randomUUID()}.tmp`); const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, join(this.root, `${hash}.json`)).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }); }
    finally { await rm(temporary, { force: true }); }
    await this.read(hash); return hash;
  }
  async read(hash: string): Promise<unknown> {
    z.string().regex(/^[a-f0-9]{64}$/u).parse(hash);
    const handle = await open(join(this.root, `${hash}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size > 80 * 1024 * 1024) throw new Error('Evidence artifact exceeds its size limit.');
      const text = await handle.readFile('utf8'); if (evidenceHash(text) !== hash) throw new Error('Evidence artifact hash mismatch. Restore the LocalFS backup.');
      return JSON.parse(text) as unknown;
    } finally { await handle.close(); }
  }
}
export type ParsedEvidence = { title: string; text: string; originText?: string; publisher: string; creditedPublisher?: string | null; paperStatus?: EvidenceDocument['paperStatus']; publishedAt: string | null; author?: string | null; updatedAt?: string | null; originalRef?: string; evidenceType?: EvidenceDocument['evidenceType']; access: EvidenceDocument['access']; parserVersion?: string; pages?: { start: number; end: number; page: number | null; heading?: string }[] };
export function parseEvidencePage(body: string, mime: string, url: string): ParsedEvidence {
  if (mime !== 'text/html') {
    if (!['text/plain', 'text/markdown', 'application/json'].includes(mime)) throw new Error('This source is discovery metadata, not a readable evidence article.');
    return { title: url, text: body, publisher: new URL(url).hostname, publishedAt: null, access: 'full' };
  }
  const { document } = parseHTML(body); Object.defineProperty(document, 'documentURI', { value: url });
  const published = document.querySelector('meta[property="article:published_time"]') ?? document.querySelector('meta[name="date"],meta[name="citation_publication_date"],article time[datetime],main time[datetime]');
  const rawDate = published?.getAttribute('content') ?? published?.getAttribute('datetime');
  const publishedAt = rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
  const publisher = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? new URL(url).hostname;
  const author = document.querySelector('meta[name="author"]')?.getAttribute('content')?.slice(0, 300) ?? null;
  const creditedPublisher = (document.querySelector('meta[name="source"]')?.getAttribute('content') ?? /(?:来源|Source)\s*[:：]\s*([^\n\r<]{2,80})/iu.exec(document.body?.textContent ?? '')?.[1])?.trim().slice(0, 300) ?? null;
  const updated = document.querySelector('meta[property="article:modified_time"]')?.getAttribute('content');
  const updatedAt = updated && Number.isFinite(Date.parse(updated)) ? new Date(updated).toISOString() : null;
  const partial = /"isAccessibleForFree"\s*:\s*(?:false|"false")|class=["'][^"']*(?:paywall|subscription-required)|subscribe to (?:continue|read)/iu.test(body);
  const title = document.title;
  const article = new Readability(document as unknown as Document, { charThreshold: 80, maxElemsToParse: 25000 }).parse();
  if (!article?.content) throw new Error('Source has no readable article body. It remains a discovery link.');
  const clean = parseHTML(`<html><body>${article.content}</body></html>`).document;
  for (const element of clean.querySelectorAll('script,style,nav,form,iframe')) element.remove();
  const blocks: string[] = []; const pages: NonNullable<ParsedEvidence['pages']> = []; const headings: string[] = []; let offset = 0;
  for (const element of [...clean.querySelectorAll('h1,h2,h3,h4,p,li,pre,table')].filter(item => !item.parentElement?.closest('li,pre,table'))) {
    const level = /^H([1-4])$/u.exec(element.tagName)?.[1];
    if (level) { headings.length = Number(level) - 1; headings[Number(level) - 1] = element.textContent?.trim() ?? ''; }
    let value = element.textContent?.trim() ?? ''; let heading = headings.filter(Boolean).join(' / ');
    if (element.tagName === 'TABLE') {
      const rows = [...element.querySelectorAll('tr')].map(row => [...row.querySelectorAll('th,td')].map(cell => (cell.textContent ?? '').trim().replace(/\|/gu, '\\|').replace(/\s+/gu, ' ')));
      value = rows.map(row => `| ${row.join(' | ')} |`).join('\n'); heading = `${heading} · 表头：${rows[0]?.join(' / ') ?? ''}`;
    }
    if (!value) continue;
    blocks.push(value); pages.push({ start: offset, end: offset + value.length, page: null, heading: heading.slice(0, 500) }); offset += value.length + 2;
  }
  const originText = blocks.join('\n\n') || article.textContent || '';
  if (originText.trim().length < 100) throw new Error('Source body is too short for evidence.');
  const metadata = [`标题：${article.title || title || url}`, `站点：${publisher}`, ...creditedPublisher ? [`署名来源（站点自报）：${creditedPublisher}`] : [], ...rawDate ? [`发布时间（原始元数据）：${rawDate}`] : [], ...updated ? [`更新时间（原始元数据）：${updated}`] : [], ...author ? [`署名作者：${author}`] : []].join('\n');
  const prefix = metadata.length + 2;
  const locations = pages.length ? pages : [{ start: 0, end: originText.length, page: null, heading: '' }];
  return { title: (article.title || title || url).slice(0, 300), text: `${metadata}\n\n${originText}`, originText, pages: [{ start: 0, end: metadata.length, page: null, heading: '来源元数据' }, ...locations.map(page => ({ ...page, start: page.start + prefix, end: page.end + prefix }))], publisher: publisher.slice(0, 300), creditedPublisher, publishedAt, author, updatedAt, access: partial ? 'partial' : 'full' };
}
export function documentChunks(id: string, text: string, pages: ParsedEvidence['pages'] = []): EvidenceDocument['chunks'] {
  const chunks: EvidenceDocument['chunks'] = [];
  // CJK needs about one token per character; latin prose about three characters.
  const units = (value: string) => /^[a-z0-9\s]$/iu.test(value) ? 1 / 3 : 1;
  const regions: NonNullable<ParsedEvidence['pages']> = [];
  for (const region of pages.length ? pages : [{ start: 0, end: text.length, page: null, heading: '' }]) {
    const previous = regions.at(-1);
    if (previous && previous.page === region.page && previous.heading === region.heading && region.start >= previous.end && region.start - previous.end <= 2) previous.end = region.end;
    else regions.push({ ...region });
  }
  for (const region of regions) {
    if (region.start < 0 || region.end > text.length || region.end < region.start) throw new Error('Invalid evidence page/section positions.');
    let start = region.start;
    while (start < region.end) {
      let end = start; let tokens = 0;
      for (const character of text.slice(start, Math.min(region.end, start + 1100))) { if (tokens + units(character) > 350) break; tokens += units(character); end += character.length; }
      const boundary = text.lastIndexOf('\n', end); if (boundary > start + (end - start) * 0.6) end = boundary;
      if (text.slice(start, end).trim()) chunks.push({ id: `${id}:${chunks.length}`, start, end, page: region.page, heading: (region.heading ?? '').slice(0, 500) });
      if (end >= region.end || end <= start) break;
      let overlap = 0; let next = end;
      for (const character of [...text.slice(start, end)].reverse()) { if (overlap + units(character) > 50) break; overlap += units(character); next -= character.length; }
      start = Math.max(start + 1, next);
    }
  }
  return chunks;
}
function toolsOrigin(): string {
  const url = new URL(process.env.STUDIO_KNOWLEDGE_TOOLS_URL ?? 'http://knowledge-tools:8920');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || !['localhost', '127.0.0.1', 'knowledge-tools', 'knowledge-tools.content-studio-k8s.svc.cluster.local'].includes(url.hostname)) throw new Error('Knowledge tools require an internal service origin.');
  return url.origin;
}
export async function knowledgeTools<T>(route: 'embed' | 'pdf', value: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${toolsOrigin()}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.any([AbortSignal.timeout(600000), ...signal ? [signal] : []]), redirect: 'error' });
  if (!response.ok) throw new Error(response.status >= 500 || response.status === 429 ? 'Knowledge processing is unavailable; retry after service recovery.' : `Knowledge document rejected (HTTP ${response.status}); source withheld.`);
  return schema.parse(await response.json());
}
const vectorsSchema = z.object({ vectors: z.array(z.array(z.number().finite()).length(384)), version: z.string() });
export async function evidenceVectors(texts: string[], query = false, signal?: AbortSignal): Promise<z.infer<typeof vectorsSchema>> {
  const result = await knowledgeTools('embed', { texts, query }, vectorsSchema, signal);
  if (result.vectors.length !== texts.length || result.version !== EVIDENCE_EMBEDDING_VERSION) throw new Error('Embedding count or model version differs from the pinned index. Rebuild the knowledge service/index together.'); return result;
}
export async function saveEvidence(workspace: string, parsed: ParsedEvidence, provenance: { url: string; sourceId: string; category: EvidenceDocument['category']; confirmedAt?: string }, signal?: AbortSignal): Promise<EvidenceDocument> {
  const files = new EvidenceFiles(); const sha256 = await files.put({ text: parsed.text });
  const parserVersion = parsed.parserVersion ?? 'structured-v3-cjk350';
  const chunkingVersion = 'cjk350-v3';
  const paperStatus = parsed.paperStatus ?? (/^https?:\/\/(?:export\.)?arxiv\.org\//u.test(provenance.url) ? 'preprint' : 'unknown');
  const id = evidenceHash([provenance.url, sha256, parserVersion, chunkingVersion, EVIDENCE_EMBEDDING_VERSION, parsed.originalRef ?? null, parsed.publishedAt, parsed.updatedAt ?? null, paperStatus]);
  const existing = z.array(z.object({ metadata: evidenceDocumentSchema })).parse(await dbRequest(`studio_evidence_documents?workspace_id=eq.${z.uuid().parse(workspace)}&id=eq.${id}&select=metadata`))[0];
  if (existing) {
    await files.read(existing.metadata.sha256);
    const indexed = z.array(z.object({ id: z.string() })).parse(await dbRequest(`studio_evidence_chunks?workspace_id=eq.${workspace}&document_id=eq.${id}&embedding=not.is.null&select=id&limit=10000`));
    if (indexed.length === existing.metadata.chunks.length) {
      if (provenance.confirmedAt) await dbRpc('studio_confirm_evidence', { p_workspace: workspace, p_document: id, p_observed: provenance.confirmedAt });
      return existing.metadata;
    }
  }
  const chunks = existing?.metadata.chunks ?? documentChunks(id, parsed.text, parsed.pages);
  const document = existing?.metadata ?? evidenceDocumentSchema.parse({ id, ...provenance, title: parsed.title, publisher: parsed.publisher, creditedPublisher: parsed.creditedPublisher ?? null, paperStatus, author: parsed.author ?? null, updatedAt: parsed.updatedAt ?? null, evidenceType: parsed.evidenceType ?? 'reference', ...(parsed.originalRef ? { originalRef: parsed.originalRef } : {}), publishedAt: parsed.publishedAt, fetchedAt: new Date().toISOString(), sha256, originHash: evidenceHash((parsed.originText ?? parsed.text).normalize('NFKC').replace(/\s+/gu, ' ')), rights: provenance.category === 'owner' ? 'owner_supplied' : 'public_read', parserVersion, chunkingVersion, embeddingVersion: EVIDENCE_EMBEDDING_VERSION, access: parsed.access, chunks });
  const texts = chunks.map(chunk => parsed.text.slice(chunk.start, chunk.end));
  for (let offset = 0; offset < chunks.length; offset += 32) {
    const embedded = await evidenceVectors(texts.slice(offset, offset + 32), false, signal);
    await dbRpc('studio_put_evidence', { p_workspace: workspace, p_document: document, p_chunks: chunks.slice(offset, offset + 32).map((chunk, i) => ({ id: chunk.id, metadata: chunk, terms: evidenceTerms(texts[offset + i]!), embedding: embedded.vectors[i], embeddingVersion: embedded.version })) });
  }
  if (provenance.confirmedAt) await dbRpc('studio_confirm_evidence', { p_workspace: workspace, p_document: id, p_observed: provenance.confirmedAt });
  return document;
}
export async function evidenceText(document: EvidenceDocument): Promise<string> { return z.object({ text: z.string() }).parse(await new EvidenceFiles().read(document.sha256)).text; }
export async function searchEvidence(workspace: string, query: string, signal?: AbortSignal): Promise<EvidenceHit[]> {
  const { vectors } = await evidenceVectors([query], true, signal);
  const hits = z.array(z.object({ document_id: z.string(), chunk_id: z.string(), score: z.number() })).parse(await dbRpc('studio_evidence_search', { p_workspace: z.uuid().parse(workspace), p_terms: evidenceTerms(query), p_vector: JSON.stringify(vectors[0]), p_limit: 20, p_embedding_version: EVIDENCE_EMBEDDING_VERSION }));
  const results: EvidenceHit[] = [];
  for (const hit of hits) {
    const rows = z.array(z.object({ metadata: evidenceDocumentSchema })).parse(await dbRequest(`studio_evidence_documents?workspace_id=eq.${workspace}&id=eq.${hit.document_id}&select=metadata`));
    const document = rows[0]?.metadata; const chunk = document?.chunks.find(item => item.id === hit.chunk_id);
    if (!document || !chunk) throw new Error('Evidence index references a missing document.');
    const text = await evidenceText(document);
    results.push({ document, chunkId: chunk.id, text: text.slice(Math.max(0, chunk.start - 300), Math.min(text.length, chunk.end + 300)), score: hit.score, page: chunk.page, heading: chunk.heading });
  }
  return results;
}
