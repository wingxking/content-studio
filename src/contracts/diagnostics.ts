import { z } from "zod";

export const diagnosticSchema = z.object({
  id: z.uuid(), at: z.iso.datetime(), level: z.enum(["info", "warn", "error"]),
  service: z.enum(["api", "article", "video", "delivery", "all"]),
  event: z.enum(["api.started", "http.completed", "http.failed", "worker.started", "work.started", "work.completed", "work.failed"]),
  requestId: z.uuid().optional(), jobId: z.uuid().optional(),
  status: z.number().int().min(100).max(599).optional(), durationMs: z.number().min(0).max(86400000).optional(),
  code: z.enum(["REQUEST_FAILED", "WORK_FAILED", "LEASE_LOST"]).optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type DiagnosticInput = Omit<Diagnostic, "id" | "at">;
export const diagnosticQuerySchema = z.object({
  level: diagnosticSchema.shape.level.optional(), service: diagnosticSchema.shape.service.optional(),
  jobId: z.uuid().optional(), requestId: z.uuid().optional(),
  cursor: z.string().max(300).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const diagnosticPageSchema = z.object({
  items: z.array(diagnosticSchema), nextCursor: z.string().nullable(),
  invalidLines: z.number(), unreadableFiles: z.number(), retentionDays: z.number(), maxBytes: z.number(),
});
