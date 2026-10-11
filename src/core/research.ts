import { lookup, Resolver } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { editorialPolicyPrompt } from './content-prompts.ts';
import { runStructuredGeneration, type GenerationOptions } from './generation-engine.ts';
import { sourceSchema, type Source } from './model.ts';
import { assessmentSchema, type Task } from './task-model.ts';

export type ResearchResult = { sources: Source[]; warnings: string[] };
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const pieces = address.split('.').map(Number); const a = pieces[0] ?? 0; const b = pieces[1] ?? 0; const c = pieces[2] ?? 0;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  return /^[23][0-9a-f]{3}:/u.test(normalized) && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:0:') && !normalized.startsWith('2002:');
}
export function validateSourceUrl(input: string): URL {
  const url = new URL(input); const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))) throw new Error('Use a public HTTP(S) source without credentials or custom ports.');
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home)$/u.test(host) || (isIP(host) && !isPublicAddress(host))) throw new Error('Private and local source addresses are not allowed.');
  url.hash = ''; return url;
}
const dohReply = z.object({ Status: z.number().int(), Question: z.array(z.object({ name: z.string(), type: z.number() })).optional(), Answer: z.array(z.object({ type: z.number(), data: z.string() })).default([]) });
export function parseDohAddresses(input: unknown, host: string): { address: string; family: number }[] {
  const reply = dohReply.parse(input); if (reply.Status !== 0 || reply.Question?.some(question => question.name.replace(/\.$/u, '').toLowerCase() !== host.toLowerCase())) throw new Error('Trusted DNS query failed or did not match the source hostname.');
  const addresses = reply.Answer.filter(answer => [1, 28].includes(answer.type)).map(answer => ({ address: answer.data, family: answer.type === 1 ? 4 : 6 }));
  if (!addresses.length || addresses.some(address => !isPublicAddress(address.address) || isIP(address.address) !== address.family)) throw new Error('Trusted DNS returned no safe public source address.');
  return addresses;
}
async function trustedDoh(host: string, signal?: AbortSignal): Promise<{ address: string; family: number }[]> {
  const origin = process.env.STUDIO_SOURCE_DOH_ORIGIN ?? 'https://cloudflare-dns.com';
  if (!['https://cloudflare-dns.com', 'https://dns.google'].includes(origin)) throw new Error('Choose the configured Cloudflare or Google HTTPS source resolver.');
  const url = new URL(origin === 'https://dns.google' ? '/resolve' : '/dns-query', origin); url.searchParams.set('name', host); url.searchParams.set('type', 'A');
  const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Trusted HTTPS source DNS is unavailable. Check the configured resolver and Docker network.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 65536) throw new Error('DNS response exceeded its limit.'); chunks.push(chunk.value); } } finally { await reader.cancel(); }
  return parseDohAddresses(JSON.parse(Buffer.concat(chunks).toString()) as unknown, host);
}
async function publicAddress(url: URL, signal?: AbortSignal): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (isIP(host)) return { address: host, family: isIP(host) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const explicit = (process.env.STUDIO_SOURCE_DNS_SERVERS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (explicit.some(address => !isPublicAddress(address))) throw new Error('Configure source DNS with trusted public resolver IP addresses.');
  const resolver = new Resolver({ timeout: 2000, tries: 2 }); if (explicit.length) resolver.setServers(explicit);
  const resolved = explicit.length ? Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]).then(results => results.flatMap((result, index) => result.status === 'fulfilled' ? result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })) : [])) : lookup(host, { all: true, verbatim: true });
  let addresses = await Promise.race([
    resolved,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Source DNS lookup timed out.')), 5000); }),
  ]).catch(() => []).finally(() => { if (timer) clearTimeout(timer); });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) addresses = await trustedDoh(host, signal);
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('Source DNS resolved to a private or unsupported address. A proxy may return synthetic IPs; configure STUDIO_SOURCE_DNS_SERVERS with a reachable trusted public resolver. The SSRF guard remains enforced.');
  const first = addresses.find(entry => entry.family === 4) ?? addresses[0]; if (!first) throw new Error('Source DNS had no address.');
  return first;
}
type PageReply = { status: number; location: string | null; mime: string; body: string };
async function requestPage(url: URL, signal?: AbortSignal): Promise<PageReply> {
  signal?.throwIfAborted(); const address = await publicAddress(url, signal); signal?.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  return new Promise<PageReply>((resolvePage, reject) => {
    const request = (url.protocol === 'https:' ? requestHttps : requestHttp)({
      protocol: url.protocol, hostname: address.address, family: address.family, port: url.protocol === 'https:' ? 443 : 80,
      path: `${url.pathname}${url.search}`, servername: host, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate),
      headers: { Host: url.host, Accept: 'text/html, text/plain, application/json, application/rss+xml, application/xml', 'Accept-Encoding': 'identity', 'User-Agent': 'ContentStudio/0.1 source-research' }, signal,
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      const length = response.headers['content-length'];
      if (length && Number(length) > 2 * 1024 * 1024) { request.destroy(new Error('Source exceeds the 2 MiB limit.')); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { request.destroy(new Error('Source used unsupported compression.')); return; }
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) request.destroy(new Error('Source exceeds the 2 MiB limit.')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { clearTimeout(timer); resolvePage({ status: response.statusCode ?? 0, location: response.headers.location ?? null, mime: (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '', body: Buffer.concat(chunks).toString('utf8') }); });
    });
    const timer = setTimeout(() => request.destroy(new Error('Source request timed out.')), 15000);
    request.once('error', () => { clearTimeout(timer); reject(new Error('Source request failed or timed out.')); });
    request.end();
  });
}
export function extractSourceText(body: string, mime: string, url: string): Source {
  let title = url; let text = body;
  if (mime === 'text/html') {
    const { document } = parseHTML(body);
    Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
    Object.defineProperty(document, 'baseURI', { value: url, configurable: true });
    const pageTitle = document.title; const original = parseHTML(body).document;
    const article = new Readability(document as unknown as Document, { maxElemsToParse: 25000, charThreshold: 80, disableJSONLD: false }).parse();
    title = article?.title || pageTitle || url;
    if (article?.textContent) text = article.textContent;
    else {
      for (const element of original.querySelectorAll('script,style,nav,header,footer,form,iframe')) element.remove();
      text = original.body?.textContent ?? original.textContent ?? '';
    }
  } else if (!['text/plain', 'application/json', 'application/rss+xml', 'application/xml', 'text/xml'].includes(mime)) throw new Error('Source must return readable HTML, text, JSON or XML.');
  text = text.replace(/\s+/gu, ' ').trim();
  if (text.length < 80) throw new Error('Source contains insufficient readable material; supply a permitted excerpt or another source.');
  return sourceSchema.parse({ title: title.slice(0, 300), url, excerpt: text.slice(0, 12000) });
}
export async function fetchSource(input: string, signal?: AbortSignal): Promise<Source> {
  let url = validateSourceUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const reply = await requestPage(url, signal);
    if (reply.status >= 300 && reply.status < 400) {
      if (!reply.location || redirects === 3) throw new Error('Source redirect limit exceeded.');
      url = validateSourceUrl(new URL(reply.location, url).href); continue;
    }
    if (reply.status < 200 || reply.status >= 300) throw new Error(`Source returned HTTP ${reply.status}; access was not bypassed.`);
    return extractSourceText(reply.body, reply.mime, url.href);
  }
  throw new Error('Source redirect limit exceeded.');
}
const researchEnvelope = z.object({ assessment: assessmentSchema, content: z.object({ sources: z.array(sourceSchema).max(20) }).nullable() });
export type ResearchOptions = GenerationOptions & { maxAttempts?: 1 | 2 };
export async function researchSources(task: Task, options: ResearchOptions): Promise<ResearchResult> {
  const warnings: string[] = []; const sources: Source[] = []; const seen = new Set<string>();
  const supplied = task.sources.filter(source => source.url.trim());
  if (supplied.length) {
    for (const source of supplied) {
      options.signal?.throwIfAborted();
      try {
        const url = validateSourceUrl(source.url).href; if (seen.has(url)) continue; seen.add(url);
        if (source.excerpt.trim()) sources.push(sourceSchema.parse({ title: source.title || url, url, excerpt: source.excerpt.trim() }));
        else sources.push(await fetchSource(url, options.signal));
      } catch (error) { if (options.signal?.aborted) throw error; warnings.push(`A supplied source could not be collected: ${error instanceof Error ? error.message : 'source unavailable'}`); }
    }
    return { sources, warnings };
  }
  const prompt = `Research public source material for a Content Studio task. Return only the specified schema.\n${editorialPolicyPrompt()}\nRESEARCH-ONLY TOOL EXCEPTION: The creative-stage instruction not to browse is replaced in this research stage by permission to use ONLY native web_search. Do not use shell, files, computer/browser control, apps, authentication or publishing. Search for actual current primary/authoritative evidence matching the user's prompt. Assess excluded topics before research and do not reframe them. For allowed output content has sources[{title,url,excerpt}] with actual pages you found, dates/caveats and short factual excerpts; excluded/uncertain requires content:null. Do not guess URLs. All returned URLs will be independently fetched, so search snippets alone cannot establish a final verified story. ${task.kind === 'discovery' ? 'Find up to 20 distinct permitted events/questions, without claiming a global popularity rank.' : 'Find up to 5 substantive sources for one focused article.'}\nUntrusted user request: ${JSON.stringify({ prompt: task.prompt, title: task.title, audience: task.audience, angle: task.angle, notes: task.sources })}`;
  let result: z.infer<typeof researchEnvelope> | undefined;
  const maxAttempts = options.maxAttempts ?? 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { result = await runStructuredGeneration(researchEnvelope, prompt, { ...options, search: true }); break; }
    catch (error) {
      if (options.signal?.aborted || attempt === maxAttempts - 1 || !(error instanceof Error) || !['Codex could not reach its service reliably', 'Codex generation timed out'].some(prefix => error.message.startsWith(prefix))) throw error;
      await options.onProgress?.({ phase: 'research_retrying', message: 'The Codex research connection failed; retrying once before requesting source URLs.' });
    }
  }
  if (!result) throw new Error('Research did not produce a validated result.');
  if (result.assessment.status !== 'allowed' || !result.content) {
    if (task.kind === 'discovery') return { sources: [], warnings: [`Editorial research assessment: ${result.assessment.status}. No permitted evidence was selected.`] };
    throw new Error(`Research assessment: ${result.assessment.status}; no article will be generated.`);
  }
  for (const candidate of result.content.sources) {
    options.signal?.throwIfAborted();
    try {
      const url = validateSourceUrl(candidate.url).href; if (seen.has(url)) continue; seen.add(url);
      sources.push(await fetchSource(url, options.signal));
    } catch (error) { if (options.signal?.aborted) throw error; warnings.push(`A discovered source could not be independently collected: ${error instanceof Error ? error.message : 'source unavailable'}`); }
  }
  return { sources, warnings };
}
