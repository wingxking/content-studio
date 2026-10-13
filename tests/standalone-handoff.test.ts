import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { emptyState, jobSchema, type Account } from '../src/core/model.ts';
import { publicationHandoff } from '../src/core/delivery.ts';
import { expectedYouTubeChannelId } from '../src/core/youtube.ts';

const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
let directory = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-standalone-handoff-'));
  process.env.STUDIO_DATA_DIR = directory;
  process.env.STUDIO_CONTAINER = 'false';
  process.env.SUPABASE_URL = 'https://database.invalid';
  process.env.SUPABASE_SECRET_KEY = 'isolated-test-key';
  process.env.STUDIO_WORKSPACE_ID = randomUUID();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnvironment };
  await rm(directory, { recursive: true, force: true });
});

for (const scenario of [
  { name: 'matching requested upload', operation: 'matching', connected: true, automatic: true },
  { name: 'manual video handoff', operation: 'none', connected: true, automatic: false },
  { name: 'another video delivery operation', operation: 'other', connected: true, automatic: false },
  { name: 'blocked account', operation: 'matching', connected: false, automatic: false },
] as const) {
  test(`standalone YouTube handoff reports ${scenario.name} accurately`, async () => {
    const timestamp = new Date().toISOString();
    const videoId = randomUUID();
    const account: Account = { id: randomUUID(), platform: 'youtube', label: 'Test channel', provider: 'native', integrationId: expectedYouTubeChannelId, status: scenario.connected ? 'connected' : 'blocked', note: 'Isolated fixture.', verifiedAt: timestamp };
    const job = jobSchema.parse({ id: randomUUID(), draftId: null, subject: { kind: 'video', id: videoId, revision: 1 }, platform: 'youtube', accountId: account.id, approvedHash: 'a'.repeat(64), snapshot: { account, variant: { platform: 'youtube', title: 'Reviewed video', text: 'Reviewed description.', tags: [], mediaPaths: [], format: 'video' }, video: { projectId: videoId, revision: 1, renderId: randomUUID(), renderHash: 'b'.repeat(64), approvalHash: 'a'.repeat(64), sources: [] } }, status: 'failed', scheduledAt: timestamp, createdAt: timestamp, provider: 'native', remoteId: null, remoteUrl: null, attempts: 0, error: 'Publishing paused before submission.', history: [] });
    const state = { ...emptyState(), accounts: [account], jobs: [job] };
    let operationQueries = 0;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://database.invalid');
      if (url.pathname === '/rest/v1/content_studio_workspaces') return Response.json([{ id: process.env.STUDIO_WORKSPACE_ID, state, revision: 1 }]);
      assert.equal(url.pathname, '/rest/v1/studio_operations');
      assert.equal(url.searchParams.get('subject_kind'), 'eq.video');
      assert.equal(url.searchParams.get('subject_id'), `eq.${videoId}`);
      assert.equal(url.searchParams.has('draft_id'), false);
      operationQueries++;
      return Response.json(scenario.operation === 'none' ? [] : [{ id: randomUUID(), draft_id: null, subject_kind: 'video', subject_id: videoId, kind: 'publish', status: 'failed', phase: 'failed', input: { jobId: scenario.operation === 'matching' ? job.id : randomUUID() }, output: null, error: 'Publishing paused.', created_at: timestamp, updated_at: timestamp }]);
    };
    const handoff = await publicationHandoff(job.id);
    assert.equal(handoff.automatic, scenario.automatic);
    assert.equal(handoff.requiresReconciliation, false);
    assert.equal(handoff.capability.route, 'youtube_api');
    assert.equal(operationQueries, scenario.connected ? 1 : 0);
  });
}
