import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { emptyState, type Brief, type Generated, type Platform } from '../src/core/model.ts';
import { addAccount, approveDraft, cancelJob, confirmPublication, createDraft, exportJob, extractPlatformId, pausePublishing, reconcileJob, recordMetrics, replaceDraft, runDueJobs, scheduleJob, updateAccount, validateReceipt } from '../src/core/pipeline.ts';
import { canonicalPostizContent } from '../src/core/postiz.ts';
import { mutateState, readState, storageMode } from '../src/core/store.ts';
import { generateContent } from '../src/core/generator.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let directory = '';
const date = '2026-01-01T10:00:00.000Z';
function brief(platform: Platform = 'x'): Brief { return { topic: 'Maintained publishing integrations', audience: 'Independent creators', angle: 'Practical design', sources: [{ title: 'Postiz API', url: 'https://docs.postiz.com/public-api/posts/create', excerpt: 'Posts have per-provider settings.' }], platforms: [platform] }; }
function generated(platform: Platform = 'x', text = 'A source-backed publishing workflow.'): Generated { return { title: 'Publishing workflow', body: 'An article based on the supplied evidence.', variants: [{ platform, title: 'Publishing workflow', text, tags: [], mediaPaths: [] }] }; }
async function native(platform: Platform = 'x') { return addAccount({ platform, label: `Test ${platform}`, provider: 'native', integrationId: '', status: 'connected', note: 'Operator verified.', verifiedAt: date }); }
async function prepared(provider: 'native' | 'postiz' = 'native', text = 'A source-backed publishing workflow.') {
  const account = provider === 'native' ? await native() : await addAccount({ platform: 'x', label: 'Test X', provider: 'postiz', integrationId: 'integration-x', status: 'connected', note: '', verifiedAt: null });
  const draft = await createDraft(brief(), generated('x', text)); await approveDraft(draft.id);
  const job = await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  return { account, draft, job };
}
function mockPostiz(post: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  process.env.POSTIZ_API_KEY = 'test-not-a-secret';
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/integrations')) return Response.json([{ id: 'integration-x', name: 'Test X', identifier: 'x', disabled: false }]);
    return post(input, init);
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'content-studio-core-test-'));
  process.env.STUDIO_DATA_DIR = directory;
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'POSTIZ_API_KEY', 'POSTIZ_BASE_URL']) delete process.env[key];
  globalThis.fetch = originalFetch;
});
afterEach(async () => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });

