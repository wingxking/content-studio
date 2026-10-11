import { createReadStream } from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { resolveAssetPath, uploadAssetStream } from './assets.ts';
export const imageRecipeSchema = z.object({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096), fit: z.enum(['cover', 'contain', 'inside']).default('cover'), format: z.enum(['png', 'jpeg', 'webp']).default('webp'), quality: z.number().int().min(40).max(100).default(85) }).strict();
export async function adaptArticleImage(id: string, value: unknown) {
  const recipe = imageRecipeSchema.parse(value); const path = await resolveAssetPath(z.uuid().parse(id));
  const metadata = await sharp(path, { limitInputPixels: 40 * 1024 * 1024 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Image adaptation requires a single PNG, JPEG or WebP frame.');
  const transform = sharp({ limitInputPixels: 40 * 1024 * 1024 }).rotate().resize(recipe.width, recipe.height, { fit: recipe.fit, withoutEnlargement: recipe.fit === 'inside' });
  if (recipe.format === 'jpeg') transform.jpeg({ quality: recipe.quality });
  else if (recipe.format === 'webp') transform.webp({ quality: recipe.quality }); else transform.png();
  return uploadAssetStream(`Image-${id.slice(0, 8)}-${recipe.width}x${recipe.height}.${recipe.format}`, createReadStream(path).pipe(transform));
}
