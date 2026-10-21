import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { accountSchema, draftSchema } from '../src/core/model.ts';
import { taskInputSchema, taskRunSchema, taskSchema } from '../src/core/task-model.ts';
import { accountIdentityHash, assertGeneratedRelease, assertTaskGrant, authorizeTask, publicationTimeFor, taskConfigHash } from '../src/core/task-automation.ts';
import { defaultBrandProfile } from '../src/contracts/brand.ts';
import { buildBrandPrompt } from '../src/core/content-prompts.ts';
import { taskFromQuestion } from '../src/core/task-selection.ts';

const stamp = '2026-10-17T01:00:00.000Z';
const account = accountSchema.parse({ id: randomUUID(), platform: 'zhihu', provider: 'native', integrationId: 'owner', label: 'Owner', status: 'connected', note: '', verifiedAt: stamp, physicalIdentity: { id: 'owner', verifiedAt: stamp, verification: 'browser' } });
const input = () => taskInputSchema.parse({ title: 'Software workflows', prompt: 'Explain immutable software workflows with sourced examples.', model: 'fixture-model', platforms: ['zhihu'], kind: 'content', topicOrigin: 'editorial', frequency: { type: 'daily', time: '09:00', timezone: 'Asia/Singapore' }, enabled: true, brand: defaultBrandProfile, delivery: { mode: 'automatic', authorized: true, accountIds: [account.id], publicationTime: '18:00', dayOffset: 0 } });
const task = () => { const config = input(); return taskSchema.parse({ ...config, id: randomUUID(), createdAt: stamp, updatedAt: stamp, nextRunAt: null, authorization: authorizeTask(config, [account]) }); };
const run = () => taskRunSchema.parse({ id: randomUUID(), taskId: randomUUID(), slot: `scheduled:${stamp}`, taskSnapshot: task(), status: 'succeeded', phase: 'completed', progress: 100, attempt: 1, error: null, warnings: [], questions: [], sources: [{ title: 'Reference', url: 'https://example.com/source', excerpt: 'Immutable software revisions.' }], master: { title: 'Software', body: 'https://example.com/source' }, variants: [{ platform: 'zhihu', format: 'article', title: 'Software', text: 'https://example.com/source', tags: [], mediaPaths: [] }], draftId: randomUUID(), outputPaths: null, startedAt: stamp, finishedAt: stamp, createdAt: stamp, updatedAt: stamp });

