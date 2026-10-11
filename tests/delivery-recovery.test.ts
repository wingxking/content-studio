import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { continuePublication, publicationHandoff } from '../src/core/delivery.ts';
import { type Brief, type Generated, type Job } from '../src/core/model.ts';
import { addAccount, approveDraft, cancelJob, createDraft, preparePublication, reconcileJob, recordMetrics, replaceDraft, retryFailedPublication, runDueJobs } from '../src/core/pipeline.ts';
import { mutateState, readState } from '../src/core/store.ts';
import { expectedYouTubeChannelId, uploadYouTubeJob } from '../src/core/youtube.ts';
import { writePrivateJson, youtubeScopes } from '../src/core/youtube-oauth.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let directory = '';
const integrationId = 'recovery-test-x';
const providerPostId = 'existing-provider-post';
const releaseURL = 'https://x.com/recovery_test/status/987654321';
const brief: Brief = {
  topic: 'Practical publishing workflow', audience: 'Independent creators', angle: 'Use original sourced examples',
  sources: [{ title: 'Original evidence', url: 'https://example.com/evidence', excerpt: 'Verified evidence for this isolated fixture.' }],
  platforms: ['x', 'reddit'],
};
const content: Generated = {
  title: 'Publishing workflow', body: 'Original master and its source-backed explanation.',
  variants: brief.platforms.map(platform => ({ platform, title: 'Publishing workflow', text: 'An original practical explanation.', tags: [], mediaPaths: [] })),
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'content-studio-delivery-recovery-'));
  process.env.STUDIO_DATA_DIR = directory;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
  process.env.POSTIZ_API_KEY = 'isolated-test-credential';
  process.env.POSTIZ_BASE_URL = 'https://postiz.invalid/public/v1';
  globalThis.fetch = async () => { throw new Error('Unmocked network request in isolated recovery test.'); };
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  await rm(directory, { recursive: true, force: true });
});

function mockPostiz(reply: (url: URL, init: RequestInit | undefined) => Response): void {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://postiz.invalid');
    if (url.pathname.endsWith('/integrations')) {
      assert.equal(init?.method, 'GET');
      return Response.json([{ id: integrationId, name: 'Recovery test X', identifier: 'x', disabled: false }]);
    }
    return reply(url, init);
  };
}
async function prepare() {
  const account = await addAccount({ platform: 'x', label: 'Recovery test X', provider: 'postiz', integrationId, status: 'connected', note: 'Isolated test account.', verifiedAt: null });
  const draft = await createDraft(brief, content);
  await approveDraft(draft.id, draft.revision);
  const job = await preparePublication({ draftId: draft.id, accountId: account.id, expectedRevision: draft.revision, automatic: true });
  return { account, draft, job };
}
async function providerAcceptedThenFailed(): Promise<Job> {
  mockPostiz((_url, init) => init?.method === 'POST'
    ? Response.json([{ postId: providerPostId, integration: integrationId }])
    : Response.json({ posts: [{ id: providerPostId, content: content.variants[0]?.text, publishDate: new Date().toISOString(), state: 'ERROR', integration: { id: integrationId } }] }));
  const { job } = await prepare();
  assert.equal((await runDueJobs())[0]?.status, 'queued');
  const failed = await reconcileJob(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.providerPostId, providerPostId);
  return failed;
}

test('new authorization replaces an unsent failed X snapshot after only Reddit is edited', async () => {
  let submissionCalls = 0;
  mockPostiz((_url, init) => {
    assert.equal(init?.method, 'POST'); submissionCalls += 1;
    return new Response('Known validation rejection', { status: 400 });
  });
  const { account, draft, job } = await prepare();
  assert.equal((await runDueJobs())[0]?.status, 'failed');
  assert.equal(submissionCalls, 1);
  const revised = await replaceDraft(draft.id, {
    ...content,
    variants: content.variants.map(variant => variant.platform === 'reddit' ? { ...variant, text: 'Reddit-only independent revision.' } : variant),
  }, draft.revision);
  const approved = await approveDraft(draft.id, revised.revision);
  const replacement = await preparePublication({ draftId: draft.id, accountId: account.id, expectedRevision: approved.revision, automatic: true });
  assert.notEqual(replacement.id, job.id);
  assert.equal(replacement.status, 'scheduled');
  assert.equal(replacement.attempts, 0);
  assert.equal(replacement.snapshot?.draft?.revision, approved.revision);
  assert.equal(replacement.snapshot?.draft?.approvedHash, approved.approvedHash);
  assert.equal(replacement.snapshot?.variant.text, content.variants[0]?.text);
  const preserved = (await readState()).jobs.find(item => item.id === job.id);
  assert.equal(preserved?.status, 'cancelled');
  assert.equal(preserved?.snapshot?.draft?.revision, draft.revision);
  assert.equal(preserved?.attempts, 1);
  assert.equal(submissionCalls, 1, 'Preparing the replacement must not submit it.');
  const duplicateClick = await preparePublication({ draftId: draft.id, accountId: account.id, expectedRevision: approved.revision, automatic: true });
  assert.equal(duplicateClick.id, replacement.id);
});

