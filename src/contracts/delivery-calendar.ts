import { z } from "zod";

export const deliveryCalendarInputSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
  timezone: z.string().max(100).default("Asia/Singapore").refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
});
export const deliveryCalendarSchema = z.object({
  month: z.string(), timezone: z.string(), total: z.number().int().nonnegative(),
  days: z.array(z.object({ date: z.string(), total: z.number().int().positive(), states: z.record(z.string(), z.number().int().positive()) })),
});
export function calendarDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