test('task grants bind complete operator input and survive harmless object key ordering', () => {
  const value = task(); const grant = value.authorization!;
  assert.equal(taskConfigHash({ ...input(), title: 'New subject' }) === grant.configHash, false);
  assert.equal(taskConfigHash({ ...input(), brand: { ...defaultBrandProfile, tone: 'Different voice' } }) === grant.configHash, false);
  assert.equal(taskConfigHash(Object.fromEntries(Object.entries(input()).reverse()) as ReturnType<typeof input>), grant.configHash);
  assert.deepEqual(authorizeTask(input(), [account], value), grant);
  assert.notEqual(authorizeTask({ ...input(), angle: 'Changed angle' }, [account], value)?.id, grant.id);
});
test('disabling a task removes its grant and historical tasks remain unprivileged', () => {
  assert.equal(authorizeTask({ ...input(), enabled: false }, [account]), undefined);
  assert.equal(taskSchema.parse({ ...task(), authorization: undefined }).authorization, undefined);
  assert.equal(authorizeTask({ ...input(), delivery: undefined }, [account]), undefined);
});
test('automatic release requires explicit authorization, real identity and a content task', () => {
  assert.throws(() => taskInputSchema.parse({ ...input(), delivery: { ...input().delivery, authorized: false } }));
  assert.throws(() => taskInputSchema.parse({ ...input(), kind: 'discovery' }));
  assert.throws(() => authorizeTask(input(), [{ ...account, integrationId: '', physicalIdentity: undefined }]), /identity/);
  assert.throws(() => authorizeTask(input(), [{ ...account, status: 'needs_login' }]), /connected/);
  assert.throws(() => taskInputSchema.parse({ ...input(), delivery: { ...input().delivery, accountIds: [account.id, account.id] } }));
});
test('revocation, grant replacement, brand/config changes and account identity changes stop queued publication', () => {
  const value = task(); const grant = value.authorization!;
  const authority = { taskId: value.id, runId: randomUUID(), authorizationId: grant.id, configHash: grant.configHash, deadlineAt: stamp };
  assert.doesNotThrow(() => assertTaskGrant(value, authority, account));
  assert.throws(() => assertTaskGrant({ ...value, enabled: false }, authority, account), /revoked/);
  assert.throws(() => assertTaskGrant({ ...value, authorization: { ...grant, id: randomUUID() } }, authority, account), /revoked/);
  assert.throws(() => assertTaskGrant({ ...value, prompt: 'Changed topic' }, authority, account), /revoked/);
  assert.throws(() => assertTaskGrant(value, authority, { ...account, physicalIdentity: { ...account.physicalIdentity!, id: 'someone-else' } }), /identity/);
  assert.equal(accountIdentityHash({ ...account, label: 'Renamed label' }), accountIdentityHash(account));
});
test('publication slots follow the production occurrence rather than completion or retry time', () => {
  const value = run();
  assert.equal(publicationTimeFor(value), '2026-10-17T10:00:00.000Z');
  value.taskSnapshot.delivery!.dayOffset = 1;
  assert.equal(publicationTimeFor(value), '2026-10-18T10:00:00.000Z');
  value.createdAt = '2026-10-21T12:00:00.000Z';
  assert.equal(publicationTimeFor(value), '2026-10-18T10:00:00.000Z');
});
test('timezone scheduling rejects DST gaps and repeated wall clocks', () => {
  const value = run(); value.taskSnapshot.frequency.timezone = 'America/New_York';
  value.slot = 'scheduled:2026-03-08T05:00:00.000Z'; value.taskSnapshot.delivery!.publicationTime = '02:30';
  assert.throws(() => publicationTimeFor(value), /missing or ambiguous/);
  value.slot = 'scheduled:2026-11-01T04:00:00.000Z'; value.taskSnapshot.delivery!.publicationTime = '01:30';
  assert.throws(() => publicationTimeFor(value), /missing or ambiguous/);
});
test('one-off publication time must be explicit and later than production', () => {
  const value = input(); value.frequency = { type: 'once', time: '09:00', timezone: 'Asia/Singapore', onceAt: stamp };
  assert.throws(() => taskInputSchema.parse(value));
  value.delivery!.onceAt = '2026-10-17T10:00:00.000Z';
  assert.doesNotThrow(() => taskInputSchema.parse(value));
  value.delivery!.onceAt = stamp;
  assert.throws(() => taskInputSchema.parse(value));
});
test('final generated-release checks reject edits, warnings and missing citations', () => {
  const value = run();
  const draft = draftSchema.parse({ id: value.draftId, title: value.master!.title, body: value.master!.body, variants: value.variants, revision: 1, approvedHash: null, createdAt: stamp, brief: { topic: 'Software', audience: 'Developers', angle: 'Immutable revisions', sources: value.sources, platforms: ['zhihu'] } });
  assert.doesNotThrow(() => assertGeneratedRelease(draft, value));
  assert.throws(() => assertGeneratedRelease({ ...draft, revision: 2 }, value), /changed/);
  assert.throws(() => assertGeneratedRelease(draft, { ...value, warnings: ['Source unavailable'] }), /warnings/);
  assert.throws(() => assertGeneratedRelease({ ...draft, variants: [{ ...draft.variants[0]!, text: 'No source link' }] }, value), /source-linked/);
});
test('brand profiles enter the shared generation prompt and survive discovery promotion', () => {
  assert.match(buildBrandPrompt(defaultBrandProfile), /subordinate to evidence|Cover instructions/);
  const value = task(); value.kind = 'discovery'; value.delivery = { ...value.delivery!, mode: 'draft', authorized: false }; delete value.authorization;
  const child = taskFromQuestion({ question: 'How do immutable revisions work?', audienceNeed: 'Safe software edits', angle: 'Explain snapshots', sourceUrls: ['https://example.com/source'], platforms: ['zhihu'], assessment: { status: 'allowed', reasons: ['Software topic'] } }, value, run().sources, 'Asia/Singapore');
  assert.deepEqual(child.brand, defaultBrandProfile); assert.equal(child.delivery && 'mode' in child.delivery ? child.delivery.mode : undefined, 'draft');
  assert.equal('authorization' in child, false);
});

test('explicit reviewed publication takes over only an unsent automatic job and preserves its audit trail', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createDraft, approveDraft, addAccount, preparePublication } = await import('../src/core/pipeline.ts');
  const { mutateState, readState } = await import('../src/core/store.ts');
  const directory = await mkdtemp(join(tmpdir(), 'studio-manual-takeover-')); const environment = { ...process.env };
  try {
    process.env.STUDIO_DATA_DIR = directory;
    for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID']) delete process.env[key];
    const value = run(); const target = await addAccount({ ...account });
    const draft = await createDraft({ topic: 'Software', audience: 'Developers', angle: 'Immutable revisions', sources: value.sources, platforms: ['zhihu'] }, { ...value.master!, variants: value.variants });
    await approveDraft(draft.id, 1);
    const authority = { taskId: randomUUID(), runId: value.id, authorizationId: randomUUID(), configHash: 'a'.repeat(64), deadlineAt: new Date(Date.now() + 60000).toISOString() };
    const job = await preparePublication({ draftId: draft.id, accountId: target.id, expectedRevision: 1, automatic: true, automation: authority, scheduledAt: new Date(Date.now() + 30000).toISOString() });
    const manual = await preparePublication({ draftId: draft.id, accountId: target.id, expectedRevision: 1, automatic: false });
    assert.equal(manual.id, job.id); assert.equal(manual.automation, undefined); assert.equal(manual.status, 'awaiting_operator');
    assert.ok(manual.history.some(entry => entry.message.includes(authority.authorizationId)));
    await mutateState(state => { const existing = state.jobs.find(item => item.id === job.id)!; existing.status = 'needs_reconciliation'; existing.automation = authority; });
    await assert.rejects(preparePublication({ draftId: draft.id, accountId: target.id, expectedRevision: 1, automatic: false }), /核对原任务/u);
    const unknown = (await readState()).jobs.find(item => item.id === job.id)!;
    assert.equal(unknown.status, 'needs_reconciliation'); assert.deepEqual(unknown.automation, authority);
  } finally { process.env = environment; await rm(directory, { recursive: true, force: true }); }
});
