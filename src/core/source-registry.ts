import { z } from 'zod';
import { XMLParser } from 'fast-xml-parser';
import { parseHTML } from 'linkedom';
import { sourcePreferenceSchema, type SourcePreference } from '../contracts/research.ts';
import { sourceCatalog } from './source-catalog.ts';
import { dbRequest, dbRpc } from './database.ts';
import { fetchPublicPage, validateSourceUrl } from './research.ts';
import { evidenceHash, EvidenceFiles, parseEvidencePage } from './evidence.ts';

export const signalSchema = z.object({ id: z.string(), sourceId: z.string(), url: z.string(), title: z.string(), summary: z.string().max(2000).default(''), publishedAt: z.iso.datetime().nullable(), observedAt: z.iso.datetime(), topicKey: z.string(), score: z.number().nullable().default(null), paperStatus: z.enum(['preprint', 'published', 'unknown']).optional() });
export type DiscoverySignal = z.infer<typeof signalSchema>;
const sourceRow = z.object({ id: z.string(), config: sourcePreferenceSchema, health: z.record(z.string(), z.unknown()), version: z.number() });
export async function listSources(workspace: string): Promise<{ source: SourcePreference; health: Record<string, unknown>; version: number }[]> {
  const rows = z.array(sourceRow).parse(await dbRequest(`studio_source_registry?workspace_id=eq.${z.uuid().parse(workspace)}&order=id`));
  const all = new Map(sourceCatalog.map(source => [source.id, { source, health: {} as Record<string, unknown>, version: 0 }]));
  for (const row of rows) all.set(row.id, { source: row.config, health: row.health, version: row.version });
  return [...all.values()];
}
export async function saveSource(workspace: string, value: SourcePreference): Promise<SourcePreference> {
  const source = sourcePreferenceSchema.parse(value); validateSourceUrl(source.url); if (source.feedUrl) validateSourceUrl(source.feedUrl);
  await dbRpc('studio_save_source', { p_workspace: z.uuid().parse(workspace), p_source: source.id, p_config: source });
  return source;
}
export async function registerTaskSources(workspace: string, sources: SourcePreference[]): Promise<void> {
  if (!sources.length) return;
  const now = new Date().toISOString();
  const rows = sources.map(value => {
    const source = sourcePreferenceSchema.parse(value); validateSourceUrl(source.url); if (source.feedUrl) validateSourceUrl(source.feedUrl);
    const config = sourceCatalog.find(item => item.id === source.id) ?? source;
    return { workspace_id: z.uuid().parse(workspace), id: source.id, config, next_poll_at: config.enabled && config.access !== 'requires_authorization' ? now : null };
  });
  // A task override must not overwrite another task's global source defaults.
  await dbRequest('studio_source_registry?on_conflict=workspace_id,id', { method: 'POST', prefer: 'resolution=ignore-duplicates', body: rows });
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
function field(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : String(record(value)['#text'] ?? ''); }
function sourceSummary(value: unknown): string {
  const document = parseHTML(`<html><body>${field(value).slice(0, 12000)}</body></html>`).document;
  for (const node of document.querySelectorAll('script,style')) node.remove();
  return (document.body.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 2000);
}
export function topicKey(title: string): string { return title.normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/gu, '').replace(/[\p{P}\p{S}\s]+/gu, '').slice(0, 500); }
export function parseSourceSignals(source: SourcePreference, body: string, mime: string, now = new Date()): DiscoverySignal[] {
  if ((/xml|rss|atom/iu.test(mime) || source.feedUrl || source.scope === 'feed') && /<!DOCTYPE|<!ENTITY/iu.test(body)) throw new Error('Source feed contains unsupported XML declarations.');
  const output: DiscoverySignal[] = [];
  const add = (title: string, input: string, date: string | null, paperStatus?: DiscoverySignal['paperStatus'], summary?: unknown) => {
    if (!title.trim() || !input) return;
    let url: URL; try { url = validateSourceUrl(new URL(input, source.url).href); } catch { return; }
    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_') || ['fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
    const publishedAt = date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
    if (publishedAt && Date.parse(publishedAt) > now.getTime() + 60000) return;
    const identity = evidenceHash([source.id, url.href]);
    if (output.some(item => item.id === identity)) return;
    output.push(signalSchema.parse({ id: identity, sourceId: source.id, title: title.trim().slice(0, 300), summary: sourceSummary(summary), url: url.href, publishedAt, observedAt: now.toISOString(), topicKey: topicKey(title), score: null, ...(paperStatus ? { paperStatus } : {}) }));
  };
  if (source.scope === 'crossref') {
    const payload = record(JSON.parse(body) as unknown);
    for (const entry of asArray(record(payload.message).items).slice(0, 100)) {
      const item = record(entry); const parts = asArray(record(item.published)['date-parts'])[0];
      const fields = Array.isArray(parts) ? parts : [];
      const stamp = fields.length >= 3 && fields.every(value => Number.isInteger(value)) ? new Date(Date.UTC(Number(fields[0]), Number(fields[1]) - 1, Number(fields[2]))) : null;
      const date = stamp && stamp.getUTCFullYear() === fields[0] && stamp.getUTCMonth() === Number(fields[1]) - 1 && stamp.getUTCDate() === fields[2] ? stamp.toISOString() : null;
      add(asArray(item.title).map(field).join(' '), field(item.URL), date, item.type === 'posted-content' ? 'preprint' : ['journal-article', 'proceedings-article'].includes(field(item.type)) ? 'published' : 'unknown', item.abstract);
    }
  } else if (source.scope === 'github') {
    for (const release of asArray(JSON.parse(body) as unknown).slice(0, 30)) { const item = record(release); if (!item.draft) add(field(item.name) || field(item.tag_name), field(item.html_url), field(item.published_at), undefined, item.body); }
  } else if (/xml|rss|atom/iu.test(mime) || source.feedUrl || source.scope === 'feed') {
    const parsed = record(new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false }).parse(body) as unknown);
    const channel = record(record(parsed.rss).channel); const feed = record(parsed.feed);
    const items = asArray(channel.item ?? feed.entry);
    if (!Object.keys(channel).length && !Object.keys(feed).length) throw new Error('Source returned an invalid feed, not an article list.');
    for (const entry of items.slice(0, 100)) { const item = record(entry); const link = asArray(item.link).find(value => !record(value)['@_rel'] || record(value)['@_rel'] === 'alternate'); add(field(item.title), typeof link === 'string' ? link : field(record(link)['@_href']), field(item.pubDate ?? item.published ?? item.updated) || null, undefined, item.description ?? item.summary ?? item.content); }
  } else {
    const { document } = parseHTML(body);
    for (const element of document.querySelectorAll('nav,header,footer,script,style')) element.remove();
    for (const anchor of [...document.querySelectorAll('article a[href],main h2 a[href],main h3 a[href],.news_list a[href]')].slice(0, 100)) add(anchor.textContent ?? '', anchor.getAttribute('href') ?? '', null);
  }
  return output;
}
export async function collectSource(source: SourcePreference, signal?: AbortSignal): Promise<DiscoverySignal[]> {
  if (!source.enabled || ['disabled', 'requires_authorization'].includes(source.access)) return [];
  if (source.scope === 'page') {
    const page = await fetchPublicPage(source.url, signal); const parsed = parseEvidencePage(page.body, page.mime, page.url);
    return [signalSchema.parse({ id: evidenceHash([source.id, page.url]), sourceId: source.id, url: page.url, title: parsed.title, publishedAt: parsed.publishedAt, observedAt: new Date().toISOString(), topicKey: topicKey(parsed.title) })];
  }
  if (source.scope === 'hn') {
    const response = await fetchPublicPage('https://hacker-news.firebaseio.com/v0/topstories.json', signal);
    const ids = z.array(z.number().int().positive()).parse(JSON.parse(response.body)).slice(0, 20);
    const items: DiscoverySignal[] = [];
    for (const id of ids) {
      const page = await fetchPublicPage(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, signal);
      const item = z.object({ title: z.string().optional(), url: z.string().optional(), time: z.number().optional(), score: z.number().optional(), deleted: z.boolean().optional() }).parse(JSON.parse(page.body));
      if (item.deleted || !item.title) continue;
      items.push(signalSchema.parse({ id: evidenceHash(['hn', id]), sourceId: source.id, title: item.title, url: item.url ?? `https://news.ycombinator.com/item?id=${id}`, publishedAt: item.time ? new Date(item.time * 1000).toISOString() : null, observedAt: new Date().toISOString(), topicKey: topicKey(item.title), score: item.score ?? null }));
    }
    return items;
  }
  const url = source.scope === 'github' ? source.url.replace(/^https:\/\/github.com\/([^/]+)\/([^/]+)\/?$/u, 'https://api.github.com/repos/$1/$2/releases') : source.feedUrl ?? source.url;
  const page = await fetchPublicPage(url, signal);
  const result = parseSourceSignals(source, page.body, page.mime);
  if (!result.length) throw new Error('Source returned no readable discovery entries.');
  return result;
}
export async function probeSource(workspace: string, source: SourcePreference): Promise<Record<string, unknown>> {
  const previous = (await listSources(workspace)).find(item => item.source.id === source.id)?.health ?? {};
  let status = 'discovered'; let observedUrl: string | null = null;
  if (source.access === 'requires_authorization' || /(^|\.)reddit\.com$/u.test(new URL(source.url).hostname)) status = 'authorization_required';
  else if (source.access === 'disabled' || !source.enabled) status = 'unavailable';
  else {
    try {
      const signal = AbortSignal.timeout(45000);
      const url = source.scope === 'page' ? source.url : (await collectSource(source, signal))[0]?.url;
      if (url) {
        const page = await fetchPublicPage(url, signal); observedUrl = page.url;
        if (page.mime !== 'application/pdf') {
          try { status = parseEvidencePage(page.body, page.mime, page.url).access === 'full' ? 'readable' : 'partial'; } catch { status = 'discovered'; }
        }
      } else status = 'unavailable';
    } catch { status = source.access === 'discovery_only' ? 'discovered' : 'unavailable'; }
  }
  const health = { ...previous, accessStatus: status, bodyCheckedAt: new Date().toISOString(), observedUrl };
  await dbRequest(`studio_source_registry?workspace_id=eq.${z.uuid().parse(workspace)}&id=eq.${source.id}`, { method: 'PATCH', body: { health } });
  return health;
}
export async function sourceSignals(workspace: string, sourceIds: string[], freshnessHours: number): Promise<DiscoverySignal[]> {
  const rows = z.array(z.object({ metadata: signalSchema })).parse(await dbRequest(`studio_source_signals?workspace_id=eq.${z.uuid().parse(workspace)}&observed_at=gte.${encodeURIComponent(new Date(Date.now() - freshnessHours * 3600000).toISOString())}&order=observed_at.desc&limit=500`));
  return rows.map(row => row.metadata).filter(item => sourceIds.includes(item.sourceId));
}
export async function processSourceCollection(workspace: string, id: string, token: string, signal: AbortSignal): Promise<void> {
  const row = z.array(z.object({ config: sourcePreferenceSchema, status: z.string() })).parse(await dbRequest(`studio_source_collections?workspace_id=eq.${z.uuid().parse(workspace)}&id=eq.${z.uuid().parse(id)}`))[0];
  if (!row || row.status !== 'queued') return;
  let signals: DiscoverySignal[] = []; let error: string | null = null;
  try { signals = await collectSource(row.config, signal); } catch { signal.throwIfAborted(); error = 'Source unavailable, stale or unparseable. Check its public feed or access permission.'; }
  const ref = await new EvidenceFiles().put(signals);
  await dbRpc('studio_finish_source', { p_workspace: workspace, p_job: id, p_token: token, p_result: ref, p_signals: signals, p_error: error });
}
