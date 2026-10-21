import { z } from "zod";

export const captureSessionKey = "contentStudioCaptureSessionV1";
export const captureSessionSchema = z
  .object({
    commandId: z.string().uuid(),
    title: z.string().max(300),
    url: z.string().max(2000),
    excerpt: z.string().max(12000),
    selected: z.string(),
    submitted: z.boolean().default(false),
  })
  .strict();
export type CaptureSession = z.infer<typeof captureSessionSchema>;
export function emptyCapture(): CaptureSession {
  return {
    commandId: crypto.randomUUID(),
    title: "",
    url: "",
    excerpt: "",
    selected: "",
    submitted: false,
  };
}
export async function restoreCapture(): Promise<CaptureSession | null> {
  const stored = await chrome.storage.session.get(captureSessionKey);
  const result = captureSessionSchema.safeParse(stored[captureSessionKey]);
  return result.success ? result.data : null;
}
export async function persistCapture(value: CaptureSession): Promise<void> {
  await chrome.storage.session.set({
    [captureSessionKey]: captureSessionSchema.parse(value),
  });
}
