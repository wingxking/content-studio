import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { accountSchema, type Account, type Brief, type Generated, platformIds, productLaunchSchema } from '../src/core/model.ts';
import { publishingCapabilities, publishingCapability, validateLaunchVariant, validateRedditTarget } from '../src/core/publishing-capabilities.ts';
import { articlePackageHtml } from '../src/core/article-package.ts';
import { addAccount, approveDraft, checkAccountConnection, createDraft, extractPlatformId, replaceDraft, runDueJobs, scheduleJob, updateAccount } from '../src/core/pipeline.ts';
import { publicationHandoff, publishDraft } from '../src/core/delivery.ts';

const originalEnv = { ...process.env }; const originalFetch = globalThis.fetch;
let directory = '';
const account = (platform: Account['platform'], provider: Account['provider'] = 'native'): Account => ({ id: randomUUID(), platform, provider, label: 'Owned test account', integrationId: provider === 'postiz' ? 'reddit-integration' : '', status: 'connected', note: 'Operator observed identity.', verifiedAt: new Date().toISOString() });
const target = (): NonNullable<Account['reddit']> => ({ subreddit: 'testcommunity', rulesUrl: 'https://www.reddit.com/r/testcommunity/about/rules/', approvalReference: 'Fixture app approval reference; not real approval', rulesReviewedAt: new Date().toISOString(), flairRequired: true, flair: { id: 'flair-1', name: 'Discussion' } });
const brief = (platform: Account['platform']): Brief => ({ topic: 'Source-backed product workflow', audience: 'Independent makers', angle: 'Practical workflow', sources: [{ title: 'Source', url: 'https://docs.postiz.com/public-api/providers/reddit', excerpt: 'A self post needs a subreddit and title.' }], platforms: [platform] });
const generated = (platform: Account['platform']): Generated => ({ title: 'Workflow', body: 'Source-backed workflow.', variants: [{ platform, title: 'Reviewable workflow', text: 'A practical explanation.', tags: [], mediaPaths: [] }] });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'studio-capabilities-')); process.env.STUDIO_DATA_DIR = directory; for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'POSTIZ_API_KEY', 'POSTIZ_BASE_URL']) delete process.env[key]; });
afterEach(async () => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; await rm(directory, { recursive: true, force: true }); });

