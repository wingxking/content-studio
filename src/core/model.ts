import { jobAutomationSchema } from '../contracts/task-automation.ts';
import { financeSymbolSchema } from './execution-contract.ts';
import { z } from 'zod';
import { articleDocumentSchema } from './article-document.ts';
import { videoDeliverySettingsSchema } from '../contracts/video.ts';

export const platformIds = ['xiaohongshu', 'reddit', 'x', 'wechat', 'tiktok', 'bilibili', 'youtube', 'kuaishou', 'douyin', 'instagram', 'linkedin', 'facebook', 'producthunt', 'zhihu'] as const;
export const financePlatformIds = ['xueqiu', 'gelonghui', 'guba'] as const;
export const allPlatformIds = [...platformIds, ...financePlatformIds] as const;
export const platformSchema = z.enum(allPlatformIds);
export type Platform = z.infer<typeof platformSchema>;
export const sourceSchema = z.object({ title: z.string().min(1).max(300), url: z.url().refine(url => /^https?:\/\//.test(url), 'Use an HTTP(S) URL'), excerpt: z.string().min(1).max(12000) });
export const productLaunchSchema = z.object({
  url: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') && !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname); }, 'Provide the public HTTPS product website'),
  name: z.string().trim().min(1).max(100), tagline: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(260), firstComment: z.string().trim().min(1).max(10000),
});
export const redditTargetSchema = z.object({
  subreddit: z.string().regex(/^[A-Za-z0-9_]{3,21}$/, 'Use one subreddit name without r/'),
  rulesUrl: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && ['reddit.com', 'www.reddit.com'].includes(url.hostname) && !url.username && !url.password; }, 'Use the actual Reddit community rules URL'),
  approvalReference: z.string().trim().min(3).max(500),
  rulesReviewedAt: z.iso.datetime(), flair: z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(100) }).nullable(),
  flairRequired: z.boolean(),
}).refine(value => !value.flairRequired || value.flair !== null, 'Select the required community flair');
export const variantSchema = z.object({ platform: platformSchema, title: z.string().min(1).max(300), text: z.string().min(1).max(60000), tags: z.array(z.string().max(80)).max(30), mediaPaths: z.array(z.string().min(1)).max(20), format: z.enum(['text', 'article', 'image_note', 'video', 'product_launch']).optional(), launch: productLaunchSchema.optional(), finance: z.object({ symbols: z.array(financeSymbolSchema).max(20) }).strict().optional() });
export const generatedSchema = z.object({ title: z.string().min(1).max(300), body: z.string().min(1).max(80000), document: articleDocumentSchema.optional(), variants: z.array(variantSchema).min(1).max(platformIds.length) });
export const briefSchema = z.object({ topicOrigin: z.enum(['editorial', 'trend']).optional(), topic: z.string().min(1).max(1000), audience: z.string().min(1).max(1000), angle: z.string().min(1).max(4000), sources: z.array(sourceSchema).max(20), knowledgeIds: z.array(z.uuid()).min(1).max(8).optional(), evidenceDocumentIds: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(40).optional(), platforms: z.array(platformSchema).min(1).max(platformIds.length) }).refine(value => value.sources.length > 0 || !!value.knowledgeIds?.length || !!value.evidenceDocumentIds?.length, 'Supply public source evidence or immutable knowledge sources.');
export type Brief = z.infer<typeof briefSchema>;
export type Generated = z.infer<typeof generatedSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Source = z.infer<typeof sourceSchema>;
export const draftSchema = generatedSchema.extend({ id: z.uuid(), brief: briefSchema, createdAt: z.iso.datetime(), revision: z.number().int().positive(), approvedHash: z.string().nullable(), lastOperationId: z.uuid().optional(), lastAppliedProposalId: z.uuid().optional(), generationModel: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u).optional(), generationInstruction: z.string().max(12000).optional(), generationAssetIds: z.array(z.uuid()).max(12).optional(), generationKnowledgeRef: z.uuid().optional(), generationEvidenceRunId: z.uuid().optional(), adaptationStatus: z.enum(['pending', 'current']).optional() });
export type Draft = z.infer<typeof draftSchema>;
export const draftConnectionSchema = z.object({ adapter: z.literal('wechatsync'), userId: z.string().min(1).max(200), extensionId: z.string().regex(/^[a-p]{32}$/), checkedAt: z.iso.datetime(), permissionConfirmed: z.literal(true) });
export const draftReceiptSchema = z.object({ destination: z.enum(['platform', 'provider']), id: z.string().min(1).max(200), url: z.url(), verification: z.enum(['adapter_reported', 'operator_verified']), verifiedAt: z.iso.datetime().optional() });
export const accountSchema = z.object({ id: z.uuid(), platform: platformSchema, label: z.string().min(1).max(100), provider: z.enum(['native', 'postiz']), integrationId: z.string().max(200), status: z.enum(['needs_login', 'connected', 'blocked']), note: z.string().max(2000), verifiedAt: z.iso.datetime().nullable(), reddit: redditTargetSchema.optional(), draftConnection: draftConnectionSchema.optional(), physicalIdentity: z.object({ id: z.string().min(1).max(200), verifiedAt: z.iso.datetime(), verification: z.enum(['api', 'browser', 'fixture', 'operator']) }).strict().optional() });
export type Account = z.infer<typeof accountSchema>;
export const jobStatuses = ['scheduled', 'submitting', 'queued', 'awaiting_operator', 'needs_reconciliation', 'draft_saved', 'delivered', 'published', 'failed', 'cancelled'] as const;
export const metricsInputSchema = z.object({ views: z.number().int().nonnegative().nullable(), likes: z.number().int().nonnegative().nullable(), comments: z.number().int().nonnegative().nullable(), clicks: z.number().int().nonnegative().nullable(), notes: z.string().max(2000) });
export const videoDeliverySnapshotSchema = z.object({ projectId: z.uuid(), revision: z.number().int().positive(), renderId: z.uuid(), renderHash: z.string().regex(/^[a-f0-9]{64}$/), approvalHash: z.string().regex(/^[a-f0-9]{64}$/), sources: z.array(sourceSchema).max(20), hashVersion: z.literal(2).optional(), targetId: z.uuid().optional(), targetRevision: z.number().int().positive().optional(), renderInputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), deliverySettings: videoDeliverySettingsSchema.optional() });
export const verificationCheckSchema = z.object({ nextAt: z.iso.datetime().nullable(), deadline: z.iso.datetime(), attempt: z.number().int().nonnegative(), lastError: z.string().max(300).nullable(), checkedAt: z.iso.datetime().nullable(), stoppedReason: z.enum(['permission_required', 'window_expired', 'attempt_budget', 'terminal', 'uncertain']).nullable() }).strict();
export const jobSchema = z.object({ automation: jobAutomationSchema.optional(), verificationCheck: verificationCheckSchema.optional(), deliveryAction: z.literal('save_draft').optional(), draftReceipt: draftReceiptSchema.optional(), mediaHashes: z.array(z.string()).optional(), id: z.uuid(), draftId: z.uuid().nullable(), subject: z.object({ kind: z.enum(['article', 'video']), id: z.uuid(), revision: z.number().int().positive() }).optional(), platform: platformSchema, accountId: z.uuid(), approvedHash: z.string(), contentHash: z.string().default(''), snapshot: z.object({ executorKind: z.enum(['browser-fixture', 'browser']).optional(), executorVersion: z.literal(1).optional(), executorSessionId: z.uuid().optional(), executorAccountId: z.string().min(1).max(200).optional(), draft: draftSchema.optional(), video: videoDeliverySnapshotSchema.optional(), account: accountSchema, variant: variantSchema }).refine(value => Boolean(value.draft) !== Boolean(value.video), 'Exactly one article or video snapshot is required').nullable().default(null), status: z.enum(jobStatuses), scheduledAt: z.iso.datetime(), createdAt: z.iso.datetime(), provider: z.enum(['native', 'postiz']), providerPostId: z.string().nullable().default(null), remoteId: z.string().nullable(), remoteUrl: z.string().nullable(), visibility: z.enum(['public', 'unlisted', 'private']).optional(), attempts: z.number().int().nonnegative(), error: z.string().nullable(), submissionOwner: z.string().nullable().default(null), submissionStartedAt: z.iso.datetime().nullable().default(null), submissionLeaseUntil: z.iso.datetime().nullable().optional(), metrics: z.array(metricsInputSchema.extend({ at: z.iso.datetime() })).default([]), history: z.array(z.object({ at: z.iso.datetime(), status: z.enum(jobStatuses), message: z.string() })) });
export type Job = z.infer<typeof jobSchema>;
export const stateSchema = z.object({ version: z.literal(1), paused: z.boolean(), drafts: z.array(draftSchema), accounts: z.array(accountSchema), jobs: z.array(jobSchema) });
export type StudioState = z.infer<typeof stateSchema>;
export const emptyState = (): StudioState => ({ version: 1, paused: false, drafts: [], accounts: [], jobs: [] });