test('a failed publication with a provider identity cannot be cancelled locally', async () => {
  const failed = await providerAcceptedThenFailed();
  await assert.rejects(cancelJob(failed.id), /remote identity|provider/i);
  const preserved = (await readState()).jobs.find(item => item.id === failed.id);
  assert.equal(preserved?.status, 'failed');
  assert.equal(preserved?.providerPostId, providerPostId);
  assert.equal(preserved?.attempts, 1);
});

test('Continue reconciles a failed existing Postiz item without another submission', async () => {
  const failed = await providerAcceptedThenFailed();
  const requests: { method: string; path: string }[] = [];
  mockPostiz((url, init) => {
    requests.push({ method: init?.method ?? 'GET', path: url.pathname });
    assert.equal(init?.method, 'GET', 'Recovery must only inspect the existing provider item.');
    assert.ok(url.pathname.endsWith('/posts'));
    return Response.json({ posts: [{ id: providerPostId, content: content.variants[0]?.text, publishDate: new Date().toISOString(), releaseURL, state: 'PUBLISHED', integration: { id: integrationId } }] });
  });
  const recovered = await continuePublication(failed.id);
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.id, failed.id);
  assert.equal(recovered.providerPostId, providerPostId);
  assert.equal(recovered.remoteId, '987654321');
  assert.equal(recovered.remoteUrl, releaseURL);
  assert.equal(recovered.attempts, failed.attempts);
  assert.deepEqual(requests.map(item => item.method), ['GET']);
  assert.equal((await readState()).jobs.length, 1);
});

test('processed private delivery accepts metrics without claiming public publication', async () => {
  const videoBrief: Brief = { ...brief, platforms: ['youtube'] };
  const videoContent: Generated = { ...content, variants: [{ platform: 'youtube', title: 'Review video', text: 'Metadata for an already processed private review video.', tags: [], mediaPaths: [] }] };
  const draft = await createDraft(videoBrief, videoContent);
  const account = await addAccount({ platform: 'youtube', label: 'Metrics fixture', provider: 'native', integrationId: 'test-channel', status: 'connected', note: '', verifiedAt: null });
  await approveDraft(draft.id, draft.revision);
  const job = await preparePublication({ draftId: draft.id, accountId: account.id, expectedRevision: draft.revision, automatic: false });
  await mutateState(state => {
    const saved = state.jobs.find(item => item.id === job.id); assert.ok(saved);
    saved.status = 'delivered'; saved.visibility = 'private'; saved.remoteId = 'fixture1234'; saved.remoteUrl = 'https://www.youtube.com/watch?v=fixture1234';
  });
  const recorded = await recordMetrics(job.id, { views: 3, likes: null, comments: null, clicks: null, notes: 'Owner observed three private review plays.' });
  assert.equal(recorded.status, 'delivered');
  assert.equal(recorded.visibility, 'private');
  assert.equal(recorded.metrics.length, 1);
  assert.equal(recorded.metrics[0]?.views, 3);
  assert.equal(recorded.metrics[0]?.likes, null);
  assert.equal((await readState()).jobs[0]?.metrics.length, 1);
});
async function journalOnlyFixture(): Promise<{ job: Job; accountId: string; draftId: string }> {
  const draft = await createDraft({ ...brief, platforms: ['youtube'] }, { ...content, variants: [{ platform: 'youtube', title: 'Review fixture', text: 'Fixture metadata.', tags: [], mediaPaths: [] }] });
  const account = await addAccount({ platform: 'youtube', label: 'Isolated journal fixture', provider: 'native', integrationId: 'fixture-channel', status: 'connected', note: 'Never submit this fixture.', verifiedAt: null });
  await approveDraft(draft.id, draft.revision);
  const prepared = await preparePublication({ draftId: draft.id, accountId: account.id, expectedRevision: draft.revision, automatic: false });
  const job = await mutateState(state => { const saved = state.jobs.find(item => item.id === prepared.id); assert.ok(saved); saved.status = 'failed'; saved.error = 'Restored journal-only fixture.'; return saved; });
  await mkdir(join(directory, 'youtube', 'uploads'), { recursive: true });
  // Even an invalid journal is uncertain evidence and must never be discarded as an unsent job.
  await writeFile(join(directory, 'youtube', 'uploads', `${job.id}.json`), '{}', { mode: 0o600 });
  return { job, accountId: account.id, draftId: draft.id };
}
test('journal-only failed YouTube cannot cancel or retry as an unsent job', async () => {
  const { job } = await journalOnlyFixture();
  assert.equal((await publicationHandoff(job.id)).requiresReconciliation, true);
  await assert.rejects(cancelJob(job.id), /journal.*[Rr]econcile/);
  await assert.rejects(retryFailedPublication(job.id), /journal.*[Rr]econcile/);
  const saved = (await readState()).jobs[0]; assert.equal(saved?.status, 'failed'); assert.equal(saved?.attempts, 0); assert.equal(saved?.history.length, job.history.length);
});
test('continuing journal-only failure enters reconciliation without a new operation or external request', async () => {
  const { job } = await journalOnlyFixture(); let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No external request is allowed.'); };
  await assert.rejects(continuePublication(job.id), /journal is invalid/);
  const state = await readState(); assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0]?.status, 'needs_reconciliation'); assert.equal(state.jobs[0]?.attempts, 0); assert.equal(requests, 0);
});
test('a legacy cancelled journal prevents creating a duplicate publication', async () => {
  const { job, accountId, draftId } = await journalOnlyFixture();
  await mutateState(state => { const saved = state.jobs.find(item => item.id === job.id); assert.ok(saved); saved.status = 'cancelled'; });
  const reused = await preparePublication({ draftId, accountId, expectedRevision: 1, automatic: false });
  assert.equal(reused.id, job.id); assert.equal(reused.status, 'needs_reconciliation'); assert.equal((await readState()).jobs.length, 1);
});

