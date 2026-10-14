import { readFile, mkdir, copyFile, chmod, stat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveMediaLocation, isManagedMediaPath } from './media-location.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountSchema } from './model.ts';
import { withAccountExecution } from './account-execution.ts';
import type { Job } from './model.ts';
import { executorRequestSchema, executionResultSchema } from './execution-contract.ts';
import { accountExecutionSignal, markAccountDispatch, accountExecutionFence } from './account-execution.ts';

export const browserPublisherConfigSchema = z.object({ version: z.literal(1), serviceKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), sessionId: z.uuid(), fixturesEnabled: z.boolean().default(false), fixtureScenario: z.enum(['normal', 'lost', 'empty-id', 'incomplete']).default('normal') }).strict();
export async function browserPublisherConfig() {
  try { return browserPublisherConfigSchema.parse(JSON.parse(await readFile(process.env.STUDIO_BROWSER_CONFIG ?? '/data/browser-publisher/config.json', 'utf8')) as unknown); }
  catch { throw new Error('Configure the optional browser executor in its private Docker root.'); }
}
export async function browserPublisherRequest(path: '/request' | '/session', body: unknown, signal?: AbortSignal): Promise<unknown> {
  const config = await browserPublisherConfig(); const timeout = AbortSignal.timeout(35000); const signals = [timeout, signal, accountExecutionSignal()].filter((item): item is AbortSignal => Boolean(item));
  if (path === '/request') { const request = executorRequestSchema.parse(body); if (request.operation === 'publish') { if (!accountExecutionFence()) throw new Error('Browser submission requires durable account ownership.'); await markAccountDispatch(); } }
  const response = await fetch(`http://browser-publisher:8916${path}`, { method: 'POST', headers: { Authorization: `Bearer ${config.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any(signals), redirect: 'error' });
  if (!response.ok) throw new Error('The browser executor is unavailable or rejected the request.');
  const text = await response.text(); if (text.length > 16384) throw new Error('Browser executor result exceeds its contract.');
  return JSON.parse(text) as unknown;
}
export async function collectBrowserJobMetrics(job: Job) {
  const config = await browserPublisherConfig(); const snapshot = job.snapshot;
  if (!snapshot?.executorSessionId || !snapshot.executorAccountId || !['browser', 'browser-fixture'].includes(snapshot.executorKind ?? '') || snapshot.executorVersion !== 1 || config.sessionId !== snapshot.executorSessionId) throw new Error('No verified browser metrics route exists for this work.');
  const request = executorRequestSchema.parse({ version: 1, operation: 'collect_metrics', platform: job.platform, sessionId: config.sessionId, expectedAccountId: snapshot.executorAccountId, jobId: job.id, attemptId: randomUUID(), contentHash: job.contentHash, revision: job.subject?.revision ?? snapshot.draft?.revision ?? 1, ownerToken: randomUUID(), deadline: new Date(Date.now() + 30000).toISOString(), title: snapshot.variant.title, text: snapshot.variant.text, symbols: [], assets: [], remoteId: job.remoteId });
  const result = await browserPublisherRequest('/request', request); const failed = executionResultSchema.safeParse(result); if (failed.success) throw new Error('Browser metrics are blocked until account permission and readback are verified.');
  return result;
}

export async function stageBrowserAssets(job: Job, attemptId: string) {
  if (!job.snapshot || !job.mediaHashes?.length || job.mediaHashes.length !== job.snapshot.variant.mediaPaths.length) throw new Error('Reviewed immutable image hashes are required for browser staging.');
  const root = process.env.STUDIO_BROWSER_STAGING ?? '/data/browser-staging'; await mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await realpath(root); const directory = join(parent, z.uuid().parse(attemptId)); await mkdir(directory, { mode: 0o700 });
  const canonical = await realpath(directory); if (!canonical.startsWith(`${parent}${sep}`)) throw new Error('Task staging escapes its private root.');
  const assets: z.infer<typeof executorRequestSchema>['assets'] = [];
  for (let index = 0; index < job.snapshot.variant.mediaPaths.length; index++) {
    const location = job.snapshot.variant.mediaPaths[index]; if (!location) throw new Error('Image reference is missing.');
    const source = await realpath(await resolveMediaLocation(location)); if (!await isManagedMediaPath(source)) throw new Error('Browser staging accepts only managed immutable images.');
    const info = await stat(source); if (!info.isFile() || info.size < 1 || info.size > 10 * 1024 * 1024) throw new Error('Browser image size is unsupported.');
    const bytes = await readFile(source); const hash = createHash('sha256').update(bytes).digest('hex'); if (hash !== job.mediaHashes[index]) throw new Error('Approved image bytes changed.');
    const { detectMedia } = await import('./localfs.ts'); const media = detectMedia(bytes); if (!media.mime.startsWith('image/')) throw new Error('A reviewed still image is required.');
    const id = randomUUID(); const name = `${id}.${media.extension}`; const destination = join(canonical, name); await copyFile(source, destination); await chmod(destination, 0o600);
    if (createHash('sha256').update(await readFile(destination)).digest('hex') !== hash) throw new Error('Staged image integrity check failed.');
    assets.push({ id, sha256: hash, name, bytes: info.size });
  }
  return assets;
}

export async function browserPublisherStatus() {
 let config: z.infer<typeof browserPublisherConfigSchema>;
 try { config = await browserPublisherConfig(); } catch { return { configured: false as const }; }
 const response = await fetch('http://browser-publisher:8916/session/status', { headers: { Authorization: `Bearer ${config.serviceKey}` }, signal: AbortSignal.timeout(5000), redirect: 'error' }).catch(() => null);
 if (!response?.ok) return { configured: true as const, available: false as const, fixture: config.fixturesEnabled };
 return { configured: true as const, available: true as const, ...z.object({ sessionId: z.uuid(), started: z.boolean(), handoff: z.boolean(), fixture: z.boolean() }).strict().parse(await response.json()) };
}
export async function controlBrowserFixtureSession(value: unknown) {
 const action = z.enum(['start', 'handoff', 'resume', 'close']).parse(z.object({ action: z.string() }).strict().parse(value).action);
 const config = await browserPublisherConfig();
 if (!config.fixturesEnabled) throw new Error('Live session controls require a verified physical account binding. Only isolated fixture sessions are enabled.');
 const account = accountSchema.parse({ id: config.sessionId, platform: 'xueqiu', label: 'Isolated browser fixture', provider: 'native', integrationId: '', status: 'connected', note: 'Isolated fixture only', verifiedAt: null, physicalIdentity: { id: `fixture:${config.sessionId}`, verification: 'fixture', verifiedAt: new Date().toISOString() } });
 return withAccountExecution(account, config.sessionId, 'handoff', () => browserPublisherRequest('/session', { action, sessionId: config.sessionId }));
}
