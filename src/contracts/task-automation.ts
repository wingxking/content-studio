import { z } from 'zod';

export const legacyTaskDeliverySchema = z.object({
  mode: z.enum(['draft', 'automatic', 'manual']),
  accountIds: z.array(z.uuid()).min(1).max(20).refine(ids => new Set(ids).size === ids.length, 'Select each account once.'),
  publicationTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  dayOffset: z.number().int().min(0).max(7).default(0),
  onceAt: z.iso.datetime({ offset: true }).optional(),
  authorized: z.boolean().default(false),
}).strict();
export const taskDeliveryV2Schema = z.object({
  version: z.literal(2),
  targets: z.array(z.object({ accountId: z.uuid(), mode: z.enum(['review', 'draft', 'automatic']) }).strict()).max(20)
    .refine(targets => new Set(targets.map(target => target.accountId)).size === targets.length, 'Select each account once.'),
  publicationTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).default('18:00'),
  dayOffset: z.number().int().min(0).max(7).default(0),
  onceAt: z.iso.datetime({ offset: true }).optional(), authorized: z.boolean().default(false),
}).strict();
export const taskDeliverySchema = z.union([legacyTaskDeliverySchema, taskDeliveryV2Schema]);
export type TaskDelivery = z.infer<typeof taskDeliverySchema>;
export function taskDeliveryTargets(delivery?: TaskDelivery): z.infer<typeof taskDeliveryV2Schema>['targets'] {
  if (!delivery) return [];
  return 'version' in delivery ? delivery.targets : delivery.accountIds.map(accountId => ({ accountId, mode: delivery.mode === 'manual' ? 'review' : delivery.mode }));
}
export function hasAutomaticDelivery(delivery?: TaskDelivery): boolean { return taskDeliveryTargets(delivery).some(target => target.mode === 'automatic'); }
export const taskAuthorizationSchema = z.object({
  id: z.uuid(), configHash: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: z.iso.datetime(),
  accounts: z.array(z.object({ id: z.uuid(), identityHash: z.string().regex(/^[a-f0-9]{64}$/u) })).max(20),
}).strict();
export const jobAutomationSchema = z.object({
  taskId: z.uuid(), runId: z.uuid(), authorizationId: z.uuid(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/u), deadlineAt: z.iso.datetime(),
}).strict();
export type JobAutomation = z.infer<typeof jobAutomationSchema>;
