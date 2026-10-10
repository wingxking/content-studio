import { z } from 'zod';
import { platformSchema, sourceSchema, variantSchema } from './model.ts';

export const taskSourceSchema = z.object({
  title: z.string().max(300).default(''),
  url: z.union([z.literal(''), z.url().refine(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Use an HTTP(S) source URL without credentials')]).default(''),
  excerpt: z.string().max(12000).default(''),
});
export const taskFrequencySchema = z.object({
  type: z.enum(['once', 'daily', 'weekly']),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Use HH:mm'),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
  }, 'Use a valid IANA timezone'),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  onceAt: z.iso.datetime({ offset: true }).optional(),
}).superRefine((value, context) => {
  if (value.type === 'weekly' && !value.weekdays?.length) context.addIssue({ code: 'custom', path: ['weekdays'], message: 'Choose at least one weekday.' });
});
export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(3).max(12000),
  audience: z.string().trim().max(1000).default(''),
  angle: z.string().trim().max(4000).default(''),
  model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u),
  platforms: z.array(platformSchema).min(1).max(12).refine(values => new Set(values).size === values.length, 'Platforms must be unique'),
  sources: z.array(taskSourceSchema).max(20).default([]),
  assetIds: z.array(z.uuid()).max(12).default([]),
  kind: z.enum(['content', 'discovery']),
  topicOrigin: z.enum(['editorial', 'trend']).default('trend'),
  frequency: taskFrequencySchema,
  enabled: z.boolean(),
});
export const taskSchema = taskInputSchema.extend({
  id: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), nextRunAt: z.iso.datetime().nullable(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;
export type Task = z.infer<typeof taskSchema>;
export const assessmentSchema = z.object({ status: z.enum(['allowed', 'excluded', 'uncertain']), reasons: z.array(z.string().min(1).max(500)).min(1).max(20) });
export const hotQuestionSchema = z.object({
  question: z.string().min(3).max(1000), audienceNeed: z.string().min(1).max(2000), angle: z.string().min(1).max(4000),
  sourceUrls: z.array(z.url()).min(1).max(20), platforms: z.array(platformSchema).min(1).max(12),
  assessment: z.object({ status: z.literal('allowed'), reasons: z.array(z.string().min(1)).min(1).max(20) }),
});
export type HotQuestion = z.infer<typeof hotQuestionSchema>;
export const masterSchema = z.object({ title: z.string().min(1).max(300), body: z.string().min(1).max(80000) });
export type MasterContent = z.infer<typeof masterSchema>;
export const outputPathsSchema = z.object({ master: z.string(), package: z.string(), platforms: z.record(z.string(), z.string()) });
export const taskRunStatuses = ['queued', 'researching', 'generating', 'succeeded', 'failed', 'cancelled'] as const;
export const taskRunSchema = z.object({
  id: z.uuid(), taskId: z.uuid(), slot: z.string(), taskSnapshot: taskSchema,
  status: z.enum(taskRunStatuses), phase: z.string(), progress: z.number().min(0).max(100), attempt: z.number().int().nonnegative(),
  error: z.string().nullable(), warnings: z.array(z.string()).default([]), questions: z.array(hotQuestionSchema).max(20), sources: z.array(sourceSchema).max(20),
  master: masterSchema.nullable(), variants: z.array(variantSchema).max(12), draftId: z.uuid().nullable(), outputPaths: outputPathsSchema.nullable(),
  startedAt: z.iso.datetime().nullable(), finishedAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type TaskRun = z.infer<typeof taskRunSchema>;