test('platform registry adds launch and long-article channels without treating login as API permission', () => {
  assert.ok(platformIds.includes('producthunt')); assert.ok(platformIds.includes('zhihu'));
  for (const platform of ['reddit', 'producthunt', 'wechat', 'zhihu', 'xiaohongshu', 'bilibili'] as const) {
    const capability = publishingCapability(platform, 'article', account(platform));
    assert.equal(capability.automatic, false); assert.equal(capability.remoteDraft, false);
  }
  const capabilities = publishingCapabilities([]); assert.equal(capabilities.length, platformIds.length * 2); assert.equal(capabilities[0]?.platform, 'reddit');
  assert.equal(publishingCapability('producthunt', 'video').stage, 'unsupported');
});
test('Reddit publishing requires an approved integration, explicit single-community target and fresh matching rules', () => {
  const value = account('reddit', 'postiz');
  assert.equal(publishingCapability('reddit', 'article', value, { postizConfigured: true }).automatic, false);
  value.reddit = target(); assert.doesNotThrow(() => validateRedditTarget(value));
  assert.equal(publishingCapability('reddit', 'article', value, { postizConfigured: true }).automatic, true);
  assert.equal(publishingCapability('reddit', 'article', value).automatic, false);
  value.reddit.rulesUrl = 'https://www.reddit.com/r/another/about/rules/'; assert.throws(() => validateRedditTarget(value), /selected subreddit/);
  value.reddit = { ...target(), rulesReviewedAt: new Date(Date.now() - 8 * 86400000).toISOString() }; assert.throws(() => validateRedditTarget(value), /seven days/);
  value.reddit = { ...target(), rulesReviewedAt: new Date(Date.now() + 3600000).toISOString() }; assert.throws(() => validateRedditTarget(value), /seven days/);
  assert.equal(accountSchema.safeParse({ ...value, reddit: { ...target(), flair: null } }).success, false);
});
test('native article drafts require a bound connected account and the matching connected bridge without enabling publication', () => {
  const extensionId = 'a'.repeat(32);
  const config = { draftBridgeConnected: true, draftBridgeExtensionId: extensionId };
  for (const platform of ['wechat', 'zhihu', 'bilibili'] as const) {
    const value = { ...account(platform), draftConnection: { adapter: 'wechatsync' as const, userId: 'verified-author', extensionId, checkedAt: new Date().toISOString(), permissionConfirmed: true as const } };
    const ready = publishingCapability(platform, 'article', value, config);
    assert.equal(ready.draftRoute, 'wechatsync');
    assert.equal(ready.remoteDraft, true);
    assert.equal(ready.providerDraft, false);
    assert.equal(ready.automatic, false);
    assert.equal(ready.stage, 'manual');
    for (const unavailable of [
      publishingCapability(platform, 'article', value),
      publishingCapability(platform, 'article', value, { ...config, draftBridgeConnected: false }),
      publishingCapability(platform, 'article', value, { ...config, draftBridgeExtensionId: null }),
      publishingCapability(platform, 'article', value, { ...config, draftBridgeExtensionId: 'b'.repeat(32) }),
      publishingCapability(platform, 'article', account(platform), config),
      publishingCapability(platform, 'article', { ...value, status: 'needs_login' }, config),
      publishingCapability(platform, 'article', { ...value, status: 'blocked' }, config),
      publishingCapability(platform, 'article', { ...value, provider: 'postiz' }, config),
      publishingCapability(platform, 'article', { ...value, platform: 'xiaohongshu' }, config),
      publishingCapability(platform, 'video', value, config),
    ]) assert.equal(unavailable.remoteDraft, false);
  }
  assert.equal(publishingCapability('xiaohongshu', 'article', account('xiaohongshu'), config).draftRoute, 'none');
});
test('Postiz review drafts are provider drafts and never platform-native drafts', () => {
  for (const platform of ['x', 'linkedin', 'reddit'] as const) {
    const value = { ...account(platform, 'postiz'), ...(platform === 'reddit' ? { reddit: target() } : {}) };
    const ready = publishingCapability(platform, 'article', value, { postizConfigured: true });
    assert.equal(ready.draftRoute, 'postiz');
    assert.equal(ready.providerDraft, true);
    assert.equal(ready.remoteDraft, false);
    assert.equal(publishingCapability(platform, 'article', value).providerDraft, false);
    assert.equal(publishingCapability(platform, 'article', { ...value, status: 'blocked' }, { postizConfigured: true }).providerDraft, false);
    assert.equal(publishingCapability(platform, 'article', { ...value, verifiedAt: null }, { postizConfigured: true }).providerDraft, false);
  }
});
test('Reddit Postiz self-post contract includes title, destination and flair and is not resubmitted', async () => {
  let posts = 0; let payload: unknown;
  process.env.POSTIZ_API_KEY = 'fixture-key';
  globalThis.fetch = async (input, init) => String(input).endsWith('/integrations') ? Response.json([{ id: 'reddit-integration', name: 'Test', identifier: 'reddit', disabled: false }]) : (posts++, payload = JSON.parse(String(init?.body)), Response.json([{ postId: 'provider-post-1', integration: 'reddit-integration' }]));
  const { id, ...input } = { ...account('reddit', 'postiz'), reddit: target() }; void id;
  const added = await addAccount(input); const draft = await createDraft(brief('reddit'), generated('reddit')); await approveDraft(draft.id);
  const job = await scheduleJob({ draftId: draft.id, accountId: added.id, scheduledAt: new Date().toISOString() });
  assert.equal((await runDueJobs())[0]?.status, 'queued'); await runDueJobs(); assert.equal(posts, 1);
  assert.equal(job.snapshot?.account.reddit?.subreddit, 'testcommunity');
  assert.deepEqual((payload as { posts: { settings: unknown }[] }).posts[0]?.settings, { __type: 'reddit', subreddit: [{ value: { subreddit: 'testcommunity', title: 'Reviewable workflow', type: 'self', url: '', is_flair_required: true, flair: { id: 'flair-1', name: 'Discussion' } } }] });
});
test('changing a Reddit community invalidates queued account-bound approval before POST', async () => {
  let posts = 0; process.env.POSTIZ_API_KEY = 'fixture-key';
  globalThis.fetch = async (_input, init) => { if (init?.method === 'POST') posts++; return Response.json([{ id: 'reddit-integration', name: 'Test', identifier: 'reddit', disabled: false }]); };
  const { id, ...input } = { ...account('reddit', 'postiz'), reddit: target() }; void id;
  const added = await addAccount(input); const draft = await createDraft(brief('reddit'), generated('reddit')); await approveDraft(draft.id);
  await scheduleJob({ draftId: draft.id, accountId: added.id, scheduledAt: new Date().toISOString() });
  await updateAccount(added.id, { ...input, reddit: { ...target(), subreddit: 'different', rulesUrl: 'https://www.reddit.com/r/different/about/rules/' } });
  assert.equal((await runDueJobs())[0]?.status, 'failed'); assert.equal(posts, 0);
});
test('Product Hunt launch fields and publication packages preserve the approved immutable version', async () => {
  const invalid = generated('producthunt'); assert.throws(() => validateLaunchVariant(invalid.variants[0]!), /product launch kit/);
  assert.equal(productLaunchSchema.safeParse({ url: 'https://127.0.0.1/', name: 'Test', tagline: 'Test', description: 'Test', firstComment: 'Test' }).success, false);
  const launch = { url: 'https://product.example/', name: 'Owned product', tagline: 'Source-backed workflow', description: 'A product description.', firstComment: 'Our original maker comment.' };
  const value = generated('producthunt'); value.variants[0]!.launch = launch; value.variants[0]!.format = 'product_launch';
  const { id, ...input } = account('producthunt'); void id; const added = await addAccount(input); const draft = await createDraft(brief('producthunt'), value);
  const jobs = await publishDraft(draft.id, { accountIds: [added.id], expectedRevision: draft.revision }); assert.equal(jobs[0]?.status, 'awaiting_operator');
  await replaceDraft(draft.id, { ...value, variants: [{ ...value.variants[0]!, launch: { ...launch, description: 'Changed description.' } }] });
  const handoff = await publicationHandoff(jobs[0]!.id); assert.deepEqual(handoff.launch, launch); assert.equal(handoff.automatic, false);
});
test('only publication permalinks are accepted for the new platforms and HTML cannot execute source text', () => {
  assert.equal(extractPlatformId('producthunt', 'https://www.producthunt.com/posts/owned-product'), 'owned-product');
  assert.equal(extractPlatformId('producthunt', 'https://www.producthunt.com/products/owned-product?launch=owned-product-v2'), 'owned-product-v2');
  for (const path of ['owned-product', 'owned-product?launch=', 'owned-product?launch=draft', 'owned-product?launch=one&launch=two', 'owned-product/edit?launch=owned-product-v2']) assert.throws(() => extractPlatformId('producthunt', `https://www.producthunt.com/products/${path}`));
  for (const path of ['new', 'draft', 'owned-product/edit']) assert.throws(() => extractPlatformId('producthunt', `https://www.producthunt.com/posts/${path}`));
  assert.equal(extractPlatformId('zhihu', 'https://zhuanlan.zhihu.com/p/12345'), '12345');
  assert.equal(extractPlatformId('zhihu', 'https://www.zhihu.com/question/123/answer/456'), '456');
  assert.throws(() => extractPlatformId('zhihu', 'https://zhuanlan.zhihu.com/p/12345/edit'));
  assert.throws(() => extractPlatformId('zhihu', 'https://zhihu.com.attacker.example/p/12345'));
  const html = articlePackageHtml({ ...generated('zhihu').variants[0]!, title: '<script>title</script>', text: '<script>alert(1)</script>\n\nSecond paragraph' });
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('<p>Second paragraph</p>'));
});


test('checking an integration never re-enables a locally blocked account', async () => {
  process.env.POSTIZ_API_KEY = 'fixture-key';
  globalThis.fetch = async () => Response.json([{ id: 'reddit-integration', name: 'Test', identifier: 'reddit', disabled: false }]);
  const { id, ...input } = { ...account('reddit', 'postiz'), status: 'blocked' as const, reddit: target() }; void id;
  const added = await addAccount(input); const checked = await checkAccountConnection(added.id);
  assert.equal(checked.status, 'blocked'); assert.ok(checked.verifiedAt);
  assert.equal(publishingCapability('reddit', 'article', checked, { postizConfigured: true }).automatic, false);
});
