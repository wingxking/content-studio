import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addAccount, approveDraft, cancelJob, createDraft, replaceDraft, runDueJobs, scheduleJob } from '../src/core/pipeline.ts';
import { mutateState, readState } from '../src/core/store.ts';
import { authorizeDesktopYouTube, desktopYouTubeTokenProvider, readPrivateJson, writePrivateJson, youtubeScopes } from '../src/core/youtube-oauth.ts';
import { collectYouTubeJobMetrics, expectedYouTubeChannelId, reconcileYouTubeJob, resumeYouTubeJob, uploadYouTubeJob, verifyYouTubeChannel } from '../src/core/youtube.ts';

const videoId = 'AbCdeF123_-';
test('completed same-session continuation arms read-only polling after transient first readback', async () => {
  const data = await fixture(); let inserts = 0; let probes = 0;
  try {
    await assert.rejects(uploadYouTubeJob(data.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => {
      if (url.pathname.endsWith('/channels')) return json({ items: [{ id: expectedYouTubeChannelId }] });
      if (init.method === 'POST') { inserts++; return new Response(null, { headers: { Location: session } }); }
      throw new Error('Lost binary upload acknowledgement');
    }) }), /preserved for reconciliation/);
    const queued = await resumeYouTubeJob(data.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => {
      if (url.pathname.endsWith('/channels')) return json({ items: [{ id: expectedYouTubeChannelId }] });
      if (init.method === 'PUT') { probes++; assert.equal(new Headers(init.headers).get('Content-Length'), '0'); return json({ id: videoId }, 201); }
      assert.equal(init.method, 'GET'); return json({}, 503);
    }) });
    assert.equal(queued.status, 'queued'); assert.equal(queued.remoteId, videoId); assert.ok(queued.verificationCheck?.nextAt); assert.equal(queued.attempts, 1); assert.equal(inserts, 1); assert.equal(probes, 1);
    const published = await reconcileYouTubeJob(data.id, { readOnly: true, tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => { assert.equal(init.method, 'GET'); return url.pathname.endsWith('/channels') ? json({ items: [{ id: expectedYouTubeChannelId }] }) : readback(); }) });
    assert.equal(published.status, 'published'); assert.equal(published.attempts, 1); assert.equal(published.verificationCheck?.nextAt, null);
  } finally { await data.cleanup(); }
});
test('an acknowledged video ID survives transient first readback for automatic polling', async () => {
  const data = await fixture(); let uploads = 0; let binaryUploads = 0;
  try {
    const queued = await uploadYouTubeJob(data.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => {
      if (url.pathname.endsWith('/channels')) return json({ items: [{ id: expectedYouTubeChannelId }] });
      if (init.method === 'POST') { uploads++; return new Response(null, { headers: { Location: session } }); }
      if (init.method === 'PUT') { binaryUploads++; return json({ id: videoId }, 201); }
      return json({}, 503);
    }) });
    assert.equal(queued.status, 'queued'); assert.equal(queued.remoteId, videoId); assert.ok(queued.verificationCheck?.nextAt); assert.equal(queued.verificationCheck?.attempt, 1);
    const result = await reconcileYouTubeJob(data.id, { readOnly: true, tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => { assert.equal(init.method, 'GET'); return url.pathname.endsWith('/channels') ? json({ items: [{ id: expectedYouTubeChannelId }] }) : readback(); }) });
    assert.equal(result.status, 'published'); assert.equal(result.verificationCheck?.nextAt, null); assert.equal(uploads, 1); assert.equal(binaryUploads, 1); assert.equal(result.attempts, 1);
  } finally { await data.cleanup(); }
});
test('automatic YouTube readback uses GET only and never probes or resubmits an upload', async () => {
  const data = await fixture();
  try {
    const delivered = await uploadYouTubeJob(data.id, { ...settings, privacyStatus: 'private' }, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch('private') });
    assert.equal(delivered.status, 'delivered'); assert.equal(delivered.remoteId, videoId); assert.ok(delivered.verificationCheck?.nextAt);
    const reads: string[] = [];
    const published = await reconcileYouTubeJob(data.id, { readOnly: true, tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => { assert.equal(init.method, 'GET'); reads.push(url.pathname); return url.pathname.endsWith('/channels') ? json({ items: [{ id: expectedYouTubeChannelId }] }) : readback(); }) });
    assert.equal(reads.length, 2); assert.equal(published.status, 'published'); assert.equal(published.attempts, 1); assert.equal(published.verificationCheck?.nextAt, null);
    await mutateState(state => { const job = state.jobs[0]!; job.status = 'queued'; job.remoteId = null; });
    let externalReads = 0;
    await assert.rejects(reconcileYouTubeJob(data.id, { readOnly: true, tokenProvider: async () => 'fixture-token', fetcher: mockFetch(() => { externalReads++; return readback(); }) }), /confirmed video identifier/);
    assert.equal(externalReads, 0);
  } finally { await data.cleanup(); }
});
test('automatic YouTube readback surfaces permission errors without losing accepted state', async () => {
  const data = await fixture();
  try {
    await uploadYouTubeJob(data.id, { ...settings, privacyStatus: 'private' }, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch('private') });
    await assert.rejects(reconcileYouTubeJob(data.id, { readOnly: true, tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => { assert.equal(init.method, 'GET'); return url.pathname.endsWith('/channels') ? json({ items: [{ id: expectedYouTubeChannelId }] }) : json({}, 403); }) }), /HTTP 403/);
    const retained = (await readState()).jobs[0]!; assert.equal(retained.status, 'delivered'); assert.equal(retained.remoteId, videoId); assert.equal(retained.attempts, 1);
  } finally { await data.cleanup(); }
});
const session = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fixture';
const settings = { privacyStatus: 'public' as const, selfDeclaredMadeForKids: false, containsSyntheticMedia: true, categoryId: '27', defaultLanguage: 'en', descriptionDisclosure: 'AI-assisted writing, original explanatory cards, and generic synthetic narration.' };
const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function mockFetch(handler: (url: URL, init: RequestInit) => Promise<Response> | Response): typeof fetch { return async (input, init) => handler(new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url), init ?? {}); }
function readback(privacyStatus = 'public', channelId = expectedYouTubeChannelId): Response { return json({ items: [{ id: videoId, snippet: { channelId }, status: { privacyStatus, uploadStatus: 'processed' }, processingDetails: { processingStatus: 'succeeded' } }] }); }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function successfulUploadFetch(privacyStatus = 'public'): typeof fetch {
  return mockFetch((url, init) => {
    if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] });
    if (init.method === 'POST') return new Response(null, { headers: { Location: session } });
    if (init.method === 'PUT') return json({ id: videoId }, 201);
    return readback(privacyStatus);
  });
}
async function fixture(): Promise<{ directory: string; id: string; draftId: string; media: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-contract-')); process.env.STUDIO_DATA_DIR = directory;
  const media = join(directory, 'fixture.mp4'); const bytes = Buffer.alloc(64); bytes.write('ftyp', 4, 'ascii'); await writeFile(media, bytes);
  const draft = await createDraft({ topic: 'Original sourced explainer', audience: 'General readers', angle: 'Source-based original educational explanation', sources: [{ title: 'Original source', url: 'https://example.com/source', excerpt: 'A fixture source summary.' }], platforms: ['youtube'] }, { title: 'A sourced explainer', body: 'Original article.', variants: [{ platform: 'youtube', title: 'An original explainer', text: 'An original narrated educational script.', tags: ['Education'], mediaPaths: [media] }] });
  await approveDraft(draft.id);
  const account = await addAccount({ platform: 'youtube', provider: 'native', label: 'Verified fixture channel', integrationId: expectedYouTubeChannelId, status: 'connected', note: 'Official API fixture', verifiedAt: new Date().toISOString() });
  const job = await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: new Date().toISOString() });
  return { directory, id: job.id, draftId: draft.id, media, cleanup: async () => { await rm(directory, { recursive: true, force: true }); delete process.env.STUDIO_DATA_DIR; } };
}
test('invalid description characters fail before OAuth or a resumable upload request', async () => {
  const fixtureData = await fixture(); let requests = 0; let tokenReads = 0;
  try {
    await assert.rejects(uploadYouTubeJob(fixtureData.id, { ...settings, descriptionDisclosure: 'AI-assisted <synthetic narration> disclosure.' }, {
      tokenProvider: async () => { tokenReads++; return 'fixture-token'; },
      fetcher: mockFetch(() => { requests++; return json({}); }),
    }), /metadata exceeds supported API limits/);
    assert.equal(requests, 0); assert.equal(tokenReads, 0);
    assert.equal((await readState()).jobs[0]?.status, 'scheduled');
    await assert.rejects(stat(join(fixtureData.directory, 'youtube', 'uploads', `${fixtureData.id}.json`)), { code: 'ENOENT' });
  } finally { await fixtureData.cleanup(); }
});
test('channel verification refuses a different or ambiguous OAuth target', async () => {
  for (const items of [[{ id: 'UCwrong' }], [{ id: expectedYouTubeChannelId }, { id: 'UCother' }], []]) await assert.rejects(verifyYouTubeChannel({ tokenProvider: async () => 'fixture-token', fetcher: mockFetch(() => json({ items })) }), /different or ambiguous/);
});
test('durable claim/journal precede official session and binary upload; readback confirms channel and public processing', async () => {
  const fixtureData = await fixture(); const requests: string[] = [];
  try {
    const result = await uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(async (url, init) => {
      requests.push(`${init.method} ${url.pathname}`); assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-token');
      if (url.pathname === '/youtube/v3/channels') { assert.equal(url.searchParams.get('mine'), 'true'); return json({ items: [{ id: expectedYouTubeChannelId }] }); }
      if (url.pathname === '/upload/youtube/v3/videos' && init.method === 'POST') {
        const state = await readState(); assert.equal(state.jobs[0]?.status, 'submitting'); assert.equal(state.jobs[0]?.attempts, 1);
        const saved = await readPrivateJson(join(fixtureData.directory, 'youtube', 'uploads', `${fixtureData.id}.json`)); assert.ok(saved);
        const body = JSON.parse(String(init.body)) as { snippet: { title: string; description: string }; status: typeof settings }; assert.equal(body.snippet.title, 'An original explainer'); assert.match(body.snippet.description, /generic synthetic narration/); assert.match(body.snippet.description, /https:\/\/example.com\/source/); assert.equal(body.status.privacyStatus, 'public'); assert.equal(body.status.containsSyntheticMedia, true);
        return new Response(null, { status: 200, headers: { Location: session } });
      }
      if (url.pathname === '/upload/youtube/v3/videos' && init.method === 'PUT') {
        const saved = JSON.parse(await readFile(join(fixtureData.directory, 'youtube', 'uploads', `${fixtureData.id}.json`), 'utf8')) as { phase: string }; assert.equal(saved.phase, 'sending');
        assert.equal(new Headers(init.headers).get('Content-Range'), 'bytes 0-63/64'); assert.deepEqual(Buffer.from(init.body as ArrayBuffer), await readFile(fixtureData.media)); return json({ id: videoId }, 201);
      }
      assert.equal(url.pathname, '/youtube/v3/videos'); assert.equal(url.searchParams.get('id'), videoId); return readback();
    }) });
    assert.equal(result.status, 'published'); assert.equal(result.remoteId, videoId); assert.equal(result.remoteUrl, `https://www.youtube.com/watch?v=${videoId}`);
    assert.equal(requests.filter(item => item.startsWith('POST')).length, 1);
  } finally { await fixtureData.cleanup(); }
});
test('a token replaced after channel preflight cannot change the upload target or immediate readback', async () => {
  const fixtureData = await fixture(); let tokenReads = 0; const bearers: string[] = [];
  try {
    const upstream = successfulUploadFetch();
    const result = await uploadYouTubeJob(fixtureData.id, settings, {
      tokenProvider: async () => ++tokenReads === 1 ? 'verified-channel-token' : 'replacement-wrong-channel-token',
      fetcher: mockFetch((url, init) => {
        const bearer = new Headers(init.headers).get('Authorization'); assert.ok(bearer); bearers.push(bearer);
        assert.equal(bearer, 'Bearer verified-channel-token');
        return upstream(url, init);
      }),
    });
    assert.equal(result.status, 'published'); assert.equal(tokenReads, 1); assert.equal(bearers.length, 5);
  } finally { await fixtureData.cleanup(); }
});
test('manual reconciliation refuses an upload whose local submission owner is alive', async () => {
  const fixtureData = await fixture(); const sending = deferred<void>(); const response = deferred<Response>();
  let upload: Promise<Awaited<ReturnType<typeof uploadYouTubeJob>>> | undefined;
  try {
    const upstream = successfulUploadFetch();
    upload = uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => {
      if (init.method === 'PUT' && init.body) { sending.resolve(); return response.promise; }
      return upstream(url, init);
    }) });
    await sending.promise;
    const before = (await readState()).jobs[0]; assert.ok(before); assert.equal(before.status, 'submitting');
    let requests = 0;
    await assert.rejects(reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(() => { requests++; return readback(); }) }), /busy|owner is still running/);
    const after = (await readState()).jobs[0]; assert.deepEqual(after, before); assert.equal(requests, 0);
    response.resolve(json({ id: videoId }, 201)); assert.equal((await upload).status, 'published');
  } finally { response.resolve(json({ id: videoId }, 201)); await upload?.catch(() => undefined); await fixtureData.cleanup(); }
});
test('same-account readbacks serialize, and a subsequent confirmed publication remains authoritative', async () => {
  const fixtureData = await fixture(); const reading = deferred<void>(); const response = deferred<Response>();
  let earlier: Promise<Awaited<ReturnType<typeof reconcileYouTubeJob>>> | undefined;
  try {
    assert.equal((await uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch('private') })).status, 'delivered');
    earlier = reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(url => {
      if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] });
      reading.resolve(); return response.promise;
    }) });
    await reading.promise;
    await assert.rejects(reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() }), /busy/);
    response.resolve(readback('private'));
    assert.equal((await earlier).status, 'delivered');
    const newer = await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() });
    assert.equal(newer.status, 'published');
    assert.deepEqual((await readState()).jobs[0], newer);
  } finally { response.resolve(readback('private')); await earlier?.catch(() => undefined); await fixtureData.cleanup(); }
});
test('a published video becoming processed private/unlisted is delivered and retains its publication receipt', async () => {
  for (const privacy of ['private', 'unlisted']) {
    const fixtureData = await fixture();
    try {
      const published = await uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() });
      const hidden = await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch(privacy) });
      assert.equal(hidden.status, 'delivered'); assert.equal(hidden.visibility, privacy); assert.equal(hidden.error, null);
      assert.equal(hidden.remoteId, published.remoteId); assert.equal(hidden.remoteUrl, published.remoteUrl); assert.equal(hidden.attempts, published.attempts);
      assert.ok(hidden.history.some(item => item.status === 'published'));
      assert.equal((await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch(privacy) })).status, 'delivered');
    } finally { await fixtureData.cleanup(); }
  }
});

