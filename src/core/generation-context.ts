import { z } from 'zod';
import { dbRequest } from './database.ts';
import { draftSchema, type Draft } from './model.ts';
import { storageMode } from './store.ts';

type GenerationContext = { instruction: string; assetIds: string[]; model?: string; knowledgeRef?: string };
const runContextSchema = z.object({
  id: z.uuid(), draft_id: z.uuid().nullable(),
  task_snapshot: z.object({ prompt: z.string().max(12000), assetIds: z.array(z.uuid()).max(12), model: draftSchema.shape.generationModel }),
});

export async function resolveGenerationContext(draft: Draft): Promise<GenerationContext> {
  const stored = { instruction: draft.generationInstruction ?? '', assetIds: draft.generationAssetIds ?? [], ...(draft.generationModel ? { model: draft.generationModel } : {}), ...(draft.generationKnowledgeRef ? { knowledgeRef: draft.generationKnowledgeRef } : {}) };
  if (draft.generationInstruction !== undefined && draft.generationAssetIds !== undefined || storageMode() !== 'supabase') return stored;
  // Legacy snapshots stay immutable. Recover only from their exact completed run, never a similar task.
  const rows = z.array(runContextSchema).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${z.uuid().parse(process.env.STUDIO_WORKSPACE_ID)}&status=eq.succeeded&or=(draft_id.eq.${draft.id},id.eq.${draft.id})&select=id,draft_id,task_snapshot&order=created_at.asc&limit=2`));
  const matches = rows.filter(row => row.draft_id === draft.id || row.id === draft.id);
  const first = matches[0]?.task_snapshot;
  if (!first) return stored;
  if (matches.some(row => JSON.stringify(row.task_snapshot) !== JSON.stringify(first))) throw new Error('Conflicting completed runs reference this draft; verify its original generation context.');
  const knowledgeRef = draft.generationKnowledgeRef ?? (draft.brief.knowledgeIds?.length ? matches[0]?.id : undefined);
  return { instruction: draft.generationInstruction ?? first.prompt, assetIds: draft.generationAssetIds ?? first.assetIds, ...((draft.generationModel ?? first.model) ? { model: draft.generationModel ?? first.model } : {}), ...(knowledgeRef ? { knowledgeRef } : {}) };
}
