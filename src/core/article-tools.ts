import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { dbRpc } from './database.ts';
import { getAsset, assetWorkspace, assetMediaReference } from './assets.ts';
import { createReadStream } from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { resolveAssetPath, uploadAssetStream } from './assets.ts';
export const imageRecipeSchema = z.object({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096), fit: z.enum(['cover', 'contain', 'inside']).default('cover'), format: z.enum(['png', 'jpeg', 'webp']).default('webp'), quality: z.number().int().min(40).max(100).default(85) }).strict();
async function adaptRecipeImage(id: string, value: unknown) {
  const recipe = imageRecipeSchema.parse(value); const path = await resolveAssetPath(z.uuid().parse(id));
  const metadata = await sharp(path, { limitInputPixels: 40 * 1024 * 1024 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Image adaptation requires a single PNG, JPEG or WebP frame.');
  const transform = sharp({ limitInputPixels: 40 * 1024 * 1024 }).rotate().resize(recipe.width, recipe.height, { fit: recipe.fit, withoutEnlargement: recipe.fit === 'inside' });
  if (recipe.format === 'jpeg') transform.jpeg({ quality: recipe.quality });
  else if (recipe.format === 'webp') transform.webp({ quality: recipe.quality }); else transform.png();
  return uploadAssetStream(`Image-${id.slice(0, 8)}-${recipe.width}x${recipe.height}.${recipe.format}`, createReadStream(path).pipe(transform));
}

export const financeImagePresetSchema = z.object({ preset: z.literal('finance-community-v1'), platform: z.enum(['xueqiu', 'gelonghui', 'guba']) }).strict();
export const imageAdaptationInputSchema = z.union([imageRecipeSchema, financeImagePresetSchema]);
export const financeImageParameters = { version: 1, maximumEdge: 1600, format: 'jpeg', quality: 88, background: '#ffffff', fit: 'inside', enlarge: false } as const;
export async function renderFinanceImage(path: string): Promise<Buffer> {
  const metadata = await sharp(path, { limitInputPixels: 40 * 1024 * 1024 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('This preset requires a single PNG, JPEG or WebP image. Choose a reviewed still image for animation.');
  return sharp(path, { limitInputPixels: 40 * 1024 * 1024 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
}
const renditionSchema = z.object({ id: z.uuid(), status: z.enum(['pending', 'finalized']), owner_token: z.uuid().nullable(), result_asset_id: z.uuid().nullable(), source_hash: z.string(), recipe_hash: z.string(), width: z.number().nullable(), height: z.number().nullable(), result_hash: z.string().nullable() });
export async function adaptArticleImage(id: string, value: unknown) {
  const input = imageAdaptationInputSchema.parse(value);
  if (!('preset' in input)) return adaptRecipeImage(id, input);
  const original = await getAsset(z.uuid().parse(id)); const path = await resolveAssetPath(id);
  const recipe = { ...financeImageParameters, platform: input.platform, preset: input.preset };
  const recipeHash = createHash('sha256').update(JSON.stringify(recipe)).digest('hex'); const owner = randomUUID();
  const row = renditionSchema.parse(await dbRpc('studio_claim_asset_rendition', { p_workspace: assetWorkspace(), p_source: id, p_source_hash: original.hash, p_recipe_hash: recipeHash, p_recipe: recipe, p_owner: owner }));
  if (row.status === 'finalized' && row.result_asset_id) {
    const asset = await getAsset(row.result_asset_id); if (asset.hash !== row.result_hash) throw new Error('Cached image rendition integrity changed.');
    return { asset, path: await resolveAssetPath(asset.id), reference: await assetMediaReference(asset.id), rendition: { id: row.id, sourceAssetId: id, sourceHash: original.hash, preset: input.preset, recipeHash, width: row.width, height: row.height, cached: true } };
  }
  if (row.owner_token !== owner) throw new Error('This image rendition is being prepared. Retry after the current transformation completes.');
  const bytes = await renderFinanceImage(path); const metadata = await sharp(bytes).metadata();
  const result = await uploadAssetStream(`Finance-${id.slice(0, 8)}.jpeg`, Readable.from([bytes]));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (result.asset.hash !== hash || result.asset.bytes !== bytes.length) throw new Error('Transformed image byte verification failed.');
  if (await dbRpc('studio_finalize_asset_rendition', { p_workspace: assetWorkspace(), p_id: row.id, p_owner: owner, p_asset: result.asset.id, p_hash: hash, p_width: metadata.width, p_height: metadata.height }) !== true) throw new Error('Image rendition ownership expired; its original remains unchanged.');
  return { ...result, rendition: { id: row.id, sourceAssetId: id, sourceHash: original.hash, preset: input.preset, recipeHash, width: metadata.width, height: metadata.height, cached: false } };
}
