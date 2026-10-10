import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { briefSchema, type Brief, type Generated, type Platform } from '../src/core/model.ts';
import { addAccount, approveDraft, createDraft, runDueJobs, scheduleJob } from '../src/core/pipeline.ts';
import { mutateState, readState } from '../src/core/store.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let directory = '';
let posts = 0;
let integrationReads = 0;
let duringIntegrationRead: (() => Promise<void>) | undefined;
const date = '2026-01-01T10:00:00.000Z';
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function brief(platform: Platform = 'x', topicOrigin?: Brief['topicOrigin'], sourceUrl = 'https://example.com/editorial'): Brief {
  return { ...(topicOrigin === undefined ? {} : { topicOrigin }), topic: 'Original publishing architecture', audience: 'Independent developers', angle: 'Explain reviewed original research', sources: [{ title: 'Original research', url: sourceUrl, excerpt: 'A source-backed original explanation.' }], platforms: [platform] };
}
function content(platform: Platform = 'x'): Generated { return { title: 'An original explainer', body: 'An independently sourced article.', variants: [{ platform, title: 'An original explainer', text: 'A source-backed original explanation.', tags: [], mediaPaths: [] }] }; }
async function prepare(input: Brief, provider: 'native' | 'postiz' = 'postiz') {
  const platform = input.platforms[0]; assert.ok(platform);
  const account = await addAccount({ platform, label: 'Fixture publisher', provider, integrationId: provider === 'postiz' ? 'integration-x' : '', status: 'connected', note: '', verifiedAt: date });
  const created = await createDraft(input, content(platform)); const draft = await approveDraft(created.id);
  return { account, draft };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'content-policy-test-')); process.env.STUDIO_DATA_DIR = directory;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'POSTIZ_BASE_URL']) delete process.env[key];
  process.env.POSTIZ_API_KEY = 'fixture-not-a-secret'; posts = 0; integrationReads = 0; duringIntegrationRead = undefined;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/integrations')) { integrationReads++; if (duringIntegrationRead) await duringIntegrationRead(); return Response.json([{ id: 'integration-x', name: 'Fixture publisher', identifier: 'x', disabled: false }]); }
    if (init?.method === 'POST') posts++;
    return Response.json([{ postId: 'post-1', integration: 'integration-x' }]);
  };
});
afterEach(async () => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });

test('approved explicitly trend-derived X content is blocked before scheduling or submission', async () => {
  const { draft, account } = await prepare(brief('x', 'trend')); assert.ok(draft.approvedHash);
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /X prohibits automated posts about trending topics/);
  assert.equal((await readState()).jobs.length, 0); assert.equal(posts, 0); assert.equal(integrationReads, 1);
});
test('legacy Google Trends source blocks X automation even without topicOrigin', async () => {
  const { draft, account } = await prepare(brief('x', undefined, 'https://trends.google.com/trending?geo=US'));
  assert.equal(Object.hasOwn(draft.brief, 'topicOrigin'), false);
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /X prohibits automated posts/); assert.equal(posts, 0); assert.equal((await readState()).jobs.length, 0);
});
test('an editorial label does not override actual Google Trends provenance', async () => {
  const { draft, account } = await prepare(brief('x', 'editorial', 'https://trends.google.com/trending?geo=IN'));
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /X prohibits automated posts/); assert.equal(posts, 0);
});
test('editorial Postiz X content can schedule and submit through the existing adapter', async () => {
  const { draft, account } = await prepare(brief('x', 'editorial')); const job = await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  const result = (await runDueJobs()).find(item => item.id === job.id); assert.equal(result?.status, 'queued'); assert.equal(posts, 1);
});
test('trend content retains a genuine native human handoff with no API submission', async () => {
  const { draft, account } = await prepare(brief('x', 'trend'), 'native'); const job = await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  const result = (await runDueJobs()).find(item => item.id === job.id); assert.equal(result?.status, 'awaiting_operator'); assert.equal(posts, 0); assert.equal(integrationReads, 0);
});
test('dispatch rechecks trend provenance on existing approved jobs before remote submission', async () => {
  const { draft, account } = await prepare(brief('x', 'editorial')); const job = await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  await mutateState(state => { const current = state.drafts.find(item => item.id === draft.id); assert.ok(current); current.brief.topicOrigin = 'trend'; }); await approveDraft(draft.id);
  const result = (await runDueJobs()).find(item => item.id === job.id); assert.equal(result?.status, 'failed'); assert.match(result?.error ?? '', /X prohibits automated posts/); assert.equal(posts, 0); assert.equal(integrationReads, 1); assert.equal(result?.attempts, 0);
});
test('final preflight rechecks the same policy after an external integration lookup', async () => {
  const { draft, account } = await prepare(brief('x', 'editorial')); const job = await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  duringIntegrationRead = async () => { await mutateState(state => { const current = state.drafts.find(item => item.id === draft.id); assert.ok(current); current.brief.topicOrigin = 'trend'; }); };
  const result = (await runDueJobs()).find(item => item.id === job.id); assert.equal(result?.status, 'failed'); assert.match(result?.error ?? '', /X prohibits automated posts/); assert.equal(posts, 0); assert.equal(integrationReads, 2);
});
test('optional provenance does not change legacy JSON or existing approval digest', async () => {
  const legacyBrief = brief(); assert.equal(JSON.stringify(briefSchema.parse(legacyBrief)), JSON.stringify(legacyBrief));
  const { draft } = await prepare(legacyBrief, 'native'); const expected = digest({ revision: draft.revision, title: draft.title, body: draft.body, brief: legacyBrief, variants: draft.variants, media: [] }); assert.equal(draft.approvedHash, expected);
  const stateFile = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { drafts: { brief: Record<string, unknown> }[] }; assert.equal(Object.hasOwn(stateFile.drafts[0]?.brief ?? {}, 'topicOrigin'), false);
});
test('policy relies on provenance rather than broad keywords or deceptive hostname suffixes', async () => {
  const input = brief('x', 'editorial', 'https://trends.google.com.example.com/research'); input.topic = 'How trending-topic detection algorithms work';
  const { draft, account } = await prepare(input); await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }); assert.equal((await readState()).jobs.length, 1);
});
