import { z } from 'zod';
import type { VideoProject, VideoTarget } from '../core/video-model.ts';

// These schemas are browser-safe. Execution credentials and filesystem paths never belong here.
export const videoYouTubeSettingsSchema = z.object({
  privacyStatus: z.enum(['public', 'unlisted', 'private']), selfDeclaredMadeForKids: z.boolean(),
  containsSyntheticMedia: z.boolean(), categoryId: z.string().regex(/^\d+$/u),
  defaultLanguage: z.string().min(2).max(20), descriptionDisclosure: z.string().trim().min(10).max(1000),
}).strict();
export const videoDeliverySettingsSchema = z.object({ youtube: videoYouTubeSettingsSchema.optional() }).strict();
export type VideoDeliverySettings = z.infer<typeof videoDeliverySettingsSchema>;
export const videoFramePresets = [
  { id: 'landscape', label: '横屏 16:9', width: 1920, height: 1080 },
  { id: 'portrait', label: '竖屏 9:16', width: 1080, height: 1920 },
] as const;

type RenderOutput = NonNullable<VideoProject['renders'][number]['output']>;
export type VideoProjectView = Omit<VideoProject, 'renders' | 'targets' | 'deliveryApproval'> & {
  targets: VideoTargetView[];
  renders: Array<Omit<VideoProject['renders'][number], 'output'> & {
    output: Pick<RenderOutput, 'hash' | 'duration' | 'width' | 'height' | 'reusedStages'> & { mediaUrl: string; captionsUrl: string | null } | null;
  }>;
};
export type VideoTargetView = Omit<VideoTarget, 'approval'> & {
  approval: { approvalHash: string; at: string; outputHash: string } | null;
  capability: { automatic: boolean; remoteDraft: false; reason: string | null };
};
