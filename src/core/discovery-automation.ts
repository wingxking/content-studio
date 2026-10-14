import { z } from 'zod';
import { dbRequest, dbRpc } from './database.ts';
import { type TaskRun } from './task-model.ts';
import { taskFromQuestion } from './task-selection.ts';

export const discoveryPromotionSchema = z.object({
  id: z.uuid(), workspaceId: z.uuid(), parentRunId: z.uuid(), candidateHash: z.string().regex(/^[a-f0-9]{32}$/u),
  candidateIndex: z.number().int().min(0).max(19), childTaskId: z.uuid(), childRunId: z.uuid(), createdAt: z.iso.datetime(),
});
export type DiscoveryPromotion = z.infer<typeof discoveryPromotionSchema>;

function promotionFromRow(input: unknown): DiscoveryPromotion {
  const row = z.record(z.string(), z.unknown()).parse(input);
  return discoveryPromotionSchema.parse({ id: row.id, workspaceId: row.workspace_id, parentRunId: row.parent_run_id,
    candidateHash: row.candidate_hash, candidateIndex: row.candidate_index, childTaskId: row.child_task_id,
    childRunId: row.child_run_id, createdAt: new Date(z.string().parse(row.created_at)).toISOString() });
}

export async function listDiscoveryPromotions(workspaceId: string, parentRunId?: string): Promise<DiscoveryPromotion[]> {
  const workspace = z.uuid().parse(workspaceId);
  const filter = parentRunId ? `&parent_run_id=eq.${z.uuid().parse(parentRunId)}` : '';
  return z.array(z.unknown()).parse(await dbRequest(`studio_discovery_promotions?workspace_id=eq.${workspace}${filter}&order=created_at.desc&limit=500`)).map(promotionFromRow);
}

// Success is persisted before promotion. Redelivering the parent repairs a crash at this boundary.
// Each RPC commits the relation, frozen child/run and pgmq message together.
export async function repairDiscoveryPromotions(run: TaskRun, workspaceId: string): Promise<DiscoveryPromotion[]> {
  if (run.status !== 'succeeded' || run.taskSnapshot.kind !== 'discovery' || !run.taskSnapshot.discoveryAutomation.enabled) return [];
  const workspace = z.uuid().parse(workspaceId); const promotions: DiscoveryPromotion[] = [];
  for (const [index, question] of run.questions.slice(0, run.taskSnapshot.discoveryAutomation.maxDrafts).entries()) {
    const input = taskFromQuestion(question, run.taskSnapshot, run.sources, run.taskSnapshot.frequency.timezone);
    promotions.push(promotionFromRow(await dbRpc('studio_promote_discovery_candidate', {
      p_workspace: workspace, p_parent_run: run.id, p_candidate_index: index, p_config: input,
    })));
  }
  return promotions;
}
