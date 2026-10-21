import { z } from "zod";
import { taskSchema } from "../core/task-model.ts";
import { contentItemSchema } from "./workspace.ts";
import { publicSourceUrl } from "./research.ts";

export const taskRefSchema = z
  .object({ kind: z.enum(["plan", "video", "article"]), id: z.uuid() })
  .strict();
export type TaskRef = z.infer<typeof taskRefSchema>;
export const taskIndexItemSchema = taskRefSchema.extend({
  category: z.string(),
  title: z.string(),
  createdAt: z.string(),
  status: z.string(),
  nextRunAt: z.string().nullable(),
  episodeCount: z.number(),
  tags: z.array(z.string()),
  archivedAt: z.string().nullable(),
});
export const taskIndexSchema = z.object({
  items: z.array(taskIndexItemSchema),
  nextCursor: z.string().nullable(),
});
export const episodeSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
  draftId: z.uuid().nullable(),
});
export const taskContextSchema = z.object({
  ref: taskRefSchema,
  title: z.string(),
  status: z.string(),
  plan: taskSchema.nullable(),
  episodes: z.array(episodeSchema),
  nextCursor: z.string().nullable(),
  selectedEpisodeId: z.uuid().nullable(),
  tags: z.array(z.string()),
  archivedAt: z.string().nullable(),
  related: z
    .array(
      z.object({
        childTaskId: z.uuid(),
        parentRunId: z.uuid(),
        questionIndex: z.number().int().nullable(),
        relation: z.string(),
      }),
    )
    .default([]),
});
export type TaskContext = z.infer<typeof taskContextSchema>;
export const contextContentSchema = z.object({
  items: z.array(contentItemSchema),
  nextCursor: z.string().nullable(),
});
export const captureInputSchema = z
  .object({
    commandId: z.uuid(),
    title: z.string().trim().min(1).max(300),
    url: publicSourceUrl,
    excerpt: z.string().trim().max(12000),
    task: taskRefSchema.optional(),
    episodeId: z.uuid().optional(),
  })
  .strict();
export const captureSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  url: z.string(),
  excerpt: z.string(),
  created_at: z.string(),
});
export const resourceSchema = z.object({
  id: z.uuid(),
  task_kind: taskRefSchema.shape.kind,
  task_id: z.uuid(),
  episode_id: z.uuid().nullable(),
  resource_kind: z.enum(["capture", "asset", "knowledge"]),
  resource_id: z.uuid(),
  created_at: z.string(),
});
export const resourcesSchema = z.object({
  links: z.array(resourceSchema),
  captures: z.array(captureSchema),
  resources: z.array(z.object({ id: z.uuid(), kind: z.enum(["capture", "asset", "knowledge"]), name: z.string(), mime: z.string().optional(), url: z.string().optional() })).default([]),
});
export const librarySchema = z.object({
  entries: z.array(captureSchema),
  links: z.array(resourceSchema),
  nextCursor: z.string().nullable(),
});
export const deliveryListItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  subjectKind: z.enum(["article", "video"]),
  subjectId: z.uuid(),
  revision: z.number().int().positive(),
  accountId: z.uuid(),
  platform: z.string(),
  status: z.string(),
  draftOnly: z.boolean(),
  scheduledAt: z.string(),
  createdAt: z.string(),
  remoteUrl: z.string().nullable(),
  ref: taskRefSchema,
  episodeId: z.uuid().nullable(),
});
export const deliveryPageSchema = z.object({
  items: z.array(deliveryListItemSchema),
  nextCursor: z.string().nullable(),
});
export const activitySchema = z.object({
  events: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      status: z.string(),
      at: z.string(),
      detail: z.string().nullable(),
    }),
  ),
});

export const deliveryIntentSchema = z
  .object({
    subjectKind: z.enum(["article", "video"]).default("article"),
    articleId: z.uuid().optional(),
    videoId: z.uuid().optional(),
    targetId: z.uuid().optional(),
    expectedTargetRevision: z.number().int().positive().optional(),
    expectedRevision: z.number().int().positive(),
    accountId: z.uuid(),
    action: z.enum(["save_draft", "publish", "manual_handoff"]),
    scheduledAt: z.iso.datetime().optional(),
    timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "请选择有效时区").optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (Boolean(item.scheduledAt) !== Boolean(item.timezone)) ctx.addIssue({ code: "custom", message: "排期需要同时提供时间和时区。" });
    if (item.scheduledAt && (item.subjectKind !== "article" || item.action === "save_draft")) ctx.addIssue({ code: "custom", message: "目前指定时间仅支持文章公开交付和人工待办。" });
    if (
      item.subjectKind === "article"
        ? !item.articleId || Boolean(item.videoId || item.targetId)
        : !item.videoId ||
          !item.targetId ||
          !item.expectedTargetRevision ||
          Boolean(item.articleId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Select one article revision or one video target revision.",
      });
  });
export type DeliveryIntent = z.infer<typeof deliveryIntentSchema>;
export const preflightItemSchema = z.object({
  intent: deliveryIntentSchema,
  eligible: z.boolean(),
  fingerprint: z.string(),
  reasons: z.array(z.string()),
  issues: z.array(z.object({ code: z.string(), message: z.string(), nextAction: z.string() })).default([]),
  nextAction: z.string(),
});
export const preflightSchema = z.object({
  checkedAt: z.string(),
  items: z.array(preflightItemSchema),
});
export const batchInputSchema = z
  .object({
    commandId: z.uuid(),
    items: z
      .array(
        deliveryIntentSchema.safeExtend({
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        }),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const batchItemSchema = z.object({
  id: z.uuid(),
  input: deliveryIntentSchema.safeExtend({ fingerprint: z.string() }),
  status: z.enum(["pending", "accepted", "blocked", "failed"]),
  jobId: z.uuid().nullable(),
  error: z.string().nullable(),
  deliveryStatus: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  target: z.object({ platform: z.string(), accountLabel: z.string(), title: z.string(), scheduledAt: z.string().nullable() }).nullable().default(null),
});
export const batchReceiptSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  items: z.array(batchItemSchema),
  counts: z.object({
    pending: z.number(),
    accepted: z.number(),
    blocked: z.number(),
    failed: z.number(),
  }),
});
export type BatchReceipt = z.infer<typeof batchReceiptSchema>;

export function taskHref(
  ref: TaskRef,
  tab = "overview",
  episodeId?: string | null,
): string {
  return `/tasks/${ref.kind}/${ref.id}/${tab}${episodeId ? `?episode=${encodeURIComponent(episodeId)}` : ""}`;
}
export function batchMessage(receipt: BatchReceipt): string {
  const { pending, accepted, blocked, failed } = receipt.counts;
  return `处理中 ${pending} 项 · 已受理 ${accepted} 项 · 需处理 ${blocked} 项 · 失败 ${failed} 项`;
}