test('a matching explicit empty/non-OK readback marks a published video uncertain without another upload', async () => {
  for (const unavailable of [() => json({ items: [] }), () => new Response(null, { status: 403 })]) {
    const fixtureData = await fixture(); const requests: string[] = [];
    try {
      const published = await uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() });
      const uncertain = await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => {
        requests.push(init.method ?? 'GET'); assert.equal(init.method, 'GET');
        return url.pathname === '/youtube/v3/channels' ? json({ items: [{ id: expectedYouTubeChannelId }] }) : unavailable();
      }) });
      assert.equal(uncertain.status, 'needs_reconciliation'); assert.equal(uncertain.remoteId, published.remoteId); assert.equal(uncertain.remoteUrl, published.remoteUrl);
      assert.equal(uncertain.providerPostId, published.providerPostId); assert.equal(uncertain.attempts, published.attempts);
      assert.deepEqual(uncertain.history.slice(0, published.history.length), published.history); assert.deepEqual(requests, ['GET', 'GET']);
    } finally { await fixtureData.cleanup(); }
  }
});

test('an upload catch cannot downgrade a concurrently confirmed publication', async () => {
  const fixtureData = await fixture();
  try {
    const upstream = successfulUploadFetch();
    await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(async (url, init) => {
      if (init.method === 'PUT' && init.body) {
        await mutateState(state => {
          const job = state.jobs.find(item => item.id === fixtureData.id); assert.ok(job);
          job.status = 'published'; job.submissionOwner = null; job.remoteId = videoId; job.remoteUrl = `https://www.youtube.com/watch?v=${videoId}`;
          job.history.push({ at: new Date().toISOString(), status: 'published', message: 'Independent confirmed fixture receipt.' });
        });
        throw new Error('Lost original upload response after independent confirmation.');
      }
      return upstream(url, init);
    }) }), /preserved for reconciliation/);
    const saved = (await readState()).jobs[0]; assert.equal(saved?.status, 'published'); assert.equal(saved?.remoteId, videoId);
    assert.equal(saved?.history.at(-1)?.status, 'published'); assert.equal(saved?.attempts, 1);
  } finally { await fixtureData.cleanup(); }
});
test('upload completion cannot overwrite a changed submission owner or recovered job state', async () => {
  const fixtureData = await fixture();
  try {
    const upstream = successfulUploadFetch();
    await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(async (url, init) => {
      if (init.method === 'PUT' && init.body) await mutateState(state => {
        const job = state.jobs[0]; assert.ok(job);
        job.status = 'needs_reconciliation'; job.submissionOwner = null;
        job.history.push({ at: new Date().toISOString(), status: 'needs_reconciliation', message: 'A different worker recovered this submission.' });
      });
      return upstream(url, init);
    }) }), /preserved for reconciliation/);
    const recovered = (await readState()).jobs[0]; assert.ok(recovered);
    assert.equal(recovered.status, 'needs_reconciliation'); assert.equal(recovered.providerPostId, null);
    assert.equal(recovered.history.at(-1)?.message, 'A different worker recovered this submission.');
    assert.equal((await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() })).status, 'published');
  } finally { await fixtureData.cleanup(); }
});
test('changed media cannot be uploaded from an old approval', async () => {
  const fixtureData = await fixture(); let requests = 0;
  try { await writeFile(fixtureData.media, Buffer.alloc(65)); await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(() => { requests++; return json({}); }) }), /changed after approval/); assert.equal(requests, 0); }
  finally { await fixtureData.cleanup(); }
});
test('a changed current draft cannot upload an older immutable job', async () => {
  const fixtureData = await fixture();
  try { const draft = (await readState()).drafts[0]; assert.ok(draft); await replaceDraft(draft.id, { title: draft.title, body: 'Changed article.', variants: draft.variants }); await approveDraft(draft.id); await assert.rejects(uploadYouTubeJob(fixtureData.id, settings), /changed; schedule/); }
  finally { await fixtureData.cleanup(); }
});
test('pause prevents submission and a wrong live channel does not claim the job', async () => {
  const fixtureData = await fixture();
  try {
    await mutateState(state => { state.paused = true; }); await assert.rejects(uploadYouTubeJob(fixtureData.id, settings), /paused/);
    await mutateState(state => { state.paused = false; }); await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(() => json({ items: [{ id: 'UCwrong' }] })) }), /different or ambiguous/);
    assert.equal((await readState()).jobs[0]?.status, 'scheduled'); assert.equal((await readState()).jobs[0]?.attempts, 0);
  } finally { await fixtureData.cleanup(); }
});
test('journal persistence failure prevents the non-idempotent session request', async () => {
  const fixtureData = await fixture(); let posts = 0;
  try {
    await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(async (_url, init) => { if (init.method === 'POST') posts++; await writeFile(join(fixtureData.directory, 'youtube'), 'block journal persistence after preflight'); return json({ items: [{ id: expectedYouTubeChannelId }] }); }) }), /preserved for reconciliation/);
    assert.equal(posts, 0);
    assert.equal((await readState()).jobs[0]?.status, 'needs_reconciliation');
    assert.equal((await readState()).jobs[0]?.attempts, 1);
  } finally { await fixtureData.cleanup(); }
});
test('ambiguous session initiation is durable and a second upload is refused', async () => {
  const fixtureData = await fixture(); let posts = 0;
  const fetcher = mockFetch((_url, init) => { if (init.method === 'GET') return json({ items: [{ id: expectedYouTubeChannelId }] }); posts++; throw new Error('network disconnect with sensitive-url'); });
  try {
    await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher }), /preserved for reconciliation/);
    assert.equal((await readState()).jobs[0]?.status, 'needs_reconciliation'); await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher }), /already exists/); assert.equal(posts, 1);
    const result = await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher }); assert.equal(result.status, 'needs_reconciliation'); assert.equal(posts, 1);
  } finally { await fixtureData.cleanup(); }
});
test('a lost binary-upload response is reconciled by empty PUT and existing video ID, never another insert', async () => {
  const fixtureData = await fixture(); let posts = 0; let binaryPuts = 0; let probes = 0;
  try {
    const fetcher = mockFetch((url, init) => {
      if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] });
      if (init.method === 'POST') { posts++; return new Response(null, { status: 200, headers: { Location: session } }); }
      if (init.method === 'PUT') { if (init.body) { binaryPuts++; throw new Error('connection lost'); } probes++; assert.equal(new Headers(init.headers).get('Content-Range'), 'bytes */64'); return json({ id: videoId }, 201); }
      return readback();
    });
    await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher }), /preserved for reconciliation/);
    const result = await reconcileYouTubeJob(fixtureData.id, { tokenProvider: async () => 'fixture-token', fetcher }); assert.equal(result.status, 'published'); assert.equal(posts, 1); assert.equal(binaryPuts, 1); assert.equal(probes, 1);
  } finally { await fixtureData.cleanup(); }
});
test('private/unlisted processed uploads are delivered without claiming public publication', async () => {
  for (const [privacy, channel] of [['private', expectedYouTubeChannelId], ['unlisted', expectedYouTubeChannelId], ['public', 'UCwrong']] as const) {
    const fixtureData = await fixture();
    try {
      const result = await uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => { if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] }); if (init.method === 'POST') return new Response(null, { headers: { Location: session } }); if (init.method === 'PUT') return json({ id: videoId }, 201); return readback(privacy, channel); }) });
      assert.equal(result.status, channel === expectedYouTubeChannelId ? 'delivered' : 'needs_reconciliation'); assert.equal(result.remoteUrl, channel === expectedYouTubeChannelId ? `https://www.youtube.com/watch?v=${videoId}` : null);
      if (channel === expectedYouTubeChannelId) { assert.equal(result.visibility, privacy); assert.equal(result.remoteId, videoId); }
    } finally { await fixtureData.cleanup(); }
  }
});
test('session URLs cannot redirect credentials to another host', async () => {
  const fixtureData = await fixture(); let puts = 0;
  try { await assert.rejects(uploadYouTubeJob(fixtureData.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((_url, init) => { if (init.method === 'GET') return json({ items: [{ id: expectedYouTubeChannelId }] }); if (init.method === 'PUT') puts++; return new Response(null, { headers: { Location: 'https://attacker.example/upload' } }); }) }), /preserved for reconciliation/); assert.equal(puts, 0); }
  finally { await fixtureData.cleanup(); }
});
test('Desktop OAuth uses state, PKCE, loopback, minimal scopes, and private tokens without returning secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-oauth-')); const clientFile = join(directory, 'downloaded-client.json'); const secretDirectory = join(directory, 'secrets'); await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'fixture-client', client_secret: 'fixture-client-secret' } }));
  let challenge = ''; let redirectUri = ''; let requestedState = '';
  try {
    const result = await authorizeDesktopYouTube({ clientFile, secretDirectory, timeoutMs: 5000, onAuthorizationUrl: async authorizationUrl => {
      const url = new URL(authorizationUrl); assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), youtubeScopes.join(' ')); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); challenge = url.searchParams.get('code_challenge') ?? ''; redirectUri = url.searchParams.get('redirect_uri') ?? ''; requestedState = url.searchParams.get('state') ?? '';
      const callback = new URL(redirectUri); assert.equal(callback.hostname, '127.0.0.1'); callback.search = new URLSearchParams({ state: 'wrong', code: 'wrong' }).toString(); assert.equal((await fetch(callback)).status, 400);
      const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
        const malformed = request({ hostname: callback.hostname, port: callback.port, path: 'http://[', method: 'GET' }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
        malformed.once('error', reject); malformed.end();
      });
      assert.equal(malformedStatus, 400);
      callback.search = new URLSearchParams({ state: requestedState, code: 'fixture-code' }).toString(); assert.equal((await fetch(callback)).status, 200);
    }, fetcher: mockFetch((_url, init) => { const form = init.body as URLSearchParams; assert.equal(form.get('redirect_uri'), redirectUri); assert.equal(createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url'), challenge); return json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer', scope: youtubeScopes.join(' ') }); }) });
    assert.deepEqual(result, { authorized: true }); assert.equal((await stat(join(secretDirectory, 'token.json'))).mode & 0o777, 0o600); assert.equal((await stat(secretDirectory)).mode & 0o777, 0o700); assert.equal(await desktopYouTubeTokenProvider(secretDirectory)(), 'fixture-access');
    await chmod(join(secretDirectory, 'token.json'), 0o644); await assert.rejects(desktopYouTubeTokenProvider(secretDirectory)(), /absent or invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('refresh preserves the original refresh token and only posts to the official token endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-refresh-'));
  try {
    await writePrivateJson(join(directory, 'client.json'), { installed: { client_id: 'fixture-client', client_secret: 'fixture-secret' } }); await writePrivateJson(join(directory, 'token.json'), { version: 1, clientId: 'fixture-client', accessToken: 'expired', refreshToken: 'fixture-refresh', expiresAt: 1, scopes: youtubeScopes });
    const provider = desktopYouTubeTokenProvider(directory, mockFetch((url, init) => { assert.equal(url.toString(), 'https://oauth2.googleapis.com/token'); const form = init.body as URLSearchParams; assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'fixture-refresh'); return json({ access_token: 'renewed', expires_in: 3600, token_type: 'Bearer' }); }));
    assert.equal(await provider(), 'renewed'); const tokens = await readPrivateJson(join(directory, 'token.json')) as { refreshToken: string }; assert.equal(tokens.refreshToken, 'fixture-refresh');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dispatcher preserves a live native YouTube owner beyond its network timeout and recovers a dead one', async () => {
  const data = await fixture();
  try {
    await mutateState(state => {
      const job = state.jobs.find(item => item.id === data.id); assert.ok(job);
      job.status = 'submitting'; job.submissionOwner = `${hostname()}:${process.pid}:fixture`; job.submissionStartedAt = '2000-01-01T00:00:00.000Z';
    });
    assert.equal((await runDueJobs()).length, 0);
    assert.equal((await readState()).jobs[0]?.status, 'submitting');
    await mutateState(state => { const job = state.jobs[0]; assert.ok(job); job.submissionOwner = `${hostname()}:999999999:fixture`; });
    assert.equal((await runDueJobs())[0]?.status, 'needs_reconciliation');
  } finally { await data.cleanup(); }
});