export const nativeUrls: Record<Platform, string> = {
  xiaohongshu: 'https://creator.xiaohongshu.com/', reddit: 'https://www.reddit.com/submit', x: 'https://x.com/compose/post',
  wechat: 'https://mp.weixin.qq.com/', tiktok: 'https://www.tiktok.com/tiktokstudio/upload', bilibili: 'https://member.bilibili.com/platform/upload/video/frame',
  youtube: 'https://studio.youtube.com/', kuaishou: 'https://cp.kuaishou.com/', douyin: 'https://creator.douyin.com/',
  instagram: 'https://www.instagram.com/', linkedin: 'https://www.linkedin.com/', facebook: 'https://business.facebook.com/', producthunt: 'https://www.producthunt.com/posts/new', xueqiu: 'https://xueqiu.com/', gelonghui: 'https://www.gelonghui.com/', guba: 'https://guba.eastmoney.com/', zhihu: 'https://zhuanlan.zhihu.com/write'
};
export const platformLabels: Record<Platform, string> = { xiaohongshu: 'Xiaohongshu', reddit: 'Reddit', x: 'X', wechat: 'WeChat Official Accounts', tiktok: 'TikTok', bilibili: 'Bilibili', youtube: 'YouTube', kuaishou: 'Kuaishou', douyin: 'Douyin', instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook', producthunt: 'Product Hunt', zhihu: 'Zhihu', xueqiu: 'Xueqiu', gelonghui: 'Gelonghui', guba: 'Eastmoney Guba' };
