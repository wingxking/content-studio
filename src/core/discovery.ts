import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

export const discoveryCountries = ['US', 'IN', 'GB', 'ZA'] as const;
export const discoveryCountrySchema = z.enum(discoveryCountries);
export type DiscoveryCountry = z.infer<typeof discoveryCountrySchema>;
const freshnessHoursSchema = z.union([z.literal(4), z.literal(24), z.literal(48), z.literal(168)]);
const settingsSchema = z.object({
  countries: z.array(discoveryCountrySchema).min(1).max(4).refine(values => new Set(values).size === values.length, 'Countries must be unique'),
  freshnessHours: freshnessHoursSchema,
  timeoutMs: z.number().int().min(10).max(15000),
  maxBytes: z.number().int().min(128).max(1048576),
  maxFutureSkewMs: z.number().int().min(0).max(300000),
}).strict();
export type DiscoverySettings = z.infer<typeof settingsSchema>;
export const defaultDiscoverySettings: DiscoverySettings = {
  countries: [...discoveryCountries], freshnessHours: 24, timeoutMs: 12000, maxBytes: 1048576, maxFutureSkewMs: 300000,
};
export const feedUrlFor = (country: DiscoveryCountry): string => `https://trends.google.com/trending/rss?geo=${discoveryCountrySchema.parse(country)}`;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const topicKey = (title: string): string => title.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
const textField = z.string().trim().min(1).max(300);
const rawItemSchema = z.object({ title: textField, pubDate: z.string().min(1).max(100), 'ht:approx_traffic': z.string().min(1).max(50), 'ht:news_item': z.array(z.unknown()).max(20).optional() }).passthrough();
const rawNewsSchema = z.object({ 'ht:news_item_title': textField, 'ht:news_item_url': z.string().min(1).max(4096), 'ht:news_item_source': textField }).passthrough();
const rawFeedSchema = z.object({ rss: z.object({ '@_version': z.literal('2.0'), '@_xmlns:ht': z.literal('https://trends.google.com/trending/rss'), channel: z.object({ item: z.array(z.unknown()).max(200).optional() }).passthrough() }).passthrough() }).passthrough();

export interface NewsReference {
  id: string;
  title: string;
  url: string;
  publisherLabel: string;
  publishedAt: null;
  discoveredAt: string;
  country: DiscoveryCountry;
  verification: 'unverified_feed_reference';
}
export interface TrendObservation {
  id: string;
  topic: string;
  topicKey: string;
  country: DiscoveryCountry;
  feedUrl: string;
  feedPublishedAt: string;
  discoveredAt: string;
  trafficBucket: string;
  trafficLowerBound: number;
  trafficWindow: 'not_declared_by_rss';
  news: NewsReference[];
}
export interface FeedSkipped {
  invalidItems: number;
  staleItems: number;
  futureItems: number;
  duplicateItems: number;
  invalidNews: number;
  duplicateNews: number;
}
export interface FeedSuccess {
  country: DiscoveryCountry;
  url: string;
  fetchedAt: string;
  status: 'ok';
  skipped: FeedSkipped;
  observations: TrendObservation[];
}
export interface FeedFailure {
  country: DiscoveryCountry;
  url: string;
  fetchedAt: string;
  status: 'failed';
  error: string;
}
export type FeedResult = FeedSuccess | FeedFailure;
export interface TrendCandidate {
  id: string;
  topic: string;
  normalizedTopic: string;
  countries: DiscoveryCountry[];
  countryCoverage: number;
  earliestFeedPublishedAt: string;
  latestFeedPublishedAt: string;
  discoveredAt: string;
  observations: TrendObservation[];
  news: NewsReference[];
  verification: 'requires_independent_source_check';
}
export interface DiscoverySnapshot {
  version: 1;
  provider: 'google_trends_rss';
  collectedAt: string;
  requestedCountries: DiscoveryCountry[];
  successfulCountries: DiscoveryCountry[];
  failedCountries: DiscoveryCountry[];
  freshness: { field: 'rss_item_pubDate'; hours: number; from: string; through: string; allowedFutureSkewMs: number };
  trafficWindow: 'not_declared_by_rss';
  ranking: { rule: 'selected_country_coverage_desc_then_topic_asc'; geography: 'selected_countries_only'; caveat: string };
  feeds: FeedResult[];
  candidates: TrendCandidate[];
}
export type DiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface DiscoveryDependencies { fetcher?: DiscoveryFetch; now?: Date }

