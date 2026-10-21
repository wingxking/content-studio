import { z } from "zod";
import { studioReceiptSchema } from "./protocol";

export const studioJournalSchema = z.record(
  z.string().uuid(),
  z
    .object({
      requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      status: z.enum(["started", "completed"]),
      receipt: studioReceiptSchema.optional(),
      reconciliation: z.object({ verification: z.literal('operator_verified'), verifiedAt: z.string().datetime() }).strict().optional(),
    })
    .strict(),
);

export function journalStatus(value: unknown): { blocked: boolean; invalid: boolean; pending: string[] } {
  const parsed = studioJournalSchema.safeParse(value === undefined ? {} : value);
  if (!parsed.success) return { blocked: true, invalid: true, pending: [] };
  const pending = Object.entries(parsed.data).filter(([, entry]) => entry.status !== 'completed' || !entry.receipt).map(([id]) => id);
  return { blocked: pending.length > 0, invalid: false, pending };
}

export function hasUnresolvedJournal(value: unknown): boolean {
  const parsed = studioJournalSchema.safeParse(
    value === undefined ? {} : value,
  );
  return (
    !parsed.success ||
    Object.values(parsed.data).some(
      (entry) => entry.status !== "completed" || !entry.receipt,
    )
  );
}
