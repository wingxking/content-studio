import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { emptyState, type Account, type Draft, type Job, type StudioState } from '../src/core/model.ts';
import { draftHash, preparePublication } from '../src/core/pipeline.ts';
import { deliveryPreflight, safeDeliveryError } from '../src/core/delivery-preflight.ts';
import { validatePostizVariant } from '../src/core/postiz.ts';
import { DeliveryInputError, deliveryIssue } from '../src/core/delivery-errors.ts';
import { validateDraftRoute } from '../src/core/remote-drafts.ts';
import { runDeliveryTick, runWorkerOnce } from '../src/server/worker.ts';

const environment = { ...process.env }; const originalFetch = globalThis.fetch;
const at = '2026-01-01T00:00:00.000Z';
let directory = '';
let row: { id: string; revision: number; state: StudioState };
const account = (label: string): Account => ({ id: randomUUID(), platform: 'linkedin', provider: 'postiz', integrationId: label, label, status: 'connected', note: '', verifiedAt: at });
function draft(text: string): Draft {
  return { id: randomUUID(), title: 'Fixture', body: text, brief: { topicOrigin: 'editorial', topic: 'Fixture', audience: 'Fixture', angle: 'Fixture', sources: [{ title: 'Fixture', url: 'https://example.com/', excerpt: 'Fixture evidence' }], platforms: ['linkedin'] }, variants: [{ platform: 'linkedin', title: 'Fixture', text, tags: [], mediaPaths: [] }], revision: 1, approvedHash: null, createdAt: at };
}
type RpcHandler = (name: string, body: Record<string, unknown>) => Response;
function databaseMock(rpc?: RpcHandler, provider?: (url: URL, init?: RequestInit) => Response) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === 'https://provider.invalid' && provider) return provider(url, init);
    assert.equal(url.origin, 'https://database.invalid', 'Unmocked network is forbidden');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname.endsWith('/content_studio_workspaces')) {
      if (init?.method === 'PATCH') row = { id: row.id, revision: Number(body.revision), state: body.state as StudioState };
      return Response.json([row]);
    }
    if (url.pathname.endsWith('/studio_commit_account_workspace')) {
      assert.equal(body.p_revision, row.revision); row = { ...row, revision: row.revision + 1, state: body.p_state as StudioState }; return Response.json([row]);
    }
    if (rpc) return rpc(url.pathname.split('/').at(-1)!, body);
    throw new Error(`Unexpected mocked request: ${url.pathname}`);
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'delivery-reliability-'));
  row = { id: randomUUID(), revision: 0, state: emptyState() };
  Object.assign(process.env, { STUDIO_DATA_DIR: directory, STUDIO_WORKSPACE_ID: row.id, SUPABASE_URL: 'https://database.invalid', SUPABASE_SECRET_KEY: 'fixture', POSTIZ_API_KEY: 'fixture', POSTIZ_BASE_URL: 'https://provider.invalid', STUDIO_WORKER_ROLE: 'delivery' });
  databaseMock();
});
afterEach(async () => { process.env = { ...environment }; globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); });