test('restored journal marker explains recovery and prevents any remote request', async () => {
  const { job } = await journalOnlyFixture(); let requests = 0;
  await writeFile(join(directory, 'youtube', 'uploads', `${job.id}.json`), JSON.stringify({ jobId: job.id, restoredJournalMarker: true }), { mode: 0o600 });
  globalThis.fetch = async () => { requests++; throw new Error('No external request is allowed.'); };
  await assert.rejects(continuePublication(job.id), /--restore-private.*verified receipt/);
  assert.equal(requests, 0);
  assert.equal((await readState()).jobs[0]?.status, 'needs_reconciliation');
  assert.equal((await publicationHandoff(job.id)).requiresReconciliation, true);
  await assert.rejects(cancelJob(job.id), /[Rr]econcile/);
});

test('Web Continue refreshes a published YouTube visibility without another upload', async () => {
  const videoId = 'AbCdeF123_-'; const media = join(directory, 'fixture.mp4');
  const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'ascii'); await writeFile(media, bytes);
  const draft = await createDraft({ ...brief, platforms: ['youtube'] }, { ...content, variants: [{ platform: 'youtube', title: 'Visibility fixture', text: 'Fixture metadata.', tags: [], mediaPaths: [media] }] });
  const account = await addAccount({ platform: 'youtube', label: 'Visibility fixture', provider: 'native', integrationId: expectedYouTubeChannelId, status: 'connected', note: 'Isolated fixture.', verifiedAt: null });
  await approveDraft(draft.id, draft.revision);
  const job = await preparePublication({ draftId: draft.id, accountId: account.id, expectedRevision: draft.revision, automatic: false });
  let privacy = 'public'; let uploadStatus = 'processed'; let sessionPosts = 0; let mediaUploads = 0;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'; requests.push(method);
    assert.equal(url.origin, 'https://www.googleapis.com');
    if (url.pathname === '/youtube/v3/channels') return Response.json({ items: [{ id: expectedYouTubeChannelId }] });
    if (method === 'POST') { sessionPosts++; return new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture' } }); }
    if (method === 'PUT') { mediaUploads++; return Response.json({ id: videoId }, { status: 201 }); }
    assert.equal(url.pathname, '/youtube/v3/videos');
    return Response.json({ items: [{ id: videoId, snippet: { channelId: expectedYouTubeChannelId }, status: { privacyStatus: privacy, uploadStatus }, processingDetails: { processingStatus: 'succeeded' } }] });
  };
  const published = await uploadYouTubeJob(job.id, { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: true, categoryId: '27', defaultLanguage: 'en', descriptionDisclosure: 'Original fixture with synthetic narration.' }, { tokenProvider: async () => 'fixture-access', fetcher: globalThis.fetch });
  assert.equal(published.status, 'published');
  const secrets = join(directory, 'youtube', 'secrets');
  await writePrivateJson(join(secrets, 'client.json'), { installed: { client_id: 'fixture-client', client_secret: 'fixture-secret' } });
  await writePrivateJson(join(secrets, 'token.json'), { version: 1, clientId: 'fixture-client', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, scopes: [...youtubeScopes] });
  for (const change of [{ privacy: 'private', uploadStatus: 'processed' }, { privacy: 'public', uploadStatus: 'deleted' }]) {
    privacy = change.privacy; uploadStatus = change.uploadStatus; requests.length = 0;
    if (change.uploadStatus === 'deleted') await mutateState(state => { const saved = state.jobs.find(item => item.id === job.id); assert.ok(saved); saved.status = 'published'; });
    const updated = await continuePublication(job.id);
    assert.equal(updated.status, change.uploadStatus === 'processed' ? 'delivered' : 'needs_reconciliation'); assert.equal(updated.visibility, privacy);
    assert.equal(updated.remoteId, published.remoteId); assert.equal(updated.remoteUrl, published.remoteUrl); assert.equal(updated.attempts, published.attempts);
    assert.deepEqual(requests, ['GET', 'GET']); assert.equal(sessionPosts, 1); assert.equal(mediaUploads, 1);
  }
  assert.equal((await readState()).jobs.length, 1);
});
