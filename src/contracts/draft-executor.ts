import { z } from 'zod';

export const draftExecutorPlatforms = ['weixin', 'zhihu', 'bilibili'] as const;
export const draftExecutorHelloSchema = z.object({ protocol: z.literal('content-studio-drafts'), version: z.literal(1), draftOnly: z.literal(true), platforms: z.tuple([z.literal('weixin'), z.literal('zhihu'), z.literal('bilibili')]), features: z.array(z.enum(['journal-reconciliation'])).optional() }).strict();
export const draftExecutionSchema = z.object({ protocolVersion: z.literal(1), jobId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), expectedUserId: z.string().min(1).max(200) }).strict();
export type DraftExecution = z.infer<typeof draftExecutionSchema>;
export const draftExecutorSaveSchema = z.object({
  platforms: z.tuple([z.enum(draftExecutorPlatforms)]), draftOnly: z.literal(true), execution: draftExecutionSchema,
  article: z.object({ title: z.string().trim().min(1).max(300), content: z.string().min(1).max(16 * 1024 * 1024), cover: z.string().max(8 * 1024 * 1024).optional() }).strict(),
}).strict();
export const draftExecutorReceiptSchema = z.object({ platform: z.enum(draftExecutorPlatforms), success: z.literal(true), draftOnly: z.literal(true), postId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), postUrl: z.url() }).strict();
export const draftJournalStatusSchema = z.object({ blocked: z.boolean(), invalid: z.boolean(), pending: z.array(z.uuid()).max(2000) }).strict();
export const draftJournalConfirmationSchema = z.object({ request: draftExecutorSaveSchema, receipt: draftExecutorReceiptSchema }).strict();