test('large video upload uses bounded chunks and explicit continuation resumes the same session offset', async () => {
  const data = await fixture(); const chunkSize = 8 * 1024 * 1024; let inserts = 0; let chunks = 0; const ranges: string[] = [];
  try {
    const bytes = Buffer.alloc(chunkSize * 2 + 17); bytes.write('ftyp', 4, 'ascii'); await writeFile(data.media, bytes);
    const state = await readState(); const original = state.jobs[0]; assert.ok(original); await cancelJob(original.id); await approveDraft(data.draftId);
    const job = await scheduleJob({ draftId: data.draftId, accountId: original.accountId, scheduledAt: new Date().toISOString() });
    const first = mockFetch((url, init) => {
      if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] });
      if (init.method === 'POST') { inserts++; return new Response(null, { headers: { Location: session } }); }
      if (init.method === 'PUT' && init.body) { chunks++; assert.ok((init.body as ArrayBuffer).byteLength <= chunkSize); ranges.push(new Headers(init.headers).get('Content-Range') ?? ''); if (chunks === 1) return new Response(null, { status: 308, headers: { Range: `bytes=0-${chunkSize - 1}` } }); throw new Error('connection lost after first acknowledged chunk'); }
      return readback();
    });
    await assert.rejects(uploadYouTubeJob(job.id, settings, { tokenProvider: async () => 'fixture', fetcher: first }), /preserved for reconciliation/);
    const journal = await readPrivateJson(join(data.directory, 'youtube', 'uploads', `${job.id}.json`)) as { offset: number }; assert.equal(journal.offset, chunkSize);
    const resumed = await resumeYouTubeJob(job.id, { tokenProvider: async () => 'fixture', fetcher: mockFetch((url, init) => {
      if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] });
      if (init.method === 'POST') { inserts++; throw new Error('A resumed upload must never insert another video.'); }
      if (init.method === 'PUT' && !init.body) return new Response(null, { status: 308, headers: { Range: `bytes=0-${chunkSize - 1}` } });
      if (init.method === 'PUT') { const range = new Headers(init.headers).get('Content-Range') ?? ''; ranges.push(range); assert.ok((init.body as ArrayBuffer).byteLength <= chunkSize); if (range.startsWith(`bytes ${chunkSize}-`)) return new Response(null, { status: 308, headers: { Range: `bytes=0-${chunkSize * 2 - 1}` } }); return json({ id: videoId }, 201); }
      return readback();
    }) });
    assert.equal(resumed.status, 'published'); assert.equal(resumed.attempts, 1); assert.equal(inserts, 1); assert.equal(ranges[0], `bytes 0-${chunkSize - 1}/${bytes.length}`); assert.equal(ranges[2], `bytes ${chunkSize}-${chunkSize * 2 - 1}/${bytes.length}`);
  } finally { await data.cleanup(); }
});

