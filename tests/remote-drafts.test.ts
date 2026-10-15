import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import sharp from 'sharp';
import { z } from 'zod';
import { type Generated, type Job, type Platform } from '../src/core/model.ts';
import { addAccount, approveDraft, confirmPublication, createDraft, pausePublishing, replaceDraft, runDueJobs, updateAccount } from '../src/core/pipeline.ts';
import { confirmDraftReceipt, executeRemoteDraft, parseNativeDraftReceipt, prepareRemoteDrafts, safeDraftUrl } from '../src/core/remote-drafts.ts';
import { saveDraftBridgeConfig } from '../src/core/draft-bridge-config.ts';
import { bindDraftAccount } from '../src/core/draft-connectors.ts';
import { mutateState, readState } from '../src/core/store.ts';

const originalEnv = { ...process.env }; const originalFetch = globalThis.fetch;
const extensionId = 'a'.repeat(32); const serviceKey = 'service-fixture-'.repeat(4);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-remote-drafts-'));
  process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_DRAFT_BRIDGE_CONFIG = join(directory, 'private', 'config.json');
  process.env.STUDIO_DRAFT_BRIDGE_URL = 'http://draft-bridge:8915';
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'POSTIZ_API_KEY', 'POSTIZ_BASE_URL', 'STUDIO_LOCALFS_DIR']) delete process.env[key];
  await saveDraftBridgeConfig({ extensionId, extensionToken: 'extension-fixture-token', pairingKey: 'pairing-fixture-'.repeat(4), serviceKey });
});
afterEach(async () => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });

