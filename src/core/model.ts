import { z } from 'zod';

export const platformIds = ['xiaohongshu', 'reddit', 'x', 'wechat', 'tiktok', 'bilibili', 'youtube', 'kuaishou', 'douyin', 'instagram', 'linkedin', 'facebook'] as const;
export const platformSchema = z.enum(platformIds);
export type Platform = z.infer<typeof platformSchema>;
export const sourceSchema = z.object({ title: z.string().min(1).max(300), url: z.url().refine(url => /^https?:\/\//.test(url), 'Use an HTTP(S) URL'), excerpt: z.string().min(1).max(12000) });
export const variantSchema = z.object({ platform: platformSchema, title: z.string().min(1).max(300), text: z.string().min(1).max(60000), tags: z.array(z.string().max(80)).max(30), mediaPaths: z.array(z.string().min(1)).max(20) });
export const generatedSchema = z.object({ title: z.string().min(1).max(300), body: z.string().min(1).max(80000), variants: z.array(variantSchema).min(1).max(12) });
export const briefSchema = z.object({ topicOrigin: z.enum(['editorial', 'trend']).optional(), topic: z.string().min(1).max(1000), audience: z.string().min(1).max(1000), angle: z.string().min(1).max(4000), sources: z.array(sourceSchema).min(1).max(20), platforms: z.array(platformSchema).min(1).max(12) });
export type Brief = z.infer<typeof briefSchema>;
export type Generated = z.infer<typeof generatedSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Source = z.infer<typeof sourceSchema>;
export const draftSchema = generatedSchema.extend({ id: z.uuid(), brief: briefSchema, createdAt: z.iso.datetime(), revision: z.number().int().positive(), approvedHash: z.string().nullable(), lastOperationId: z.uuid().optional(), lastAppliedProposalId: z.uuid().optional(), generationModel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u).optional(), generationInstruction: z.string().max(12000).optional(), generationAssetIds: z.array(z.uuid()).max(12).optional(), adaptationStatus: z.enum(['pending', 'current']).optional() });
export type Draft = z.infer<typeof draftSchema>;
export const accountSchema = z.object({ id: z.uuid(), platform: platformSchema, label: z.string().min(1).max(100), provider: z.enum(['native', 'postiz']), integrationId: z.string().max(200), status: z.enum(['needs_login', 'connected', 'blocked']), note: z.string().max(2000), verifiedAt: z.iso.datetime().nullable() });
export type Account = z.infer<typeof accountSchema>;
export const jobStatuses = ['scheduled', 'submitting', 'queued', 'awaiting_operator', 'needs_reconciliation', 'delivered', 'published', 'failed', 'cancelled'] as const;
export const metricsInputSchema = z.object({ views: z.number().int().nonnegative().nullable(), likes: z.number().int().nonnegative().nullable(), comments: z.number().int().nonnegative().nullable(), clicks: z.number().int().nonnegative().nullable(), notes: z.string().max(2000) });
export const jobSchema = z.object({ id: z.uuid(), draftId: z.uuid(), platform: platformSchema, accountId: z.uuid(), approvedHash: z.string(), contentHash: z.string().default(''), snapshot: z.object({ draft: draftSchema, account: accountSchema, variant: variantSchema }).nullable().default(null), status: z.enum(jobStatuses), scheduledAt: z.iso.datetime(), createdAt: z.iso.datetime(), provider: z.enum(['native', 'postiz']), providerPostId: z.string().nullable().default(null), remoteId: z.string().nullable(), remoteUrl: z.string().nullable(), visibility: z.enum(['public', 'unlisted', 'private']).optional(), attempts: z.number().int().nonnegative(), error: z.string().nullable(), submissionOwner: z.string().nullable().default(null), submissionStartedAt: z.iso.datetime().nullable().default(null), metrics: z.array(metricsInputSchema.extend({ at: z.iso.datetime() })).default([]), history: z.array(z.object({ at: z.iso.datetime(), status: z.enum(jobStatuses), message: z.string() })) });
export type Job = z.infer<typeof jobSchema>;
export const stateSchema = z.object({ version: z.literal(1), paused: z.boolean(), drafts: z.array(draftSchema), accounts: z.array(accountSchema), jobs: z.array(jobSchema) });
export type StudioState = z.infer<typeof stateSchema>;
export const emptyState = (): StudioState => ({ version: 1, paused: false, drafts: [], accounts: [], jobs: [] });

export const nativeUrls: Record<Platform, string> = {
  xiaohongshu: 'https://creator.xiaohongshu.com/', reddit: 'https://www.reddit.com/submit', x: 'https://x.com/compose/post',
  wechat: 'https://mp.weixin.qq.com/', tiktok: 'https://www.tiktok.com/tiktokstudio/upload', bilibili: 'https://member.bilibili.com/platform/upload/video/frame',
  youtube: 'https://studio.youtube.com/', kuaishou: 'https://cp.kuaishou.com/', douyin: 'https://creator.douyin.com/',
  instagram: 'https://www.instagram.com/', linkedin: 'https://www.linkedin.com/', facebook: 'https://business.facebook.com/'
};
export const platformLabels: Record<Platform, string> = { xiaohongshu: 'Xiaohongshu', reddit: 'Reddit', x: 'X', wechat: 'WeChat Official Accounts', tiktok: 'TikTok', bilibili: 'Bilibili', youtube: 'YouTube', kuaishou: 'Kuaishou', douyin: 'Douyin', instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook' };
