// Explicit isolated database acceptance; never included in the unit-test glob.
// Requires migration 024 and the matching application image. No worker/model/platform is run.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

if (!process.argv.includes('--confirm-isolated-database')) throw new Error('Provide --confirm-isolated-database for this temporary local database fixture.');
const { loadRuntimeEnvironment } = await import('../src/core/runtime-env.ts');
const { dbRequest, dbRpc, isTrustedDatabaseOrigin } = await import('../src/core/database.ts');
await loadRuntimeEnvironment();
if (process.env.STUDIO_CONTAINER !== 'true' || !process.env.SUPABASE_SECRET_KEY) throw new Error('Run inside a one-off Docker application process with private local database configuration.');
const database = new URL(process.env.SUPABASE_URL ?? 'invalid:');
const kubernetesDatabase = process.env.STUDIO_ORCHESTRATOR === 'kubernetes' && database.hostname === 'host.orb.internal';
if (database.protocol !== 'http:' || !isTrustedDatabaseOrigin(database) || !['kong', 'localhost', '127.0.0.1'].includes(database.hostname) && !kubernetesDatabase) throw new Error('Only explicitly trusted local Supabase is permitted.');
const configuredWorkspace = z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
const workspaceId = randomUUID(); assert.notEqual(workspaceId, configuredWorkspace);
const environment = { ...process.env }; const directory = await mkdtemp(join(tmpdir(), 'article-proposal-database-'));
process.env.STUDIO_WORKSPACE_ID = workspaceId; process.env.STUDIO_DATA_DIR = directory; process.env.STUDIO_LOCALFS_DIR = join(directory, 'localfs');
delete process.env.STUDIO_MODEL_EXECUTOR_URL; delete process.env.STUDIO_KNOWLEDGE_IMPORT_DIR;
const { emptyState } = await import('../src/core/model.ts');
const { createDraft } = await import('../src/core/pipeline.ts');
const { applyOperation, getOperation, listOperations } = await import('../src/core/editor.ts');
const { articleEditor, publicArticleOperation } = await import('../src/application/workspace.ts');
const { readState } = await import('../src/core/store.ts');
const articleId = randomUUID(); const proposalId = randomUUID(); const checkpointId = randomUUID();
const selectedModel = 'isolated-proposal-selected-model';
let created = false;
try {
  await dbRequest('content_studio_workspaces', { method: 'POST', body: { id: workspaceId, state: { ...emptyState(), paused: true } } }); created = true;
  const variant = { platform: 'reddit' as const, title: 'Original software fixture', text: 'Review the original software workflow.', tags: [], mediaPaths: [`/private/isolated-${workspaceId}/original.png`] };
  const draft = await createDraft({ topic: 'Software workflow fixture', audience: 'Isolated acceptance operator', angle: 'Reviewable software steps', sources: [{ title: 'Explicit fixture evidence', url: 'https://example.org/manual', excerpt: 'Synthetic software evidence used only for database acceptance.' }], platforms: ['reddit'] }, { title: variant.title, body: 'Original software workflow.', variants: [variant] }, articleId, 'isolated-original-model', { instruction: 'Use the supplied synthetic fixture evidence.', assetIds: [] });
  assert.equal(draft.document, undefined);
  const proposal = { title: draft.title, body: 'Reviewed master proposal with practical software steps.', variants: draft.variants };
  const frozenProposal = JSON.stringify(proposal);
  await dbRequest('studio_operations', { method: 'POST', body: { id: proposalId, workspace_id: workspaceId, draft_id: articleId, kind: 'refine', status: 'succeeded', input: { expectedRevision: 1, model: selectedModel }, output: { proposal, applied: false } } });
  await dbRequest('studio_operations', { method: 'POST', body: { id: checkpointId, workspace_id: workspaceId, draft_id: articleId, kind: 'sync', status: 'failed', input: { expectedRevision: 1 }, output: { proposal, baselines: [variant], conflicts: ['reddit.text'], applying: true, privatePath: `/private/isolated-${workspaceId}/checkpoint.json` } } });
  const checkpoint = publicArticleOperation(await getOperation(checkpointId), draft);
  const checkpointText = JSON.stringify(checkpoint);
  assert.doesNotMatch(checkpointText, /baselines|privatePath|\/private\//u); assert.match(checkpointText, /reddit\.text/u);
  const editor = await articleEditor(articleId); assert.doesNotMatch(JSON.stringify(editor), /baselines|privatePath|\/private\//u);
  const applied = await applyOperation(proposalId, 1);
  assert.equal(applied.revision, 2); assert.equal(applied.body, proposal.body); assert.equal(applied.document, undefined); assert.equal(applied.generationModel, selectedModel); assert.equal(applied.adaptationStatus, 'pending');
  await assert.rejects(dbRpc('studio_commit_article', { p_workspace: workspaceId, p_command: randomUUID(), p_expected_revision: 1, p_content: { ...applied, title: 'Stale CAS fixture' } }), /Content revision or execution ownership changed/u);
  assert.deepEqual(z.object({ proposal: z.unknown() }).parse((await getOperation(proposalId)).output).proposal, JSON.parse(frozenProposal));
  const before = await listOperations(articleId); const sync = before.filter(operation => operation.kind === 'sync' && operation.input.expectedRevision === 2);
  assert.equal(sync.length, 1); assert.equal(sync[0]?.input.model, selectedModel); assert.equal(sync[0]?.input.generationInstruction, draft.generationInstruction);
  const history = () => dbRequest(`studio_revisions?workspace_id=eq.${workspaceId}&draft_id=eq.${articleId}&select=revision&order=revision.asc`);
  assert.deepEqual(await history(), [{ revision: 1 }, { revision: 2 }]);
  const repeated = await applyOperation(proposalId, 1); assert.equal(repeated.revision, 2);
  assert.deepEqual((await listOperations(articleId)).map(operation => operation.id).sort(), before.map(operation => operation.id).sort());
  assert.deepEqual(await history(), [{ revision: 1 }, { revision: 2 }]);
  const state = await readState(); assert.equal(state.drafts.length, 1); assert.equal(state.drafts[0]?.revision, 2); assert.equal(state.accounts.length, 0); assert.equal(state.jobs.length, 0); assert.equal(state.paused, true);
  assert.deepEqual(await readdir(directory), []);
  console.log(JSON.stringify({ workspaceId, isolated: true, realSupabase: true, frozenLegacyProposal: true, checkpointProjectionSafe: true, selectedModelInherited: true, uniqueSyncFollowup: true, replayRevisionUnchanged: true, workersExecuted: 0, modelsExecuted: 0, platformSubmissions: 0 }));
} finally {
  const failures: string[] = [];
  if (created) {
    try {
      for (let index = 0; index < 30; index++) {
        const claim = z.object({ msgId: z.number(), token: z.uuid() }).nullable().parse(await dbRpc('studio_claim_role_work', { p_workspace: workspaceId, p_role: 'all' }));
        if (!claim) break;
        assert.equal(await dbRpc('studio_ack_work', { p_workspace: workspaceId, p_msg: claim.msgId, p_token: claim.token }), true);
      }
    } catch { failures.push('fixture_queue'); }
    for (const table of ['studio_operations', 'studio_revisions', 'studio_editor_state', 'studio_article_commands', 'studio_queue_leases', 'content_studio_workspaces']) {
      const path = `${table}?${table === 'content_studio_workspaces' ? 'id' : 'workspace_id'}=eq.${workspaceId}`;
      try { await dbRequest(path, { method: 'DELETE' }); assert.deepEqual(await dbRequest(path), []); } catch { failures.push(table); }
    }
  }
  await rm(directory, { recursive: true, force: true }); process.env = environment;
  if (failures.length) { console.error(JSON.stringify({ fixtureCleanupFailed: failures, workspaceId })); process.exitCode = 1; }
}