test('a blocked account waits while another publishes and the original accepted job is verified in the same worker tick', async () => {
  const first = account('A'); const second = account('B'); row.state.accounts = [first, second];
  const drafts = [draft('Already accepted'), draft('Next A post'), draft('Independent B post')];
  for (const item of drafts) item.approvedHash = await draftHash(item);
  row.state.drafts = drafts;
  const jobs: Job[] = [];
  for (const [index, item] of drafts.entries()) jobs.push(await preparePublication({ draftId: item.id, accountId: index < 2 ? first.id : second.id, expectedRevision: 1, automatic: true, scheduledAt: at }));
  const accepted = row.state.jobs[0]!;
  accepted.status = 'queued'; accepted.providerPostId = 'existing-A'; accepted.submissionStartedAt = at;
  accepted.verificationCheck = { nextAt: at, deadline: new Date(Date.now() + 60_000).toISOString(), attempt: 0, checkedAt: null, lastError: null, stoppedReason: null };
  let submissions = 0; let readbacks = 0; let acknowledged = false; let barrierReleased = false;
  databaseMock((name, body) => {
    if (name === 'studio_claim_role_work') return Response.json({ msgId: 1, token: randomUUID(), message: { type: 'legacy_publish', id: row.id, workspaceId: row.id } });
    if (name === 'studio_acquire_account_execution') return Response.json(body.p_job !== jobs[1]!.id);
    if (name === 'studio_release_account_execution') { if (body.p_resolved === true) barrierReleased = true; return Response.json(true); }
    if (name === 'studio_mark_account_dispatch') return Response.json(true);
    if (name === 'studio_ack_work') { acknowledged = true; return Response.json(true); }
    throw new Error(`Unexpected RPC: ${name}`);
  }, (url, init) => {
    if (url.pathname.endsWith('/integrations')) return Response.json([{ id: 'A', name: 'A', identifier: 'linkedin' }, { id: 'B', name: 'B', identifier: 'linkedin' }]);
    if (init?.method === 'POST') { submissions++; assert.match(String(init.body), /"id":"B"/); return Response.json([{ postId: 'accepted-B', integration: 'B' }]); }
    readbacks++; return Response.json({ posts: [{ id: 'existing-A', content: drafts[0]!.variants[0]!.text, publishDate: at, state: 'PUBLISHED', releaseURL: 'https://www.linkedin.com/feed/update/urn:li:activity:123456789/', integration: { id: 'A' } }] });
  });
  assert.equal(await runWorkerOnce(), true);
  assert.equal(submissions, 1); assert.equal(readbacks, 1); assert.equal(acknowledged, true); assert.equal(barrierReleased, true);
  assert.equal(row.state.jobs[0]!.status, 'published');
  assert.equal(row.state.jobs[1]!.status, 'scheduled'); assert.equal(row.state.jobs[1]!.attempts, 0);
  assert.equal(row.state.jobs[2]!.status, 'queued'); assert.equal(row.state.jobs[2]!.attempts, 1);
});

test('verification still runs after a dispatch failure, while cancellation stops further work', async () => {
  let verified = 0; const failure = new Error('Dispatch failed');
  const actions = { dispatch: async () => { throw failure; }, verify: async () => { verified++; return 1; } };
  await assert.rejects(runDeliveryTick(new AbortController().signal, actions), error => error === failure);
  assert.equal(verified, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runDeliveryTick(controller.signal, actions)); assert.equal(verified, 1);
});

test('preflight uses the same Postiz payload limits as execution and gives an actionable public issue', async () => {
  const target = account('LinkedIn'); row.state.accounts = [target];
  for (const value of [draft('x'.repeat(3001)), { ...draft('With image'), variants: [{ ...draft('With image').variants[0]!, mediaPaths: ['/private/not-read.png'] }] }]) {
    row.state.drafts = [value];
    let domainIssue; try { validatePostizVariant(target, value.variants[0]!); } catch (error) { domainIssue = deliveryIssue(error); }
    const result = await deliveryPreflight({ items: [{ subjectKind: 'article', articleId: value.id, accountId: target.id, expectedRevision: 1, action: 'publish' }] });
    assert.equal(result.items[0]!.eligible, false); assert.deepEqual(result.items[0]!.issues[0], domainIssue);
    assert.doesNotMatch(JSON.stringify(result), /\/private|not-read|Docker/u);
  }
  row.state.drafts = [draft('x'.repeat(3000))];
  const result = await deliveryPreflight({ items: [{ subjectKind: 'article', articleId: row.state.drafts[0]!.id, accountId: target.id, expectedRevision: 1, action: 'publish' }] });
  assert.equal(result.items[0]!.eligible, true);
});

