import { z } from 'zod';
import { financePlatformIds, type Variant } from './model.ts';
import { financeSymbolSchema } from './execution-contract.ts';
export const financePilotConfigurationSchema = z.object({ xueqiu: z.literal(false), gelonghui: z.literal(false), guba: z.literal(false) }).strict();
export const financePilotDefaults = financePilotConfigurationSchema.parse({ xueqiu: false, gelonghui: false, guba: false });
export function financeCommunityPreview(variant: Variant) {
  if (!(financePlatformIds as readonly string[]).includes(variant.platform)) throw new Error('This is not a finance-community variant.');
  if (variant.format !== 'image_note' && variant.format !== 'text') throw new Error('The isolated pilot supports plain paragraphs with optional reviewed images. Rich articles and video require a separate reviewed conversion.');
  const symbols = z.array(financeSymbolSchema).max(20).parse(variant.finance?.symbols ?? []);
  if (new Set(symbols.map(symbol => `${symbol.market}:${symbol.code}`)).size !== symbols.length) throw new Error('Choose each finance symbol once.');
  return { title: variant.title, paragraphs: variant.text.split(/\n{2,}/), images: [...variant.mediaPaths], symbols, tags: [...variant.tags], automatic: false, blocker: 'Real account permission and adapter acceptance are pending. No live page workflow is enabled.' };
}
