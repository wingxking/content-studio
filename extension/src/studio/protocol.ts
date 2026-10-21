import { z } from "zod";
export const studioJournalKey = 'contentStudioDraftJournalV1';

export const studioPlatforms = ["weixin", "zhihu", "bilibili"] as const;
export const studioHello = {
  protocol: "content-studio-drafts",
  version: 1,
  draftOnly: true,
  platforms: [...studioPlatforms],
  features: ['journal-reconciliation'],
} as const;
export const studioExecutionSchema = z
  .object({
    protocolVersion: z.literal(1),
    jobId: z.string().uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    expectedUserId: z.string().min(1).max(200),
  })
  .strict();
export const studioSaveSchema = z
  .object({
    platforms: z.tuple([z.enum(studioPlatforms)]),
    draftOnly: z.literal(true),
    execution: studioExecutionSchema,
    article: z
      .object({
        title: z.string().trim().min(1).max(300),
        content: z
          .string()
          .min(1)
          .max(16 * 1024 * 1024),
        cover: z
          .string()
          .max(8 * 1024 * 1024)
          .optional(),
      })
      .strict(),
  })
  .strict();
export type StudioSave = z.infer<typeof studioSaveSchema>;
export const studioReceiptSchema = z.object({
  platform: z.enum(studioPlatforms),
  success: z.literal(true),
  draftOnly: z.literal(true),
  postId: z
    .union([z.string(), z.number()])
    .transform(String)
    .pipe(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)),
  postUrl: z.string().url(),
});
export type StudioReceipt = z.infer<typeof studioReceiptSchema>;
export const studioJournalConfirmationSchema = z.object({ request: studioSaveSchema, receipt: studioReceiptSchema }).strict();

// Do not retain session tokens from native editor URLs in the execution journal.
export function normalizeStudioReceipt(
  value: unknown,
  platform: StudioSave["platforms"][0],
): StudioReceipt {
  const receipt = studioReceiptSchema.parse(value);
  if (receipt.platform !== platform) throw new Error("Invalid draft receipt");
  const url = new URL(receipt.postUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Invalid draft URL");
  if (
    platform === "weixin" &&
    url.hostname === "mp.weixin.qq.com" &&
    url.pathname === "/cgi-bin/appmsg" &&
    url.searchParams.get("t") === "media/appmsg_edit" &&
    url.searchParams.get("action") === "edit" &&
    url.searchParams.get("appmsgid") === receipt.postId
  ) {
    receipt.postUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${encodeURIComponent(receipt.postId)}`;
  } else if (
    platform === "zhihu" &&
    url.hostname === "zhuanlan.zhihu.com" &&
    url.pathname === `/p/${receipt.postId}/edit`
  ) {
    receipt.postUrl = `${url.origin}${url.pathname}`;
  } else if (
    platform === "bilibili" &&
    url.hostname === "member.bilibili.com" &&
    url.pathname === "/platform/upload/text/edit" &&
    url.searchParams.get("aid") === receipt.postId
  ) {
    receipt.postUrl = `${url.origin}${url.pathname}?aid=${encodeURIComponent(receipt.postId)}`;
  } else throw new Error("Invalid draft URL");
  return receipt;
}

export function isStudioUrl(value: string): boolean {
  const url = new URL(value);
  return url.pathname === "/connect" && url.searchParams.has("key");
}
export function validateMcpUrl(value: string): string {
  const url = new URL(value || "ws://localhost:9527");
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid bridge URL");
  if (
    isStudioUrl(url.href) &&
    (url.protocol !== "ws:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.searchParams.size !== 1 ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(url.searchParams.get("key") || ""))
  )
    throw new Error("Studio bridge must use a local private connection URL");
  return url.href;
}

export function studioSocketOptions(value: string): { url: string; protocols: string[] } {
  const url = new URL(value);
  if (['/connect','/ui/connect'].includes(url.pathname) && url.searchParams.has('key')) {
    const checked = new URL(url.href); checked.pathname='/connect'; validateMcpUrl(checked.href);
    const key=url.searchParams.get('key')!;
    url.search='';
    return {url:url.href,protocols:[`content-studio-key.${key}`]};
  }
  return {url:validateMcpUrl(value),protocols:[]};
}