test('container OAuth uses a fixed published loopback port and retains Host/state/PKCE checks', async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const address = probe.address(); assert(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), 'youtube-container-oauth-')); const clientFile = join(directory, 'client.json');
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'fixture-client', client_secret: 'fixture-secret' } }));
  let challenge = '';
  try {
    const result = await authorizeDesktopYouTube({ clientFile, secretDirectory: join(directory, 'secrets'), callbackPort: port, listenHost: '0.0.0.0', timeoutMs: 5000, onAuthorizationUrl: async value => {
      const authorization = new URL(value); assert.equal(authorization.searchParams.get('scope'), youtubeScopes.join(' ')); challenge = authorization.searchParams.get('code_challenge') ?? '';
      const callback = new URL(authorization.searchParams.get('redirect_uri') ?? ''); assert.equal(callback.origin, `http://127.0.0.1:${port}`);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state') ?? '', code: 'fixture-code' }).toString();
      const wrongHost = await new Promise<number | undefined>((resolve, reject) => { const req = request(callback, { headers: { Host: `localhost:${port}` } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); }); req.once('error', reject); req.end(); }); assert.equal(wrongHost, 400);
      const invalid = new URL(callback); invalid.searchParams.set('state', 'wrong'); assert.equal((await fetch(invalid)).status, 400);
      assert.equal((await fetch(callback)).status, 200);
    }, fetcher: mockFetch((_url, init) => { const form = init.body as URLSearchParams; assert.equal(form.get('redirect_uri'), `http://127.0.0.1:${port}/oauth2/callback`); assert.equal(createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url'), challenge); return json({ access_token: 'fixture', refresh_token: 'fixture', expires_in: 3600, token_type: 'Bearer', scope: youtubeScopes.join(' ') }); }) });
    assert.deepEqual(result, { authorized: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('official metrics use the frozen video after article edits and preserve zero versus unavailable fields', async () => {
 const data = await fixture();
 try {
  await uploadYouTubeJob(data.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() });
  await mutateState(state => { const draft = state.drafts[0]; if (draft) { draft.revision++; draft.title = 'Newer current article'; } });
  const observed = await collectYouTubeJobMetrics(data.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch((url, init) => {
   assert.equal(init.method, 'GET');
   if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: expectedYouTubeChannelId }] });
   assert.equal(url.searchParams.get('id'), videoId); assert.equal(url.searchParams.get('part'), 'snippet,statistics');
   return json({ items: [{ id: videoId, snippet: { channelId: expectedYouTubeChannelId }, statistics: { viewCount: '0', likeCount: '2' } }] });
  }) });
  assert.equal(observed.views, 0); assert.equal(observed.likes, 2); assert.equal(observed.comments, null); assert.equal(observed.shares, null); assert.equal(observed.source, 'official_api');
 } finally { await data.cleanup(); }
});
test('metrics reject account mismatch and surface rate-limit and authorization errors without an observation', async () => {
 const data = await fixture();
 try {
  await uploadYouTubeJob(data.id, settings, { tokenProvider: async () => 'fixture-token', fetcher: successfulUploadFetch() });
  for (const status of [429, 401]) await assert.rejects(collectYouTubeJobMetrics(data.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(url => url.pathname === '/youtube/v3/channels' ? json({ items: [{ id: expectedYouTubeChannelId }] }) : json({}, status, { 'Retry-After': '120' })) }), caught => caught instanceof Error && 'metricCode' in caught && caught.metricCode === (status === 429 ? 'RATE_LIMIT' : 'AUTH_REQUIRED'));
  await assert.rejects(collectYouTubeJobMetrics(data.id, { tokenProvider: async () => 'fixture-token', fetcher: mockFetch(url => url.pathname === '/youtube/v3/channels' ? json({ items: [{ id: expectedYouTubeChannelId }] }) : json({ items: [{ id: videoId, snippet: { channelId: 'wrong-channel' }, statistics: { viewCount: '100' } }] })) }), /unavailable for the expected account/);
  assert.equal((await readState()).jobs[0]?.metrics.length, 0);
 } finally { await data.cleanup(); }
});
