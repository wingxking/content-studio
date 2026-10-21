import { z } from 'zod';
// Existing pure content schemas are shared during the incremental boundary migration.
import { accountSchema, draftSchema, jobSchema, platformSchema } from '../core/model.ts';
import { taskSchema, taskRunSchema } from '../core/task-model.ts';

export const workspaceSummarySchema = z.object({
  paused: z.boolean(), schedulerEnabled: z.boolean(), accounts: z.array(accountSchema), readiness: z.record(z.string(), z.unknown()),
});
export const contentItemSchema = z.object({
  id: z.uuid(), kind: z.enum(['article', 'video']), title: z.string(), revision: z.number().int().positive(),
  platforms: z.array(platformSchema), createdAt: z.string(), updatedAt: z.string(), status: z.string(),
  taskId: z.uuid().nullable(), runId: z.uuid().nullable(),
});
export const contentPageSchema = z.object({ items: z.array(contentItemSchema), nextCursor: z.string().nullable() });
export const taskPageSchema = z.object({ items: z.array(taskSchema), nextCursor: z.string().nullable() });
export const runPageSchema = z.object({ items: z.array(taskRunSchema), nextCursor: z.string().nullable() });
export const articleDetailSchema = z.object({ draft: draftSchema, jobs: z.array(jobSchema) });
export const deliveryBatchSchema = z.object({ batchId: z.uuid(), items: z.array(z.object({
  articleId: z.uuid(), accountId: z.uuid(), status: z.enum(['accepted', 'blocked', 'failed']), jobId: z.uuid().nullable(), error: z.string().nullable(),
})) });
export type ContentItem = z.infer<typeof contentItemSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