const content = (platform: Platform, mediaPaths: string[] = []): Generated => ({ title: 'Source-backed workflow', body: 'Original master.', variants: [{ platform, format: 'article', title: 'Reviewed platform title', text: 'An original <source-backed> article.', tags: ['Coding'], mediaPaths }] });
async function fixture(platform: 'zhihu' | 'wechat' | 'bilibili' = 'zhihu', mediaPaths: string[] = []) {
  fakeBridge();
  const account = await bindDraftAccount(platform, { expectedUserId: 'owner-123', permissionConfirmed: true });
  const draft = await createDraft({ topic: 'Original workflow', audience: 'Developers', angle: 'Verified source explanation', sources: [{ title: 'Original reference', url: 'https://example.com/reference', excerpt: 'An actual fixture reference.' }], platforms: [platform] }, content(platform, mediaPaths));
  const prepare = () => prepareRemoteDrafts(draft.id, { expectedRevision: draft.revision, accountIds: [account.id] });
  return { account, draft, prepare };
}
const nativeReceipt = (platform = 'zhihu', overrides: Record<string, unknown> = {}) => ({ results: [{ platform, success: true, draftOnly: true, postId: '123', postUrl: platform === 'weixin' ? 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=123&token=SECRET_SESSION' : platform === 'bilibili' ? 'https://member.bilibili.com/platform/upload/text/edit?aid=123' : 'https://zhuanlan.zhihu.com/p/123/edit', ...overrides }], syncId: 'fixture-sync' });
const bridgePayload = z.object({ method: z.enum(['checkAuth', 'syncArticle']), params: z.record(z.string(), z.unknown()) });
function fakeBridge(options: { userId?: string; reply?: unknown; write?: (params: Record<string, unknown>) => Promise<unknown> } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://draft-bridge:8915/request');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${serviceKey}`);
    const payload = bridgePayload.parse(JSON.parse(String(init?.body)) as unknown); calls.push(payload);
    if (payload.method === 'checkAuth') return Response.json({ result: { isAuthenticated: true, userId: options.userId ?? 'owner-123', username: 'Fixture owner' } });
    return Response.json({ result: options.write ? await options.write(payload.params) : options.reply ?? nativeReceipt() });
  };
  return calls;
}
const first = (jobs: Job[]) => { const job = jobs[0]; assert.ok(job); return job; };

test('preparing draft jobs binds immutable revision/account and deduplicates without public approval', async () => {
  const value = await fixture(); const before = (await readState()).drafts[0]; const job = first(await value.prepare());
  assert.equal(job.deliveryAction, 'save_draft'); assert.equal(job.status, 'scheduled'); assert.equal(job.attempts, 0);
  assert.equal(job.snapshot?.draft?.revision, value.draft.revision); assert.equal(job.snapshot?.account.draftConnection?.userId, 'owner-123');
  assert.equal((await readState()).drafts[0]?.approvedHash, before?.approvedHash); assert.equal(before?.approvedHash, null);
  assert.equal(first(await value.prepare()).id, job.id); assert.equal((await readState()).jobs.length, 1);
  await assert.rejects(prepareRemoteDrafts(value.draft.id, { expectedRevision: 2, accountIds: [value.account.id] }), /revision/);
  await approveDraft(value.draft.id); const approved = (await readState()).drafts[0]?.approvedHash;
  assert.equal(first(await value.prepare()).id, job.id); assert.equal((await readState()).drafts[0]?.approvedHash, approved);
});

test('ordinary account creation cannot inject a trusted browser identity', async () => {
  const account = await addAccount({ platform: 'zhihu', provider: 'native', label: 'Unverified input', integrationId: '', status: 'connected', note: '', verifiedAt: null, draftConnection: { adapter: 'wechatsync', extensionId, userId: 'owner-123', checkedAt: new Date().toISOString(), permissionConfirmed: true } });
  assert.equal(account.draftConnection, undefined);
  assert.equal((await readState()).accounts[0]?.draftConnection, undefined);
});

test('one physical browser account cannot be bound to a second native record', async () => {
  await fixture();
  const second = await addAccount({ platform: 'zhihu', provider: 'native', label: 'Other local label', integrationId: '', status: 'connected', note: '', verifiedAt: null });
  await assert.rejects(bindDraftAccount('zhihu', { expectedUserId: 'owner-123', permissionConfirmed: true }, second.id));
});

test('a changed account record cannot hide an uncertain physical-account draft', async () => {
  const value = await fixture(); const job = first(await value.prepare());
  fakeBridge({ write: async () => { throw new Error('Network lost'); } });
  await executeRemoteDraft(job.id);
  await assert.rejects(updateAccount(value.account.id, { ...value.account, platform: 'wechat', label: 'Changed local record' }), /active or uncertain/);
  await mutateState(state => { const account = state.accounts.find(item => item.id === value.account.id); assert.ok(account); account.platform = 'wechat'; delete account.draftConnection; });
  fakeBridge();
  await assert.rejects(bindDraftAccount('zhihu', { expectedUserId: 'owner-123', permissionConfirmed: true }));
});

test('a renamed Postiz integration cannot bypass an uncertain provider draft', async () => {
  process.env.POSTIZ_API_KEY = 'fixture-provider-key'; process.env.POSTIZ_BASE_URL = 'https://postiz.example/public/v1';
  globalThis.fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'fixture-provider-key');
    if (String(input) === 'https://postiz.example/public/v1/integrations') return Response.json([{ id: 'original-integration', identifier: 'linkedin', name: 'Original account' }, { id: 'replacement-integration', identifier: 'linkedin', name: 'Replacement account' }]);
    assert.equal(String(input), 'https://postiz.example/public/v1/posts');
    throw new Error('Provider connection lost after write');
  };
  const account = await addAccount({ platform: 'linkedin', provider: 'postiz', label: 'Original local record', integrationId: 'original-integration', status: 'connected', note: '', verifiedAt: null });
  const draft = await createDraft({ topic: 'Original workflow', audience: 'Developers', angle: 'Source explanation', sources: [{ title: 'Reference', url: 'https://example.com/reference', excerpt: 'Fixture source.' }], platforms: ['linkedin'] }, content('linkedin'));
  const job = first(await prepareRemoteDrafts(draft.id, { expectedRevision: 1, accountIds: [account.id] }));
  assert.equal((await executeRemoteDraft(job.id)).status, 'needs_reconciliation');
  await assert.rejects(updateAccount(account.id, { ...account, integrationId: 'replacement-integration' }), /active or uncertain/);
  await mutateState(state => { const current = state.accounts.find(item => item.id === account.id); assert.ok(current); current.integrationId = 'replacement-integration'; });
  const replacement = await addAccount({ ...account, label: 'New local record', integrationId: 'original-integration' });
  await assert.rejects(prepareRemoteDrafts(draft.id, { expectedRevision: 1, accountIds: [replacement.id] }), /existing account delivery/);
});

test('saving a remote draft works while public publishing is paused and never records publication IDs', async () => {
  const value = await fixture(); const calls = fakeBridge(); const job = first(await value.prepare()); await pausePublishing(true);
  const saved = await executeRemoteDraft(job.id);
  assert.equal(saved.status, 'draft_saved'); assert.equal(saved.attempts, 1); assert.equal(saved.remoteId, null); assert.equal(saved.remoteUrl, null); assert.equal(saved.providerPostId, null);
  assert.deepEqual(saved.draftReceipt, { destination: 'platform', id: '123', url: 'https://zhuanlan.zhihu.com/p/123/edit', verification: 'adapter_reported' });
  assert.deepEqual(calls.map(call => call.method), ['checkAuth', 'syncArticle']);
  const article = z.object({ title: z.string(), content: z.string() }).parse(calls[1]?.params.article);
  assert.ok(article.content.includes('An original  article.')); assert.ok(article.content.includes('<h2>Sources</h2><p>Original reference<br>https://example.com/reference</p>')); assert.ok(!article.content.includes('<source-backed>'));
  assert.equal((await readState()).drafts[0]?.approvedHash, null); assert.equal((await readState()).paused, true);
  assert.equal((await executeRemoteDraft(job.id)).status, 'draft_saved'); assert.equal(calls.length, 2);
});

test('knowledge-only draft rendering omits the empty external Sources section', async () => {
  const value = await fixture();
  const draft = await createDraft({ ...value.draft.brief, sources: [], knowledgeIds: ['48de3319-8c98-477e-ae30-1f7d1b91c048'] }, content('zhihu'), undefined, undefined, { instruction: '', assetIds: [], knowledgeRef: '7ea626b1-378b-40d5-8fd0-e58a8c1a341d' });
  const job = first(await prepareRemoteDrafts(draft.id, { expectedRevision: draft.revision, accountIds: [value.account.id] }));
  const calls = fakeBridge(); assert.equal((await executeRemoteDraft(job.id)).status, 'draft_saved');
  const article = z.object({ content: z.string() }).parse(calls[1]?.params.article);
  assert.ok(article.content.includes('An original  article.')); assert.ok(article.content.includes('<p>#Coding</p>'));
  assert.ok(!article.content.includes('<h2>Sources</h2>'));
});

test('draft rendering formats the frozen Markdown while retaining managed images and original approval', async () => {
  const path = join(directory, 'media', 'reviewed.png'); await mkdir(join(directory, 'media'));
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(path);
  const value = await fixture('zhihu', [path]);
  const generated = content('zhihu', [path]);
  const markdown = '## Fixed revision\n\n**Review** the backup.\n\n- Keep evidence\n- Verify bytes\n\n![Unmanaged image](https://remote.example/image.png)\n\n<script>alert(1)</script>';
  generated.variants[0]!.text = markdown;
  const updated = await replaceDraft(value.draft.id, generated, value.draft.revision);
  await approveDraft(updated.id);
  const approved = (await readState()).drafts.find(draft => draft.id === updated.id)?.approvedHash;
  const job = first(await prepareRemoteDrafts(updated.id, { expectedRevision: updated.revision, accountIds: [value.account.id] }));
  assert.equal(job.snapshot?.variant.text, markdown);
  const calls = fakeBridge();
  const saved = await executeRemoteDraft(job.id); assert.equal(saved.status, 'draft_saved');
  const article = z.object({ content: z.string(), cover: z.string(), markdown: z.never().optional() }).parse(calls[1]?.params.article);
  for (const expected of ['<h2>Fixed revision</h2>', '<strong>Review</strong>', '<li>Keep evidence</li>', 'Unmanaged image', '<p>#Coding</p>', '<h2>Sources</h2>', 'https://example.com/reference']) assert.ok(article.content.includes(expected), expected);
  assert.ok(article.cover.startsWith('data:image/png;base64,'));
  assert.ok(article.content.includes(`<p><img src="${article.cover}" alt=""></p>`));
  assert.equal((article.content.match(/<img /g) ?? []).length, 1);
  for (const forbidden of ['remote.example', '<script', 'alert(1)', '## Fixed', '**Review**']) assert.ok(!article.content.includes(forbidden), forbidden);
  const current = (await readState()).drafts.find(draft => draft.id === updated.id);
  assert.equal(current?.revision, updated.revision); assert.equal(current?.variants[0]?.text, markdown);
  assert.equal(current?.approvedHash, approved); assert.ok(approved);
  assert.equal(saved.contentHash, job.contentHash); assert.equal(saved.approvedHash, job.approvedHash);
});

test('changed browser identity fails before dispatch with zero attempts', async () => {
  const value = await fixture(); const calls = fakeBridge({ userId: 'different-owner' }); const job = first(await value.prepare());
  const result = await executeRemoteDraft(job.id); assert.equal(result.status, 'failed'); assert.equal(result.attempts, 0);
  assert.deepEqual(calls.map(call => call.method), ['checkAuth']); assert.equal(result.draftReceipt, undefined);
});

test('changing a content revision or account identity invalidates pending draft preparation', async () => {
  const value = await fixture(); const job = first(await value.prepare()); const calls = fakeBridge();
  const updated = content('zhihu'); updated.variants[0]!.text = 'Changed platform article.';
  await replaceDraft(value.draft.id, updated, value.draft.revision);
  assert.equal((await executeRemoteDraft(job.id)).status, 'failed'); assert.equal(calls.length, 0);
  const current = (await readState()).drafts[0]; assert.ok(current);
  const next = first(await prepareRemoteDrafts(current.id, { expectedRevision: current.revision, accountIds: [value.account.id] }));
  await mutateState(state => { const account = state.accounts[0]; assert.ok(account?.draftConnection); account.draftConnection.userId = 'new-owner'; });
  assert.equal((await executeRemoteDraft(next.id)).status, 'failed'); assert.equal(calls.length, 0);
});

test('WeChat draft receipts strip session tokens and remain distinct from public receipts', async () => {
  const value = await fixture('wechat'); fakeBridge({ reply: nativeReceipt('weixin') }); const job = first(await value.prepare());
  const result = await executeRemoteDraft(job.id); assert.equal(result.status, 'draft_saved'); assert.ok(result.draftReceipt?.url.includes('appmsgid=123'));
  assert.ok(!JSON.stringify(await readState()).includes('SECRET_SESSION'));
  const verified = await confirmDraftReceipt(job.id, '123', nativeReceipt('weixin').results[0]!.postUrl as string);
  assert.equal(verified.draftReceipt?.verification, 'operator_verified'); assert.equal(verified.remoteId, null);
});

test('only matching native editor draft URLs are accepted and credential parameters are removed', () => {
  assert.equal(safeDraftUrl('zhihu', '123', 'https://zhuanlan.zhihu.com/p/123/edit?token=secret#hash'), 'https://zhuanlan.zhihu.com/p/123/edit');
  for (const [platform, url] of [
    ['wechat', 'https://mp.weixin.qq.com/s/public-post'],
    ['wechat', 'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=456'],
    ['zhihu', 'https://zhuanlan.zhihu.com:8443/p/123/edit'],
    ['bilibili', 'https://member.bilibili.com/platform/upload/text/edit?aid=456'],
    ['zhihu', 'https://zhuanlan.zhihu.com.attacker.example/p/123/edit'],
  ] as const) assert.throws(() => safeDraftUrl(platform, '123', url));
  assert.throws(() => parseNativeDraftReceipt('zhihu', nativeReceipt('bilibili')));
});

for (const [name, reply] of [
  ['public response', nativeReceipt('zhihu', { draftOnly: false })],
  ['wrong editor URL', nativeReceipt('zhihu', { postUrl: 'https://evil.example/p/123/edit' })],
  ['wrong platform', nativeReceipt('bilibili')],
] as const) test(`${name} becomes an uncertain draft and cannot be resubmitted`, async () => {
  const value = await fixture(); const calls = fakeBridge({ reply }); const job = first(await value.prepare());
  const result = await executeRemoteDraft(job.id); assert.equal(result.status, 'needs_reconciliation'); assert.equal(result.attempts, 1);
  assert.equal(result.remoteId, null); assert.equal(result.remoteUrl, null); assert.equal(result.draftReceipt, undefined);
  assert.equal(first(await value.prepare()).id, job.id); await executeRemoteDraft(job.id); assert.equal(calls.length, 2);
  await assert.rejects(confirmPublication(job.id, 'https://zhuanlan.zhihu.com/p/123', '123'), /draft/i);
});

test('a dispatched timeout is retained for reconciliation without an automatic second write', async () => {
  const value = await fixture(); const calls = fakeBridge({ write: async () => { throw new DOMException('Timed out with private token', 'TimeoutError'); } }); const job = first(await value.prepare());
  const result = await executeRemoteDraft(job.id); assert.equal(result.status, 'needs_reconciliation'); assert.equal(result.attempts, 1);
  assert.ok(!JSON.stringify(result).includes('private token')); await executeRemoteDraft(job.id); assert.equal(calls.length, 2);
});

test('a late receipt cannot overwrite a job after submission ownership is lost', async () => {
  const value = await fixture(); const job = first(await value.prepare());
  fakeBridge({ write: async () => {
    await mutateState(state => { const current = state.jobs.find(item => item.id === job.id); assert.ok(current); current.submissionOwner = 'replacement-owner'; current.status = 'needs_reconciliation'; });
    return nativeReceipt();
  } });
  const result = await executeRemoteDraft(job.id);
  assert.equal(result.status, 'needs_reconciliation'); assert.equal(result.submissionOwner, 'replacement-owner'); assert.equal(result.draftReceipt, undefined);
});

test('an expired draft submission lease recovers as uncertain without dispatching again', async () => {
  const value = await fixture(); const job = first(await value.prepare()); const calls = fakeBridge();
  await mutateState(state => { const current = state.jobs.find(item => item.id === job.id); assert.ok(current); current.status = 'submitting'; current.attempts = 1; current.submissionOwner = 'stopped-worker'; current.submissionLeaseUntil = '2000-01-01T00:00:00.000Z'; });
  await runDueJobs();
  const result = await executeRemoteDraft(job.id);
  assert.equal(result.status, 'needs_reconciliation'); assert.equal(result.attempts, 1); assert.equal(calls.length, 0);
});

test('public dispatcher does not consume a queued draft-intent job', async () => {
  const value = await fixture(); await approveDraft(value.draft.id); const job = first(await value.prepare());
  fakeBridge(); await runDueJobs(); const current = (await readState()).jobs.find(item => item.id === job.id);
  assert.equal(current?.status, 'scheduled'); assert.equal(current?.attempts, 0);
});

test('same-account concurrent draft writes serialize and unknown public deliveries block a new draft', async () => {
  const value = await fixture(); const firstJob = first(await value.prepare());
  const otherDraft = await createDraft({ ...value.draft.brief, topic: 'Other original article' }, { ...content('zhihu'), title: 'Other article' });
  const secondJob = first(await prepareRemoteDrafts(otherDraft.id, { expectedRevision: 1, accountIds: [value.account.id] }));
  let release: (value: unknown) => void = () => {}; let started: () => void = () => {};
  const writeStarted = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<unknown>(resolve => { release = resolve; });
  const calls = fakeBridge({ write: async () => { started(); return wait; } });
  const executing = executeRemoteDraft(firstJob.id); await writeStarted;
  const blocked = await executeRemoteDraft(secondJob.id); assert.equal(blocked.status, 'failed'); assert.equal(blocked.attempts, 0);
  release(nativeReceipt()); assert.equal((await executing).status, 'draft_saved'); assert.equal(calls.filter(call => call.method === 'syncArticle').length, 1);
  await mutateState(state => { const saved = state.jobs.find(item => item.id === firstJob.id); assert.ok(saved); saved.deliveryAction = undefined; saved.status = 'needs_reconciliation'; });
  const thirdDraft = await createDraft({ ...value.draft.brief, topic: 'Third original article' }, content('zhihu'));
  await assert.rejects(prepareRemoteDrafts(thirdDraft.id, { expectedRevision: 1, accountIds: [value.account.id] }), /existing account delivery/);
});

test('changed managed image bytes fail before bridge preflight or write', async () => {
  const path = join(directory, 'media', 'reviewed.png'); await mkdir(join(directory, 'media'));
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toFile(path);
  const value = await fixture('zhihu', [path]); const job = first(await value.prepare()); const calls = fakeBridge();
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).png().toFile(path);
  const failed = await executeRemoteDraft(job.id); assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 0); assert.equal(calls.length, 0);
});

test('an already uncertain task cannot be escaped by a new reviewed revision', async () => {
  const value = await fixture(); fakeBridge({ write: async () => { throw new Error('Network lost'); } }); const job = first(await value.prepare());
  await executeRemoteDraft(job.id);
  const updated = content('zhihu'); updated.variants[0]!.text = 'Changed platform article.';
  await replaceDraft(value.draft.id, updated, 1);
  await assert.rejects(prepareRemoteDrafts(value.draft.id, { expectedRevision: 2, accountIds: [value.account.id] }), /existing account delivery/);
});
