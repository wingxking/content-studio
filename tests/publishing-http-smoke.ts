import assert from 'node:assert/strict';
import { z } from 'zod';
import { priorityPlatforms } from '../src/core/publishing-capabilities.ts';
import { draftSchema, jobSchema, type Account, type Generated } from '../src/core/model.ts';

const base = new URL(z.string().parse(process.env.STUDIO_TEST_URL));
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Use a dedicated loopback Docker QA instance.');
async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(`/api/${path}`, base), body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const initial = await (await api('status')).json() as { state: { drafts: unknown[]; jobs: unknown[]; accounts: unknown[] }; readiness: { database: string } };
assert.equal(initial.readiness.database, 'supabase');
assert.equal(initial.state.accounts.length + initial.state.drafts.length + initial.state.jobs.length, 0, 'QA workspace must be empty; never run against the user workspace.');
await api('pause', { paused: true });
const accounts: Account[] = [];
for (const platform of priorityPlatforms) {
  const response = await api('accounts', { platform, provider: 'native', label: `Disposable QA ${platform}`, integrationId: '', status: 'connected', verifiedAt: new Date().toISOString(), note: 'Disposable isolated acceptance fixture; no real external account or authorization.' });
  assert.equal(response.status, 200); accounts.push(await response.json() as Account);
}
const launch = { url: 'https://product.example/', name: 'QA product fixture', tagline: 'A deterministic acceptance fixture', description: 'Fixture only. No public launch or verified product claim.', firstComment: 'No external publishing occurs in this test.' };
const content: Generated = { title: 'Disposable publishing QA', body: 'Deterministic local publishing acceptance fixture.', variants: priorityPlatforms.map(platform => ({ platform, title: `QA ${platform}`, text: 'Local acceptance fixture. No external publication.', tags: [], mediaPaths: [], ...(platform === 'producthunt' ? { format: 'product_launch' as const, launch } : { format: 'article' as const }) })) };
const response = await api('drafts/import', { brief: { topic: 'Deterministic publishing acceptance', audience: 'QA operators', angle: 'Verify local contract only', platforms: [...priorityPlatforms], sources: [{ title: 'Fixture source', url: 'https://example.org/fixture', excerpt: 'A deterministic fixture, not researched publication content.' }] }, content });
assert.equal(response.status, 200); const draft = draftSchema.parse(await response.json());
const publish = await api(`drafts/${draft.id}/publish`, { accountIds: accounts.map(account => account.id), expectedRevision: draft.revision });
assert.equal(publish.status, 200); const jobs = z.array(jobSchema).parse(await publish.json());
assert.equal(jobs.length, priorityPlatforms.length); assert.ok(jobs.every(job => job.status === 'awaiting_operator' && job.attempts === 0 && job.remoteId === null));
for (const job of jobs) {
  const handoff = await api(`jobs/${job.id}/handoff`); assert.equal(handoff.status, 200);
  const value = await handoff.json() as { automatic: boolean; nativeUrl: string; launch?: typeof launch };
  assert.equal(value.automatic, false);
  if (job.platform === 'bilibili') assert.ok(value.nativeUrl.endsWith('/upload/text'));
  if (job.platform === 'producthunt') assert.deepEqual(value.launch, launch);
  const html = await api(`jobs/${job.id}/article.html`); assert.equal(html.status, 200); assert.ok(html.headers.get('content-disposition')?.includes(job.id)); assert.ok((await html.text()).includes('Local acceptance fixture'));
}
const repeat = await api(`drafts/${draft.id}/publish`, { accountIds: accounts.map(account => account.id), expectedRevision: draft.revision });
assert.equal(repeat.status, 200); assert.deepEqual(z.array(jobSchema).parse(await repeat.json()).map(job => job.id), jobs.map(job => job.id));
const capabilities = await api('publishing/capabilities'); assert.equal(capabilities.status, 200);
assert.ok((await capabilities.json() as { automatic: boolean }[]).every(item => !item.automatic));
const wrongOrigin = await fetch(new URL('/api/publishing/capabilities', base), { headers: { Origin: 'https://unrelated.example' } }); assert.equal(wrongOrigin.status, 403);
const ph = jobs.find(job => job.platform === 'producthunt'); assert.ok(ph);
const invalidReceipt = await api(`jobs/${ph.id}/receipt`, { remoteUrl: 'https://www.producthunt.com/posts/new', remoteId: 'new' }); assert.equal(invalidReceipt.status, 400);
console.log(JSON.stringify({ passed: true, checks: ['Supabase QA workspace', 'six native targets', 'immutable launch kit', 'article HTML download', 'Bilibili article route', 'repeat batch deduplication', 'capability blockers', 'Origin protection', 'reject draft as publication'], draftId: draft.id, jobIds: jobs.map(job => job.id) }));