function rejectUnsafeXml(xml: string, maxBytes: number): void {
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) throw new Error('RSS exceeds byte limit');
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('DTD and entity declarations are prohibited');
  if (/<\?(?!xml(?:\s|\?))/iu.test(xml)) throw new Error('XML processing instructions are prohibited');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(xml)) throw new Error('Invalid XML control character');
  const structural = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/gu, '');
  let depth = 0;
  let tokens = 0;
  for (const match of structural.matchAll(/<\/?([A-Za-z_][\w:.-]*)\b[^>]*>/gu)) {
    const token = match[0];
    const name = match[1];
    if (!name || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('Unsafe XML element');
    tokens++;
    if (tokens > 12000) throw new Error('Too many XML elements');
    if (token.startsWith('</')) depth--;
    else if (!token.endsWith('/>')) depth++;
    if (depth > 32) throw new Error('XML nesting exceeds limit');
  }
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed XML');
}

function canonicalNewsUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || isIP(host) !== 0 || !host.includes('.') || !/^[a-z0-9.-]+$/u.test(host) || /(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/u.test(host)) throw new Error('Invalid news reference URL');
  url.hash = '';
  return url.href;
}

function parseTraffic(value: string): { bucket: string; lowerBound: number } {
  const match = /^(\d[\d,]*)(?:\.(\d+))?\s*([KMB])?\+$/iu.exec(value.trim());
  if (!match) throw new Error('Unknown traffic bucket');
  const base = Number(`${match[1]?.replaceAll(',', '')}${match[2] ? `.${match[2]}` : ''}`);
  const unit = match[3]?.toUpperCase();
  const lowerBound = base * (unit === 'K' ? 1000 : unit === 'M' ? 1000000 : unit === 'B' ? 1000000000 : 1);
  if (!Number.isSafeInteger(lowerBound) || lowerBound < 0) throw new Error('Invalid traffic bucket');
  return { bucket: value.trim(), lowerBound };
}

export function parseTrendsFeed(xml: string, country: DiscoveryCountry, fetchedAt: Date, input: DiscoverySettings = defaultDiscoverySettings): FeedSuccess {
  const settings = settingsSchema.parse(input);
  discoveryCountrySchema.parse(country);
  if (!Number.isFinite(fetchedAt.getTime())) throw new Error('Invalid collection time');
  rejectUnsafeXml(xml, settings.maxBytes);
  const parser = new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true, parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: true, isArray: (_tagName, path) => path === 'rss.channel.item' || path === 'rss.channel.item.ht:news_item' });
  const parsed: unknown = parser.parse(xml);
  const document = rawFeedSchema.parse(parsed);
  const skipped: FeedSkipped = { invalidItems: 0, staleItems: 0, futureItems: 0, duplicateItems: 0, invalidNews: 0, duplicateNews: 0 };
  const observations: TrendObservation[] = [];
  const seen = new Set<string>();
  for (const raw of document.rss.channel.item ?? []) {
    const result = rawItemSchema.safeParse(raw);
    if (!result.success) { skipped.invalidItems++; continue; }
    const item = result.data;
    const published = Date.parse(item.pubDate);
    if (!Number.isFinite(published)) { skipped.invalidItems++; continue; }
    if (published < fetchedAt.getTime() - settings.freshnessHours * 3600000) { skipped.staleItems++; continue; }
    if (published > fetchedAt.getTime() + settings.maxFutureSkewMs) { skipped.futureItems++; continue; }
    let traffic: { bucket: string; lowerBound: number };
    try { traffic = parseTraffic(item['ht:approx_traffic']); } catch { skipped.invalidItems++; continue; }
    const normalized = topicKey(item.title);
    if (!normalized) { skipped.invalidItems++; continue; }
    const itemId = digest(`${country}\n${normalized}\n${new Date(published).toISOString()}`);
    if (seen.has(itemId)) { skipped.duplicateItems++; continue; }
    seen.add(itemId);
    const news: NewsReference[] = [];
    const newsIds = new Set<string>();
    for (const rawNews of item['ht:news_item'] ?? []) {
      const newsResult = rawNewsSchema.safeParse(rawNews);
      if (!newsResult.success) { skipped.invalidNews++; continue; }
      const reference = newsResult.data;
      let url: string;
      try { url = canonicalNewsUrl(reference['ht:news_item_url']); } catch { skipped.invalidNews++; continue; }
      const id = digest(url);
      if (newsIds.has(id)) { skipped.duplicateNews++; continue; }
      newsIds.add(id);
      news.push({ id, title: reference['ht:news_item_title'], url, publisherLabel: reference['ht:news_item_source'], publishedAt: null, discoveredAt: fetchedAt.toISOString(), country, verification: 'unverified_feed_reference' });
    }
    observations.push({ id: itemId, topic: item.title, topicKey: normalized, country, feedUrl: feedUrlFor(country), feedPublishedAt: new Date(published).toISOString(), discoveredAt: fetchedAt.toISOString(), trafficBucket: traffic.bucket, trafficLowerBound: traffic.lowerBound, trafficWindow: 'not_declared_by_rss', news });
  }
  return { country, url: feedUrlFor(country), fetchedAt: fetchedAt.toISOString(), status: 'ok', skipped, observations };
}

