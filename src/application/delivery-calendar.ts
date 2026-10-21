import { readState } from "../core/store.ts";
import type { Job } from "../core/model.ts";
import { calendarDate, deliveryCalendarInputSchema, deliveryCalendarSchema } from "../contracts/delivery-calendar.ts";
import { z } from "zod";
import { deliveryPageSchema } from "../contracts/workbench.ts";
import { dbRequest } from "../core/database.ts";
import { taskWorkspaceId } from "../core/tasks.ts";

function included(job: Pick<Job, "status" | "deliveryAction">): boolean {
  return job.deliveryAction !== "save_draft" && ["scheduled", "submitting", "queued", "published", "awaiting_operator", "needs_reconciliation", "failed", "delivered"].includes(job.status);
}

export function summarizeDeliveryCalendar(jobs: Pick<Job, "status" | "scheduledAt" | "deliveryAction">[], value: unknown) {
  const input = deliveryCalendarInputSchema.parse(value);
  const days = new Map<string, { date: string; total: number; states: Record<string, number> }>();
  for (const job of jobs) {
    if (!included(job)) continue;
    const date = calendarDate(job.scheduledAt, input.timezone);
    if (!date.startsWith(`${input.month}-`)) continue;
    const day = days.get(date) ?? { date, total: 0, states: {} };
    day.total++; day.states[job.status] = (day.states[job.status] ?? 0) + 1; days.set(date, day);
  }
  const result = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return deliveryCalendarSchema.parse({ ...input, days: result, total: result.reduce((sum, day) => sum + day.total, 0) });
}
export async function deliveryCalendar(value: unknown) { return summarizeDeliveryCalendar((await readState()).jobs, value); }

export async function deliveryCalendarDay(value: unknown) {
  const input = deliveryCalendarInputSchema.extend({ day: z.iso.date(), cursor: z.string().max(400).optional() }).parse(value);
  if (!input.day.startsWith(`${input.month}-`)) throw new Error("日期不属于当前月份。");
  const cursor = input.cursor ? z.object({ at: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))) : null;
  const jobs = (await readState()).jobs.filter(job => included(job) && calendarDate(job.scheduledAt, input.timezone) === input.day && (!cursor || job.createdAt < cursor.at || job.createdAt === cursor.at && job.id < cursor.id)).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const selected = jobs.slice(0,50);
  const ids = selected.flatMap(job => job.draftId ? [job.draftId] : []);
  const origins = ids.length ? z.array(z.object({ draft_id: z.uuid(), task_id: z.uuid(), origin_run_id: z.uuid() })).parse(await dbRequest(`studio_article_origins?workspace_id=eq.${await taskWorkspaceId()}&draft_id=in.(${ids.join(",")})&select=draft_id,task_id,origin_run_id`)) : [];
  const last = selected.at(-1);
  return deliveryPageSchema.parse({ items: selected.map(job => {
    const kind = job.subject?.kind ?? (job.snapshot?.video ? "video" : "article");
    const subjectId = kind === "video" ? job.subject?.id ?? job.snapshot?.video?.projectId : job.subject?.id ?? job.draftId;
    const origin = kind === "article" ? origins.find(item => item.draft_id === subjectId) : undefined;
    let remoteUrl = job.remoteUrl;
    if (remoteUrl) { try { const url = new URL(remoteUrl); if (url.protocol !== "https:" || url.username || url.password || /token|secret|password|signature|authorization/iu.test(url.search)) remoteUrl = null; } catch { remoteUrl = null; } }
    return { id: job.id, title: job.snapshot?.variant.title ?? "历史交付", subjectKind: kind, subjectId, revision: job.subject?.revision ?? job.snapshot?.draft?.revision ?? job.snapshot?.video?.revision ?? 1, accountId: job.accountId, platform: job.platform, status: job.status, draftOnly: false, scheduledAt: job.scheduledAt, createdAt: job.createdAt, remoteUrl, ref: { kind: kind === "video" ? "video" : origin ? "plan" : "article", id: origin?.task_id ?? subjectId }, episodeId: origin?.origin_run_id ?? null };
  }), nextCursor: jobs.length > 50 && last ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url") : null });
}