test('approval is required and duplicate content cannot be scheduled twice', async () => {
  const account = await native(); const draft = await createDraft(brief(), generated());
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /approval|approve/i);
  await approveDraft(draft.id);
  const input = { draftId: draft.id, accountId: account.id, scheduledAt: date };
  await scheduleJob(input); await assert.rejects(scheduleJob(input), /same content/i);
});
test('pause blocks dispatch; native handoff requires a platform receipt', async () => {
  const { job } = await prepared();
  await pausePublishing(true); assert.deepEqual(await runDueJobs(), []);
  assert.equal((await readState()).jobs[0]?.status, 'scheduled');
  await pausePublishing(false); assert.equal((await runDueJobs())[0]?.status, 'awaiting_operator');
  await assert.rejects(confirmPublication(job.id, 'https://reddit.com/r/test/comments/123', '123'), /platform domain/);
  assert.equal((await confirmPublication(job.id, 'https://x.com/test/status/123', '123')).status, 'published');
  assert.equal((await recordMetrics(job.id, { views: 10, likes: 2, comments: 1, clicks: null, notes: 'Manual snapshot' })).metrics.length, 1);
});
test('revision changes invalidate queued approval even after the revised draft is approved', async () => {
  const { draft, job } = await prepared();
  assert.equal((await replaceDraft(draft.id, generated('x', 'Changed text.'))).approvedHash, null);
  await approveDraft(draft.id);
  assert.equal((await runDueJobs())[0]?.status, 'failed');
  assert.equal((await exportJob(job.id)).variant.text, generated().variants[0]!.text);
});
test('direct content and account target tampering fail approval checks', async () => {
  const { draft } = await prepared();
  await mutateState(state => { const item = state.drafts.find(value => value.id === draft.id); if (item) item.variants[0]!.text = 'Unapproved edit.'; });
  assert.equal((await runDueJobs())[0]?.status, 'failed');
  await approveDraft(draft.id);
  const { accounts } = await readState();
  const job = await scheduleJob({ draftId: draft.id, accountId: accounts[0]!.id, scheduledAt: date });
  await mutateState(state => { state.accounts[0]!.label = 'Another target'; });
  assert.equal((await runDueJobs()).find(value => value.id === job.id)?.status, 'failed');
});
test('dedupe persists the original content after an approved draft is edited', async () => {
  const { draft, account } = await prepared(); await runDueJobs();
  await replaceDraft(draft.id, generated('x', 'A different new version.')); await approveDraft(draft.id);
  await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  const sameOriginal = await createDraft(brief(), generated()); await approveDraft(sameOriginal.id);
  await assert.rejects(scheduleJob({ draftId: sameOriginal.id, accountId: account.id, scheduledAt: date }), /same content/);
});
test('network loss after submitting becomes needs_reconciliation and is never automatically retried', async () => {
  let posts = 0;
  mockPostiz(async (_input, init) => {
    if (init?.method === 'POST') { posts++; assert.equal((await readState()).jobs[0]?.status, 'submitting'); throw new Error('connection lost'); }
    return Response.json({ posts: [] });
  });
  const { job } = await prepared('postiz');
  assert.equal((await runDueJobs())[0]?.status, 'needs_reconciliation');
  await runDueJobs(); assert.equal(posts, 1);
  await assert.rejects(cancelJob(job.id), /may already exist/);
  assert.equal((await reconcileJob(job.id)).status, 'needs_reconciliation');
});
test('Postiz contract uses raw Authorization and publishes an overdue job now while retaining requested schedule', async () => {
  let body: unknown;
  mockPostiz(async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'test-not-a-secret');
    body = JSON.parse(String(init?.body));
    return Response.json([{ postId: 'post-1', integration: 'integration-x' }]);
  });
  await prepared('postiz'); const result = (await runDueJobs())[0]!; assert.equal(result.status, 'queued'); assert.equal(result.scheduledAt, date); assert.equal(result.providerPostId, 'post-1'); assert.equal(result.remoteId, null);
  assert.ok(result.submissionStartedAt && Date.now() - Date.parse(result.submissionStartedAt) < 10000);
  assert.deepEqual(body, { type: 'now', date: result.submissionStartedAt, shortLink: false, tags: [], posts: [{ integration: { id: 'integration-x' }, value: [{ content: generated().variants[0]!.text, image: [] }], settings: { __type: 'x', who_can_reply_post: 'everyone' } }] });
});
test('a malformed successful receipt and a provider 500 remain uncertain', async () => {
  mockPostiz(async () => Response.json({ id: 'wrong-schema' }));
  await prepared('postiz'); assert.equal((await runDueJobs())[0]?.status, 'needs_reconciliation');
  await mutateState(state => { state.jobs = []; });
  mockPostiz(async () => new Response('error', { status: 500 }));
  const state = await readState(); await scheduleJob({ draftId: state.drafts[0]!.id, accountId: state.accounts[0]!.id, scheduledAt: date });
  assert.equal((await runDueJobs())[0]?.status, 'needs_reconciliation');
});
test('reconciliation requires PUBLISHED and a matching platform URL', async () => {
  let releaseURL = 'https://x.com/test/status/456';
  let stateValue = 'QUEUE';
  mockPostiz(async (_input, init) => init?.method === 'POST' ? Response.json([{ postId: 'post-1', integration: 'integration-x' }]) : Response.json({ posts: [{ id: 'post-1', content: generated().variants[0]!.text, publishDate: date, releaseURL, state: stateValue, error: null, integration: { id: 'integration-x', providerIdentifier: 'x' } }] }));
  const { job } = await prepared('postiz'); await runDueJobs();
  assert.equal((await reconcileJob(job.id)).status, 'queued');
  stateValue = 'PUBLISHED'; releaseURL = 'https://evil.example/post/456';
  assert.equal((await reconcileJob(job.id)).status, 'needs_reconciliation');
  releaseURL = 'https://x.com/test/status/456';
  const published = await reconcileJob(job.id); assert.equal(published.status, 'published'); assert.equal(published.remoteId, '456'); assert.equal(published.providerPostId, 'post-1');
});
test('orphaned submitting jobs recover without another POST', async () => {
  const { job } = await prepared();
  await mutateState(state => { const item = state.jobs.find(value => value.id === job.id)!; item.status = 'submitting'; item.submissionOwner = null; item.submissionStartedAt = null; });
  assert.equal((await runDueJobs())[0]?.status, 'needs_reconciliation');
});
test('video platforms reject scripts, missing files, and text disguised as mp4', async () => {
  const account = await native('youtube'); const draft = await createDraft(brief('youtube'), generated('youtube')); await approveDraft(draft.id);
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /real video/);
  const missing = generated('youtube'); missing.variants[0]!.mediaPaths = [join(directory, 'missing.mp4')]; await replaceDraft(draft.id, missing);
  await assert.rejects(approveDraft(draft.id), /does not exist/);
  const fakeVideo = join(directory, 'fake.mp4'); await writeFile(fakeVideo, 'This is a text script pretending to be a video asset.');
  missing.variants[0]!.mediaPaths = [fakeVideo]; await replaceDraft(draft.id, missing); await approveDraft(draft.id);
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /real video/);
});
test('changed media bytes invalidate approval', async () => {
  const media = join(directory, 'image.png'); await writeFile(media, Buffer.from('an original binary asset'));
  const content = generated(); content.variants[0]!.mediaPaths = [media];
  const account = await native(); const draft = await createDraft(brief(), content); await approveDraft(draft.id);
  await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  await writeFile(media, Buffer.from('a replacement asset at the same path'));
  assert.equal((await runDueJobs())[0]?.status, 'failed');
});
test('corrupt local state is preserved', async () => {
  const file = join(directory, 'state.json'); await writeFile(file, '{corrupt');
  await assert.rejects(readState(), /invalid/);
  await assert.rejects(mutateState(state => { state.paused = true; }), /invalid/);
  assert.equal(await readFile(file, 'utf8'), '{corrupt');
});
test('local mutation serializes concurrent writers in this process', async () => {
  await Promise.all(Array.from({ length: 15 }, (_, index) => addAccount({ platform: 'x', label: `Account ${index}`, provider: 'native', integrationId: '', status: 'needs_login', note: '', verifiedAt: null })));
  assert.equal((await readState()).accounts.length, 15);
});
test('local lock serializes separate worker processes', async () => {
  const storeUrl = new URL('../src/core/store.ts', import.meta.url).href;
  const code = `import { randomUUID } from 'node:crypto'; import { mutateState } from ${JSON.stringify(storeUrl)}; for (let index = 0; index < 5; index++) await mutateState(state => { state.accounts.push({ id: randomUUID(), platform: 'x', label: 'worker-' + process.pid + '-' + index, provider: 'native', integrationId: '', status: 'needs_login', note: '', verifiedAt: null }); });`;
  const run = () => new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), env: { ...process.env, STUDIO_DATA_DIR: directory }, stdio: 'pipe' });
    let output = ''; child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.once('error', reject); child.once('close', exit => exit === 0 ? resolveRun() : reject(new Error(output)));
  });
  await Promise.all([run(), run(), run()]); assert.equal((await readState()).accounts.length, 15);
});
test('receipt domains reject deceptive suffixes, credential URLs, landing pages, and empty IDs', () => {
  for (const url of ['https://x.com.evil.example/test/status/1', 'https://user:pass@x.com/test/status/1', 'https://x.com/', 'https://x.com/compose/post', 'https://x.com/settings', 'http://x.com/test/status/1']) assert.throws(() => validateReceipt('x', url, '1'));
  assert.throws(() => validateReceipt('x', 'https://x.com/test/status/1', ''));
  assert.throws(() => validateReceipt('x', 'https://x.com/test/status/1', 'unrelated-provider-id'), /does not match/);
});
test('all supported native receipt routes extract identifiers and reject mismatched supplied IDs', () => {
  const examples: [Platform, string, string][] = [
    ['x', 'https://x.com/creator/status/123', '123'], ['reddit', 'https://www.reddit.com/r/testing/comments/abc123/title/', 'abc123'],
    ['youtube', 'https://www.youtube.com/watch?v=abcdefghijk', 'abcdefghijk'], ['youtube', 'https://youtu.be/abcdefghijk', 'abcdefghijk'], ['youtube', 'https://youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
    ['tiktok', 'https://www.tiktok.com/@creator/video/123456789', '123456789'], ['xiaohongshu', 'https://www.xiaohongshu.com/explore/abc123', 'abc123'], ['xiaohongshu', 'https://www.xiaohongshu.com/discovery/item/abc123', 'abc123'],
    ['linkedin', 'https://www.linkedin.com/feed/update/urn:li:activity:123456/', '123456'], ['linkedin', 'https://www.linkedin.com/posts/creator_new-post_activity-123456-abc/', '123456'],
    ['wechat', 'https://mp.weixin.qq.com/s/token123', 'token123'], ['wechat', 'https://mp.weixin.qq.com/s?__biz=example&mid=123456&idx=1', '123456'],
    ['bilibili', 'https://www.bilibili.com/video/BV1abc123/', 'BV1abc123'], ['bilibili', 'https://www.bilibili.com/read/cv123456/', 'cv123456'],
    ['kuaishou', 'https://www.kuaishou.com/short-video/Abc123', 'Abc123'], ['douyin', 'https://www.douyin.com/video/123456', '123456'], ['douyin', 'https://www.douyin.com/note/123456', '123456'],
    ['instagram', 'https://www.instagram.com/p/Abc123/', 'Abc123'], ['instagram', 'https://www.instagram.com/reel/Abc123/', 'Abc123'],
    ['facebook', 'https://www.facebook.com/creator/posts/pfbidAbc123', 'pfbidAbc123'], ['facebook', 'https://www.facebook.com/reel/123456', '123456'], ['facebook', 'https://www.facebook.com/watch/?v=123456', '123456'], ['facebook', 'https://fb.watch/Abc123/', 'Abc123']
  ];
  for (const [platform, url, id] of examples) { assert.equal(extractPlatformId(platform, url), id); assert.equal(validateReceipt(platform, url, id), new URL(url).href); assert.throws(() => validateReceipt(platform, url, `${id}-wrong`), /does not match/); }
  assert.throws(() => extractPlatformId('youtube', 'https://studio.youtube.com/channel/abcdefghijk'));
  assert.throws(() => extractPlatformId('bilibili', 'https://b23.tv/redirect-token'));
  assert.throws(() => extractPlatformId('tiktok', 'https://www.tiktok.com/tiktokstudio/upload'));
});
test('partial Supabase configuration fails explicitly', () => { process.env.SUPABASE_URL = 'https://example.supabase.co'; assert.throws(storageMode, /together/); });
test('Supabase optimistic CAS retries a conflicting write without losing changes', async () => {
  const id = randomUUID(); process.env.SUPABASE_URL = 'https://example.supabase.co'; process.env.SUPABASE_SECRET_KEY = 'test-secret'; process.env.STUDIO_WORKSPACE_ID = id;
  let row = { id, state: emptyState(), revision: 0 }; let firstWrite = true;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') {
      if (firstWrite) { firstWrite = false; row = { ...row, revision: 1 }; return Response.json([]); }
      const body = JSON.parse(String(init.body)) as { state: typeof row.state; revision: number }; row = { ...row, ...body }; return Response.json([row]);
    }
    return Response.json([row]);
  };
  await pausePublishing(true); assert.equal(row.state.paused, true); assert.equal(row.revision, 2);
});
test('draft replacement rejects stale media completion and active submissions', async () => {
  const { draft, job } = await prepared();
  await replaceDraft(draft.id, generated('x', 'The newer revision.'), draft.revision);
  await assert.rejects(replaceDraft(draft.id, generated('x', 'Stale generated media.'), draft.revision), /revision changed/);
  await mutateState(state => { state.jobs.find(value => value.id === job.id)!.status = 'submitting'; });
  await assert.rejects(replaceDraft(draft.id, generated('x', 'Another edit.')), /active provider submission/);
});
test('account login status can renew while target changes are blocked during submission', async () => {
  const { account, job } = await prepared();
  const { id, ...input } = account;
  await updateAccount(id, { ...input, status: 'needs_login', verifiedAt: null });
  assert.equal((await readState()).accounts[0]!.status, 'needs_login');
  await updateAccount(id, { ...input, status: 'connected' });
  await mutateState(state => { state.jobs.find(value => value.id === job.id)!.status = 'submitting'; });
  await assert.rejects(updateAccount(id, { ...input, label: 'Different account' }), /cannot change/);
  assert.equal((await updateAccount(id, { ...input, note: 'Session verified again' })).note, 'Session verified again');
});
test('final preflight revalidates content after remote integration lookup before any POST', async () => {
  let integrationReads = 0; let posts = 0; let draftId = '';
  process.env.POSTIZ_API_KEY = 'test-key';
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/integrations')) {
      integrationReads++;
      if (integrationReads === 2) await mutateState(state => { state.drafts.find(value => value.id === draftId)!.variants[0]!.text = 'Tampered while awaiting GET'; });
      return Response.json([{ id: 'integration-x', name: 'Test X', identifier: 'x', disabled: false }]);
    }
    if (init?.method === 'POST') posts++;
    return Response.json([{ postId: 'post-1', integration: 'integration-x' }]);
  };
  const ready = await prepared('postiz'); draftId = ready.draft.id;
  assert.equal((await runDueJobs())[0]?.status, 'failed'); assert.equal(posts, 0);
});
test('transmitted tags count toward platform limits and dedupe the final text', async () => {
  mockPostiz(async () => Response.json([{ postId: 'post-1', integration: 'integration-x' }]));
  const { draft, account, job } = await prepared('postiz'); await cancelJob(job.id);
  const tagged = generated('x', 'A factual post.'); tagged.variants[0]!.tags = ['#evidence', 'research'];
  assert.equal(canonicalPostizContent(tagged.variants[0]!), 'A factual post.\n\n#evidence #research');
  await replaceDraft(draft.id, tagged); await approveDraft(draft.id);
  await scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date });
  const duplicate = generated('x', canonicalPostizContent(tagged.variants[0]!)); duplicate.variants[0]!.title = 'Different metadata title';
  const anotherDraft = await createDraft(brief(), duplicate); await approveDraft(anotherDraft.id);
  await assert.rejects(scheduleJob({ draftId: anotherDraft.id, accountId: account.id, scheduledAt: date }), /same content/);
  const oversized = generated('x', 'a'.repeat(278)); oversized.variants[0]!.tags = ['tag'];
  await replaceDraft(draft.id, oversized); await approveDraft(draft.id);
  await assert.rejects(scheduleJob({ draftId: draft.id, accountId: account.id, scheduledAt: date }), /text and tags/);
});
test('unknown outcome reconciliation uses immutable original content and target after source edits', async () => {
  let submittedAt = ''; let submittedContent = '';
  mockPostiz(async (_input, init) => {
    if (init?.method === 'POST') { const body = JSON.parse(String(init.body)) as { date: string; posts: { value: { content: string }[] }[] }; submittedAt = body.date; submittedContent = body.posts[0]!.value[0]!.content; throw new Error('lost response'); }
    return Response.json({ posts: [{ id: 'original-post', content: submittedContent, publishDate: submittedAt, releaseURL: 'https://x.com/test/status/99', state: 'PUBLISHED', integration: { id: 'integration-x' } }] });
  });
  const { draft, job, account } = await prepared('postiz'); await runDueJobs();
  await replaceDraft(draft.id, generated('x', 'A newer unrelated draft.'));
  await mutateState(state => { state.accounts.find(value => value.id === account.id)!.integrationId = 'new-integration'; });
  assert.equal((await exportJob(job.id)).variant.text, generated().variants[0]!.text);
  assert.equal((await reconcileJob(job.id)).status, 'published');
});
test('a store failure after remote acceptance leaves submitting for reconciliation rather than failed', async () => {
  mockPostiz(async () => {
    await writeFile(join(directory, 'state.json'), '{unavailable state');
    return Response.json([{ postId: 'post-accepted', integration: 'integration-x' }]);
  });
  await prepared('postiz');
  let durableBeforePost = '';
  mockPostiz(async () => { durableBeforePost = await readFile(join(directory, 'state.json'), 'utf8'); await writeFile(join(directory, 'state.json'), '{unavailable state'); return Response.json([{ postId: 'post-accepted', integration: 'integration-x' }]); });
  await assert.rejects(runDueJobs(), /invalid/);
  const durable = JSON.parse(durableBeforePost) as { jobs: { status: string }[] }; assert.equal(durable.jobs[0]?.status, 'submitting');
  await writeFile(join(directory, 'state.json'), durableBeforePost);
  assert.equal((await runDueJobs())[0]?.status, 'needs_reconciliation');
});
test('Codex generation runs isolated without publishing secrets and validates its exact outputs', async () => {
  const executable = join(directory, 'fake-codex'); const trace = join(directory, 'trace.json');
  const output = generated();
  const script = () => `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; const args = process.argv.slice(2); process.stdin.resume(); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, cwd: process.cwd(), hasPostiz: Boolean(process.env.POSTIZ_API_KEY), hasSupabase: Boolean(process.env.SUPABASE_SECRET_KEY) })); writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(JSON.stringify({ assessment: { status: 'allowed', reasons: ['Practical software workflow with supplied evidence.'] }, content: output }))}); });\n`;
  await writeFile(executable, script(), { mode: 0o700 }); process.env.CODEX_BIN = executable; process.env.POSTIZ_API_KEY = 'never-inherit-this'; process.env.SUPABASE_SECRET_KEY = 'never-inherit-this-either';
  assert.deepEqual(await generateContent(brief()), output);
  const details = JSON.parse(await readFile(trace, 'utf8')) as { args: string[]; cwd: string; hasPostiz: boolean; hasSupabase: boolean };
  assert.equal(details.hasPostiz, false); assert.equal(details.hasSupabase, false); assert.notEqual(details.cwd, process.cwd());
  for (const flag of ['--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--output-schema', '--skip-git-repo-check']) assert.ok(details.args.includes(flag));
  output.variants[0]!.mediaPaths = ['/invented/video.mp4'];
  await writeFile(executable, script(), { mode: 0o700 });
  await assert.rejects(generateContent(brief()), /invent media/);
});
