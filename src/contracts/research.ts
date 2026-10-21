import { z } from 'zod';

export const hasSourceCredentials = (url: URL): boolean => Boolean(url.username || url.password) || [...url.searchParams.keys()].some(key => /token|secret|password|authorization|credential|signature|api.?key|^sig$|^x-(?:amz|goog)-/iu.test(key));
export const publicSourceUrl = z.url().max(2000).refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !hasSourceCredentials(url);
}, 'Use a public source link without credentials.');
export const sourcePreferenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/), name: z.string().min(1).max(200),
  url: publicSourceUrl, scope: z.enum(['site', 'section', 'page', 'feed', 'github', 'hn', 'crossref']).default('section'),
  feedUrl: publicSourceUrl.optional(), weight: z.number().int().min(1).max(5).default(3),
  category: z.enum(['primary', 'media', 'community', 'research']).default('media'),
  access: z.enum(['readable', 'discovery_only', 'requires_authorization', 'disabled']).default('readable'),
  intervalMinutes: z.number().int().min(30).max(10080).default(60), enabled: z.boolean().default(true),
}).strict();
export type SourcePreference = z.infer<typeof sourcePreferenceSchema>;
export const testRecordSchema = z.object({
  title: z.string().trim().min(3).max(200), performedAt: z.iso.datetime(),
  environment: z.string().trim().min(3).max(4000), procedure: z.string().trim().min(10).max(12000),
  observations: z.string().trim().min(20).max(80000), limitations: z.string().trim().min(3).max(4000),
  ownerAttested: z.literal(true),
}).strict();
export const researchPolicySchema = z.object({
  language: z.string().min(2).max(40).default('zh-CN'), freshnessHours: z.number().int().min(1).max(2160).default(48),
  duplicateDays: z.number().int().min(1).max(90).default(14), candidateBudget: z.number().int().min(10).max(100).default(30),
  provider: z.enum(['codex', 'tavily']).default('codex'),
  articleType: z.enum(['auto', 'update', 'tutorial', 'comparison', 'explanation']).default('auto'),
}).strict();
export const qualityPolicySchema = z.object({
  maxEvidenceRounds: z.number().int().min(0).max(2).default(2), maxRevisionRounds: z.number().int().min(0).max(2).default(2),
  maxModelCalls: z.number().int().min(6).max(12).default(12), timeoutMs: z.number().int().min(1000).max(600000).default(600000),
}).strict();
export const evidenceDocumentSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), sourceId: z.string().max(100), url: z.string().max(2000), title: z.string().max(300),
  publisher: z.string().max(300), publishedAt: z.iso.datetime().nullable(), fetchedAt: z.iso.datetime(),
  author: z.string().max(300).nullable().optional(), updatedAt: z.iso.datetime().nullable().optional(), originHash: z.string().optional(),
  creditedPublisher: z.string().max(300).nullable().optional(),
  paperStatus: z.enum(['preprint', 'published', 'unknown']).optional(),
  rights: z.enum(['public_read', 'owner_supplied']).optional(),
  evidenceType: z.enum(['reference', 'test_record']).optional(),
  originalRef: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), parserVersion: z.string().max(120), chunkingVersion: z.string().max(100).optional(), embeddingVersion: z.string().max(200).optional(),
  access: z.enum(['full', 'partial', 'unverified']), category: z.enum(['primary', 'media', 'community', 'research', 'owner']),
  chunks: z.array(z.object({ id: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), page: z.number().int().positive().nullable(), heading: z.string().max(500) })).max(10000),
});
export type EvidenceDocument = z.infer<typeof evidenceDocumentSchema>;
export const topicClusterSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u), title: z.string().min(3).max(300),
  documentIds: z.array(z.string()).min(1).max(40), originalDocumentId: z.string().nullable(),
  reason: z.string().min(1).max(2000), judgement: z.literal('model_assisted'),
});
export const evidenceSpanSchema = z.object({ documentId: z.string(), chunkId: z.string(), quote: z.string().min(1).max(2000) }).strict();
export const claimSchema = z.object({
  id: z.string().min(1).max(100), text: z.string().min(1).max(2000), critical: z.boolean(),
  kind: z.enum(['fact', 'attributed', 'inference', 'opinion']), status: z.enum(['supported', 'contradicted', 'insufficient']),
  evidence: z.array(evidenceSpanSchema).max(8), caveat: z.string().max(2000),
}).strict();
export const qualityReportSchema = z.object({
  status: z.enum(['passed', 'withheld']), contentHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  draftRevision: z.number().int().positive(),
  checkedAt: z.iso.datetime(), claims: z.array(claimSchema).max(200), issues: z.array(z.string().max(2000)).max(100),
  notes: z.array(z.string().max(2200)).max(200).default([]),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })).max(30),
  model: z.string(), guidanceVersion: z.string(), judgement: z.literal('model_assisted'),
  platformChecks: z.array(z.object({ platform: z.string(), claims: z.array(claimSchema).max(200), passed: z.boolean() })).max(17).optional(),
});
export type QualityReport = z.infer<typeof qualityReportSchema>;
export const isTimeSensitiveClaim = (text: string): boolean => /价格|定价|权限|配额|额度|收费|免费|套餐|美元|￥|\$\s*\d|price|pricing|permission|quota|billing|rate.?limit|licen[cs]ing|free.?tier|\bUSD\b/iu.test(text);
export function qualityExpiresAt(report: QualityReport): string {
  const claims = [...report.claims, ...(report.platformChecks ?? []).flatMap(check => check.claims)];
  return new Date(Date.parse(report.checkedAt) + (claims.some(claim => isTimeSensitiveClaim(claim.text)) ? 24 : 168) * 3600000).toISOString();
}
export type EvidenceHit = { document: EvidenceDocument; chunkId: string; text: string; score: number; page: number | null; heading: string };
export const researchArtifactsSchema = z.object({
  steps: z.array(z.object({ stage: z.string(), status: z.string(), attempts: z.number(), updated_at: z.string(), model: z.string().nullable(), usage: z.record(z.string(), z.unknown()).nullable().optional() })),
  documents: z.array(evidenceDocumentSchema), report: qualityReportSchema.nullable(),
  plan: z.object({ questions: z.array(z.string()), contribution: z.string(), kind: z.string() }).nullable(),
  decisions: z.array(z.object({ topic: z.string(), selected: z.boolean(), reason: z.string() })),
  clusters: z.array(topicClusterSchema),
});
export const productionMetricsSchema = z.object({
  since: z.string(), checkedAt: z.string(), engine: z.literal('pgmq'), scheduler: z.literal('pg_cron'),
  sources: z.object({ succeeded: z.number(), failed: z.number(), failureRate: z.number().nullable() }),
  articles: z.object({ attempted: z.number(), qualified: z.number(), qualifiedRate: z.number().nullable(), supplementedRuns: z.number() }),
  model: z.object({ attempts: z.number(), knownCalls: z.number(), unknownCalls: z.number(), confirmedInputTokens: z.number().nullable(), confirmedOutputTokens: z.number().nullable(), confirmedCost: z.number().nullable() }),
  evidenceMeanAgeHours: z.number().nullable(), stages: z.array(z.object({ stage: z.string(), samples: z.number(), meanMs: z.number() })), editedAfterProduction: z.number(),
});
