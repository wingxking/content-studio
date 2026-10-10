import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { defaultDiscoverySettings, discoverTrends, feedUrlFor, parseTrendsFeed, rankTrendCandidates, type DiscoveryFetch } from '../src/core/discovery.ts';

const now = new Date('2026-10-10T04:00:00.000Z');
const fixture = await readFile(new URL('./fixtures/trends-valid.xml', import.meta.url), 'utf8');
const broken = await readFile(new URL('./fixtures/trends-broken.xml', import.meta.url), 'utf8');
const response = (body: string): Response => new Response(body, { headers: { 'content-type': 'text/xml; charset=utf-8' } });
const wrap = (items: string): string => `<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>${items}</channel></rss>`;
const item = (title: string, date = 'Sat, 10 Oct 2026 03:50:00 GMT', traffic = '10000+', news = ''): string => `<item><title>${title}</title><pubDate>${date}</pubDate><ht:approx_traffic>${traffic}</ht:approx_traffic>${news}</item>`;
const news = (url: string): string => `<ht:news_item><ht:news_item_title>Reference title</ht:news_item_title><ht:news_item_url>${url}</ht:news_item_url><ht:news_item_source>Fixture publisher</ht:news_item_source></ht:news_item>`;

test('preserves country traffic buckets, feed date and unverified references without inventing article dates', () => {
  const result = parseTrendsFeed(fixture, 'US', now);
  assert.equal(result.observations.length, 2);
  const first = result.observations[0];
  assert.ok(first);
  assert.equal(first.trafficBucket, '20K+');
  assert.equal(first.trafficLowerBound, 20000);
  assert.equal(first.trafficWindow, 'not_declared_by_rss');
  assert.equal(first.feedPublishedAt, '2026-10-10T03:50:00.000Z');
  assert.equal(first.discoveredAt, now.toISOString());
  assert.equal(first.news[0]?.publishedAt, null);
  assert.equal(first.news[0]?.verification, 'unverified_feed_reference');
  assert.equal(result.skipped.duplicateNews, 1);
  assert.equal(first.news.length, 1);
});

test('rejects malformed XML and an RSS namespace impersonation', () => {
  assert.throws(() => parseTrendsFeed(broken, 'US', now), /Malformed XML/);
  assert.throws(() => parseTrendsFeed(fixture.replace('https://trends.google.com/trending/rss', 'https://attacker.com/rss'), 'US', now));
});

test('rejects DTD, external entities, entity expansion and non-XML processing instructions', () => {
  for (const prefix of [
    '<!DOCTYPE rss SYSTEM "file:///etc/passwd">',
    '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "https://attacker.com/payload">]>',
    '<!DOCTYPE rss [<!ENTITY a "xxxxxxxxxx"><!ENTITY b "&a;&a;&a;">]>',
    '<?fetch target="https://attacker.com"?>',
  ]) assert.throws(() => parseTrendsFeed(prefix + fixture, 'US', now), /prohibited/);
});

test('bounds nesting, byte size and dangerous property element names before parsing', () => {
  assert.throws(() => parseTrendsFeed('<a>'.repeat(40) + '</a>'.repeat(40), 'US', now), /nesting/);
  assert.throws(() => parseTrendsFeed(fixture, 'US', now, { ...defaultDiscoverySettings, maxBytes: 128 }), /byte limit/);
  assert.throws(() => parseTrendsFeed(wrap('<__proto__>unsafe</__proto__>'), 'US', now), /Unsafe XML/);
});

test('filters stale, far-future and malformed dates while reporting accepted clock skew', () => {
  const xml = wrap(item('fresh') + item('stale', 'Fri, 9 Oct 2026 03:59:00 GMT') + item('future', 'Sat, 10 Oct 2026 04:06:00 GMT') + item('invalid', 'not a date') + item('within-skew', 'Sat, 10 Oct 2026 04:02:00 GMT'));
  const parsed = parseTrendsFeed(xml, 'US', now);
  assert.deepEqual(parsed.observations.map(value => value.topic), ['fresh', 'within-skew']);
  assert.equal(parsed.skipped.staleItems, 1);
  assert.equal(parsed.skipped.futureItems, 1);
  assert.equal(parsed.skipped.invalidItems, 1);
});

test('deduplicates exact normalized item identifiers without treating aliases as the same event', () => {
  const parsed = parseTrendsFeed(wrap(item(' Nobel  Peace Prize ') + item('nobel peace prize') + item('Nobel laureate')), 'US', now);
  assert.equal(parsed.observations.length, 2);
  assert.equal(parsed.skipped.duplicateItems, 1);
});

test('country coverage outranks a huge single-country bucket and never aggregates traffic', () => {
  const us = parseTrendsFeed(fixture, 'US', now);
  const gb = parseTrendsFeed(wrap(item('nobel peace prize', undefined, '200+')), 'GB', now);
  const ranked = rankTrendCandidates([us, gb], now.toISOString());
  assert.equal(ranked[0]?.normalizedTopic, 'nobel peace prize');
  assert.deepEqual(ranked[0]?.countries, ['US', 'GB']);
  assert.equal(ranked[0]?.countryCoverage, 2);
  assert.deepEqual(ranked[0]?.observations.map(value => value.trafficBucket), ['20K+', '200+']);
  assert.equal('totalTraffic' in (ranked[0] ?? {}), false);
  assert.equal('globalRank' in (ranked[0] ?? {}), false);
});