async function fetchTrendsFeed(country: DiscoveryCountry, now: Date, settings: DiscoverySettings, fetcher: DiscoveryFetch): Promise<FeedSuccess> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new Error('RSS request timed out'));
    }, settings.timeoutMs);
  });
  const request = async (): Promise<FeedSuccess> => {
    const response = await fetcher(feedUrlFor(country), { signal: controller.signal, redirect: 'manual', headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
    if (response.status >= 300 && response.status < 400) throw new Error('RSS redirects are prohibited');
    if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!mime || !['application/rss+xml', 'application/xml', 'text/xml'].includes(mime)) throw new Error('Unexpected RSS content type');
    const declaredLength = response.headers.get('content-length');
    if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > settings.maxBytes)) throw new Error('RSS exceeds byte limit');
    if (!response.body) throw new Error('RSS response has no body');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > settings.maxBytes) throw new Error('RSS exceeds byte limit');
      chunks.push(chunk.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return parseTrendsFeed(text, country, now, settings);
  };
  try { return await Promise.race([request(), deadline]); }
  finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

export function rankTrendCandidates(feeds: FeedResult[], collectedAt: string): TrendCandidate[] {
  const groups = new Map<string, TrendObservation[]>();
  for (const feed of feeds) {
    if (feed.status !== 'ok') continue;
    for (const observation of feed.observations) {
      const values = groups.get(observation.topicKey) ?? [];
      values.push(observation);
      groups.set(observation.topicKey, values);
    }
  }
  const candidates: TrendCandidate[] = [];
  for (const [normalizedTopic, observations] of groups) {
    const first = observations[0];
    if (!first) continue;
    const countries = discoveryCountries.filter(country => observations.some(value => value.country === country));
    const dates = observations.map(value => value.feedPublishedAt).sort();
    const news = [...new Map(observations.flatMap(value => value.news).map(reference => [reference.id, reference])).values()];
    candidates.push({ id: digest(normalizedTopic), topic: first.topic, normalizedTopic, countries, countryCoverage: countries.length, earliestFeedPublishedAt: dates[0] ?? first.feedPublishedAt, latestFeedPublishedAt: dates.at(-1) ?? first.feedPublishedAt, discoveredAt: collectedAt, observations, news, verification: 'requires_independent_source_check' });
  }
  return candidates.sort((left, right) => right.countryCoverage - left.countryCoverage || (left.normalizedTopic < right.normalizedTopic ? -1 : left.normalizedTopic > right.normalizedTopic ? 1 : 0));
}

export async function discoverTrends(input: Partial<DiscoverySettings> = {}, dependencies: DiscoveryDependencies = {}): Promise<DiscoverySnapshot> {
  const settings = settingsSchema.parse({ ...defaultDiscoverySettings, ...input });
  const now = dependencies.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid collection time');
  const collectedAt = now.toISOString();
  const fetcher = dependencies.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
  const feeds: FeedResult[] = await Promise.all(settings.countries.map(async country => {
    try { return await fetchTrendsFeed(country, now, settings, fetcher); }
    catch (error) { return { country, url: feedUrlFor(country), fetchedAt: collectedAt, status: 'failed' as const, error: error instanceof Error ? error.message.slice(0, 500) : 'RSS collection failed' }; }
  }));
  return {
    version: 1, provider: 'google_trends_rss', collectedAt, requestedCountries: settings.countries,
    successfulCountries: feeds.filter(feed => feed.status === 'ok').map(feed => feed.country),
    failedCountries: feeds.filter(feed => feed.status === 'failed').map(feed => feed.country),
    freshness: { field: 'rss_item_pubDate', hours: settings.freshnessHours, from: new Date(now.getTime() - settings.freshnessHours * 3600000).toISOString(), through: collectedAt, allowedFutureSkewMs: settings.maxFutureSkewMs },
    trafficWindow: 'not_declared_by_rss',
    ranking: { rule: 'selected_country_coverage_desc_then_topic_asc', geography: 'selected_countries_only', caveat: 'Ranks exact normalized query matches by presence in selected successful country feeds, with lexical tie-breaks. This sample is not global coverage or a global popularity rank. Traffic buckets are never summed, RSS dates are not article dates, associated news can be unrelated, and every factual claim requires independent source verification.' },
    feeds, candidates: rankTrendCandidates(feeds, collectedAt),
  };
}
