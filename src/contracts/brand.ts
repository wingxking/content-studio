import { z } from 'zod';

export const brandProfileSchema = z.object({
  version: z.string().trim().min(1).max(60),
  audience: z.string().trim().max(1000),
  tone: z.string().trim().max(1000),
  terminology: z.string().trim().max(2000),
  cover: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/u), style: z.enum(['clear', 'minimal']), instruction: z.string().trim().max(1000) }),
}).strict();
export type BrandProfile = z.infer<typeof brandProfileSchema>;
export const defaultBrandProfile: BrandProfile = {
  version: '1', audience: '', tone: '清晰、务实、有依据；保留限制和来源，不虚构亲身体验。', terminology: '',
  cover: { accent: '#315bcf', style: 'clear', instruction: '标题与正文一致，文字清晰，不添加未经授权的标志或水印。' },
};
