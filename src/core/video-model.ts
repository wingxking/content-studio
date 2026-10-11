import { z } from 'zod';
import { accountSchema, sourceSchema, variantSchema } from './model.ts';
import { assessmentSchema } from './task-model.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const revisionNumber = z.number().int().positive();
export const videoPlatformSchema = z.enum(['youtube', 'tiktok', 'bilibili', 'kuaishou', 'douyin']);
export const videoSourceSchema = z.object({ draftId: z.uuid(), revision: revisionNumber, title: z.string(), body: z.string().max(80000) }).strict();
export const videoSceneSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
  narration: z.string().min(1).max(4000),
  visualDescription: z.string().min(1).max(2000),
  assetId: z.uuid().nullable(),
  caption: z.string().max(4000).nullable(),
  sourceUrls: z.array(z.url()).max(20),
}).strict();
export const videoContentSchema = z.object({
  title: z.string().min(1).max(300),
  script: z.string().min(1).max(24000),
  scenes: z.array(videoSceneSchema).min(1).max(40).refine(scenes => new Set(scenes.map(scene => scene.id)).size === scenes.length, 'Scene IDs must be unique.'),
  disclosureReview: z.string().min(1).max(4000),
}).strict();
export const videoSettingsSchema = z.object({
  width: z.number().int().min(128).max(4096).refine(value => value % 2 === 0).default(1080),
  height: z.number().int().min(128).max(4096).refine(value => value % 2 === 0).default(1920),
  fps: z.number().int().min(12).max(60).default(24),
  voice: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/u).default('af_heart'),
  speed: z.number().min(0.25).max(4).default(1),
  captions: z.boolean().default(true),
  burnCaptions: z.boolean().default(true),
  font: z.enum(['Noto Sans CJK SC', 'Noto Sans']).default('Noto Sans CJK SC'),
  maxSeconds: z.number().int().min(1).max(1800).default(180),
}).strict();
export const videoBriefSchema = z.object({ topic: z.string().min(1).max(1000), audience: z.string().min(1).max(1000), instruction: z.string().max(12000), sources: z.array(sourceSchema).max(20), platform: videoPlatformSchema }).strict();
export const videoRevisionSchema = z.object({ operationId: z.uuid().optional(), number: revisionNumber, createdAt: z.iso.datetime(), content: videoContentSchema.nullable(), settings: videoSettingsSchema, sourceArticle: videoSourceSchema.nullable(), assessment: assessmentSchema.nullable() }).strict();
export const videoProposalSchema = z.object({ operationId: z.uuid().optional(), id: z.uuid(), baseRevision: revisionNumber, assessment: assessmentSchema, instruction: z.string(), content: videoContentSchema, createdAt: z.iso.datetime(), appliedRevision: revisionNumber.nullable() }).strict();
export const videoOutputSchema = z.object({ rawPath: z.string(), videoPath: z.string(), captionsPath: z.string().nullable(), manifestPath: z.string(), hash: hashSchema, rawHash: hashSchema, duration: z.number().positive(), width: z.number().int().positive(), height: z.number().int().positive(), upstreamRevision: z.string().regex(/^[a-f0-9]{32}$/u), reusedStages: z.number().int().nonnegative(), renderedAssetId: z.uuid().nullable() }).strict();
export const videoRenderSchema = z.object({ operationId: z.uuid().optional(), id: z.uuid(), revision: revisionNumber, inputHash: hashSchema, status: z.enum(['running', 'succeeded', 'failed', 'cancelled']), owner: z.uuid(), attempt: revisionNumber, phase: z.string(), startedAt: z.iso.datetime(), heartbeatAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), output: videoOutputSchema.nullable(), error: z.string().nullable() }).strict();
export const videoProjectSchema = z.object({
  id: z.uuid(), version: revisionNumber, lastOperationId: z.uuid().optional(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), brief: videoBriefSchema,
  revision: revisionNumber, revisions: z.array(videoRevisionSchema).min(1), proposals: z.array(videoProposalSchema), renders: z.array(videoRenderSchema),
  status: z.enum(['editing', 'rendering', 'ready', 'failed']),
  approval: z.object({ revision: revisionNumber, inputHash: hashSchema, at: z.iso.datetime() }).strict().nullable(),
  deliveryApproval: z.object({ renderId: z.uuid(), revision: revisionNumber, accountId: z.uuid(), outputHash: hashSchema, approvalHash: hashSchema, account: accountSchema, variant: variantSchema, at: z.iso.datetime() }).strict().nullable(),
}).strict();
export const videoCreateInputSchema = z.object({
  explicitlyRequested: z.literal(true), brief: videoBriefSchema, settings: videoSettingsSchema.optional(),
  sourceArticle: z.object({ draftId: z.uuid(), revision: revisionNumber }).strict().nullable().optional(),
  content: videoContentSchema.nullable().optional(),
}).strict();
export const videoEditInputSchema = z.object({ expectedRevision: revisionNumber, content: videoContentSchema, settings: videoSettingsSchema.optional() }).strict();
export const videoApprovalInputSchema = z.object({ expectedRevision: revisionNumber }).strict();
export const videoRefinementInputSchema = z.object({ expectedRevision: revisionNumber, instruction: z.string().min(3).max(4000), sceneId: videoSceneSchema.shape.id.nullable().optional() }).strict();
export const videoGenerationEnvelopeSchema = z.object({ assessment: assessmentSchema, content: videoContentSchema.nullable() }).strict();
export type VideoProject = z.infer<typeof videoProjectSchema>;
export type VideoRevision = z.infer<typeof videoRevisionSchema>;
export type VideoRender = z.infer<typeof videoRenderSchema>;
export type VideoOutput = z.infer<typeof videoOutputSchema>;
export type VideoContent = z.infer<typeof videoContentSchema>;
export type VideoSettings = z.infer<typeof videoSettingsSchema>;
export type VideoScene = z.infer<typeof videoSceneSchema>;
export type VideoBrief = z.infer<typeof videoBriefSchema>;