test('draft route errors distinguish unsupported actions, permission, format and identity without exposing runtime exceptions', () => {
  const target: Account = { ...account('Native'), platform: 'zhihu', provider: 'native' };
  const variant = { ...draft('Fixture').variants[0]!, platform: 'zhihu' as const };
  const code = (run: () => void) => { try { run(); assert.fail('Expected validation failure'); } catch (error) { assert.ok(error instanceof DeliveryInputError); return error.code; } };
  assert.equal(code(() => validateDraftRoute({ ...target, platform: 'xiaohongshu' }, { ...variant, platform: 'xiaohongshu' })), 'UNSUPPORTED_ACTION');
  assert.equal(code(() => validateDraftRoute(target, variant)), 'AUTHORIZATION_REQUIRED');
  assert.equal(code(() => validateDraftRoute(target, { ...variant, platform: 'wechat' })), 'ACCOUNT_MISMATCH');
  assert.equal(code(() => validateDraftRoute({ ...target, draftConnection: { adapter: 'wechatsync', userId: 'fixture', extensionId: 'a'.repeat(32), checkedAt: at, permissionConfirmed: true } }, variant)), 'UNSUPPORTED_FORMAT');
  assert.doesNotMatch(safeDeliveryError(new Error('/private/token=secret')), /private|token|secret/u);
});

test('same-content commands cannot silently replace an existing or uncertain publication time', async () => {
  const target = account('A'); const value = draft('Scheduled'); value.approvedHash = await draftHash(value);
  row.state.accounts = [target]; row.state.drafts = [value];
  const input = { draftId: value.id, accountId: target.id, expectedRevision: 1, automatic: true, scheduledAt: '2099-01-01T10:00:00.000Z' };
  const first = await preparePublication(input); assert.equal((await preparePublication(input)).id, first.id);
  for (const status of ['scheduled', 'needs_reconciliation'] as const) {
    row.state.jobs[0]!.status = status;
    await assert.rejects(preparePublication({ ...input, scheduledAt: '2099-01-01T11:00:00.000Z' }), /排期/u);
    await assert.rejects(preparePublication({ ...input, scheduledAt: undefined }), /排期/u);
    assert.equal(row.state.jobs.length, 1); assert.equal(row.state.jobs[0]!.scheduledAt, input.scheduledAt);
  }
});

test('same-content manual and system delivery cannot silently reuse each other in preparation or preflight', async () => {
  const target = account('A'); const value = draft('Reviewed delivery mode'); value.approvedHash = await draftHash(value);
  row.state.accounts = [target]; row.state.drafts = [value];
  const input = { draftId: value.id, accountId: target.id, expectedRevision: 1 };
  for (const initialAutomatic of [false, true]) {
    row.state.jobs = [];
    const previous = await preparePublication({ ...input, automatic: initialAutomatic });
    assert.equal((await preparePublication({ ...input, automatic: initialAutomatic })).id, previous.id);
    const before = structuredClone(row.state.jobs);
    await assert.rejects(preparePublication({ ...input, automatic: !initialAutomatic }), error => error instanceof DeliveryInputError && error.code === 'INPUT_INVALID');
    const preflight = await deliveryPreflight({ items: [{ subjectKind: 'article', articleId: value.id, accountId: target.id, expectedRevision: 1, action: initialAutomatic ? 'manual_handoff' : 'publish' }] });
    assert.equal(preflight.items[0]!.eligible, false);
    assert.match(preflight.items[0]!.issues[0]!.nextAction, /原交付/u);
    assert.deepEqual(row.state.jobs, before);
  }
  for (const status of ['submitting', 'needs_reconciliation'] as const) {
    row.state.jobs[0]!.status = status;
    const before = structuredClone(row.state.jobs);
    for (const automatic of [false, true]) await assert.rejects(preparePublication({ ...input, automatic }), /核对原任务/u);
    for (const action of ['manual_handoff', 'publish'] as const) assert.equal((await deliveryPreflight({ items: [{ subjectKind: 'article', articleId: value.id, accountId: target.id, expectedRevision: 1, action }] })).items[0]!.eligible, false);
    assert.deepEqual(row.state.jobs, before);
  }
  row.state.jobs[0]!.status = 'queued';
  await assert.rejects(preparePublication({ ...input, automatic: false }), /系统提交任务/u);
  assert.equal((await preparePublication({ ...input, automatic: true })).id, row.state.jobs[0]!.id);
});