test('multiple observations from one country cannot inflate country coverage or news evidence count', () => {
  const us = parseTrendsFeed(wrap(item('same topic', undefined, '10000+', news('https://example.com/one')) + item('same topic', 'Sat, 10 Oct 2026 03:40:00 GMT', '20000+', news('https://example.com/one'))), 'US', now);
  const candidate = rankTrendCandidates([us], now.toISOString())[0];
  assert.equal(candidate?.countryCoverage, 1);
  assert.equal(candidate?.news.length, 1);
  assert.equal(candidate?.observations.length, 2);
});

test('a news URL never becomes a network target and invalid credential/private references are discarded', async () => {
  const requests: string[] = [];
  const xml = wrap(item('topic', undefined, '10K+', news('https://example.com/article') + news('https://127.0.0.1/data') + news('https://user:password@example.com/secret') + news('javascript:alert(1)')));
  const snapshot = await discoverTrends({ countries: ['US'] }, { now, fetcher: async (url, init) => { requests.push(url); assert.equal(init.redirect, 'manual'); return response(xml); } });
  assert.deepEqual(requests, [feedUrlFor('US')]);
  const feed = snapshot.feeds[0];
  assert.equal(feed?.status, 'ok');
  if (feed?.status === 'ok') assert.equal(feed.skipped.invalidNews, 3);
  assert.equal(snapshot.candidates[0]?.news.length, 1);
});

test('one broken country is explicit partial failure and does not discard valid feeds', async () => {
  const fetcher: DiscoveryFetch = async url => response(url.endsWith('geo=IN') ? broken : fixture);
  const snapshot = await discoverTrends({ countries: ['US', 'IN', 'GB'] }, { now, fetcher });
  assert.deepEqual(snapshot.successfulCountries, ['US', 'GB']);
  assert.deepEqual(snapshot.failedCountries, ['IN']);
  assert.equal(snapshot.candidates[0]?.countryCoverage, 2);
  assert.equal(snapshot.ranking.geography, 'selected_countries_only');
  assert.match(snapshot.ranking.caveat, /not global/);
  assert.equal(snapshot.freshness.field, 'rss_item_pubDate');
});

test('rejects countries outside allowlist and duplicated countries before making requests', async () => {
  let calls = 0;
  const fetcher: DiscoveryFetch = async () => { calls++; return response(fixture); };
  await assert.rejects(discoverTrends({ countries: ['US', 'US'] }, { now, fetcher }));
  assert.throws(() => feedUrlFor('ZZ' as 'US'));
  assert.equal(calls, 0);
});

test('does not follow redirects or accept HTML responses', async () => {
  for (const result of [new Response(null, { status: 302, headers: { location: 'https://attacker.com' } }), new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })]) {
    let calls = 0;
    const snapshot = await discoverTrends({ countries: ['US'] }, { now, fetcher: async () => { calls++; return result; } });
    assert.equal(calls, 1);
    assert.deepEqual(snapshot.failedCountries, ['US']);
    assert.equal(snapshot.candidates.length, 0);
  }
});

test('rejects oversized declared and streamed bodies, including absent Content-Length', async () => {
  for (const result of [new Response('small', { headers: { 'content-type': 'text/xml', 'content-length': '9999999' } }), response('x'.repeat(1025))]) {
    const snapshot = await discoverTrends({ countries: ['US'], maxBytes: 1024 }, { now, fetcher: async () => result });
    assert.deepEqual(snapshot.failedCountries, ['US']);
    const feed = snapshot.feeds[0];
    if (feed?.status === 'failed') assert.match(feed.error, /byte limit/);
  }
});

test('bounds stalled headers and stalled streamed bodies with one overall deadline', async () => {
  for (const fetcher of [
    async (): Promise<Response> => new Promise(() => undefined),
    async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { headers: { 'content-type': 'text/xml' } }),
  ]) {
    const snapshot = await discoverTrends({ countries: ['US'], timeoutMs: 10 }, { now, fetcher });
    const feed = snapshot.feeds[0];
    assert.equal(feed?.status, 'failed');
    if (feed?.status === 'failed') assert.match(feed.error, /timed out/);
  }
});

test('invalid UTF-8 and invalid traffic buckets cannot turn into candidate content', async () => {
  const invalidBytes = new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'text/xml' } });
  const snapshot = await discoverTrends({ countries: ['US'] }, { now, fetcher: async () => invalidBytes });
  assert.deepEqual(snapshot.failedCountries, ['US']);
  const parsed = parseTrendsFeed(wrap(item('unsupported traffic', undefined, 'many searches')), 'US', now);
  assert.equal(parsed.observations.length, 0);
  assert.equal(parsed.skipped.invalidItems, 1);
});
