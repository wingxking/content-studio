import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dbRequest, dbRpc } from './database.ts';
import { draftSchema, generatedSchema, type Draft, type Generated } from './model.ts';
import { mutateState, storageMode } from './store.ts';
import { writeDraftArtifacts } from './artifacts.ts';

export type ArticleCommit = {
  expectedRevision: number;
  commandId?: string;
  proposalId?: string;
  proposalContent?: Generated;
  productionLease?: { runId: string; token: string };
};

export async function committedArticle(commandId: string | undefined, id: string, expectedRevision: number, content: unknown): Promise<Draft | null> {
  if (!commandId || storageMode() !== 'supabase') return null;
  const workspace = z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
  const receipts = z.array(z.object({ draft_id: z.uuid(), revision: z.number().int() })).parse(await dbRequest(`studio_article_commands?workspace_id=eq.${workspace}&command_id=eq.${z.uuid().parse(commandId)}&select=draft_id,revision&limit=1`));
  const receipt = receipts[0]; if (!receipt) return null;
  if (receipt.draft_id !== id || receipt.revision !== expectedRevision + 1) throw new Error('Command ID already used for a different article save.');
  const rows = z.array(z.object({ content: draftSchema })).parse(await dbRequest(`studio_revisions?workspace_id=eq.${workspace}&draft_id=eq.${id}&revision=eq.${receipt.revision}&select=content&limit=1`));
  const saved = rows[0]?.content; if (!saved) throw new Error('Committed article revision is unavailable.');
  const proposed = generatedSchema.parse(content);
  proposed.document ??= proposed.body === saved.body ? saved.document : undefined;
  if (JSON.stringify(generatedSchema.parse(saved)) !== JSON.stringify(proposed)) throw new Error('Command ID already used for different article content.');
  return saved;
}

/** The database commits content, history and follow-up work together. Exports are projections. */
export async function commitArticle(draft: Draft, input: ArticleCommit): Promise<Draft> {
  const commandId = z.uuid().parse(input.commandId ?? randomUUID());
  if (storageMode() === 'supabase') {
    if (input.productionLease) return draftSchema.parse(await dbRpc('studio_commit_researched_article', { p_workspace: z.uuid().parse(process.env.STUDIO_WORKSPACE_ID), p_run: z.uuid().parse(input.productionLease.runId), p_token: z.uuid().parse(input.productionLease.token), p_content: draftSchema.parse(draft) }));
    if (input.proposalId) return draftSchema.parse(await dbRpc('studio_apply_proposal', {
      p_workspace: z.uuid().parse(process.env.STUDIO_WORKSPACE_ID), p_operation: input.proposalId,
      p_draft: draft.id, p_expected_revision: input.expectedRevision, p_content: generatedSchema.parse(input.proposalContent ?? draft),
    }));
    return draftSchema.parse(await dbRpc('studio_commit_article', {
      p_workspace: z.uuid().parse(process.env.STUDIO_WORKSPACE_ID),
      p_command: commandId,
      p_expected_revision: input.expectedRevision,
      p_content: draftSchema.parse(draft),
    }));
  }
  // Legacy local storage remains a recovery/test adapter, not the deployed runtime.
  let previous: Draft | undefined;
  const saved = await mutateState(state => {
    const index = state.drafts.findIndex(item => item.id === draft.id);
    previous = index < 0 ? undefined : structuredClone(state.drafts[index]);
    if (previous && input.expectedRevision === 0) return previous;
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new Error('Draft revision changed. Refresh and review before saving.');
    if (state.jobs.some(job => job.draftId === draft.id && job.status === 'submitting')) throw new Error('This draft has an active provider submission. Reconcile its outcome before editing.');
    if (index < 0) state.drafts.push(draft); else state.drafts[index] = draft;
    return draft;
  });
  // A projection failure must not turn an already committed save into a failed command.
  try { if (previous) await writeDraftArtifacts(previous); await writeDraftArtifacts(saved); }
  catch { /* The explicit export repair command can reconstruct the committed database revision. */ }
  return saved;
}
