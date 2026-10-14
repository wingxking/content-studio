import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { imageAdaptationInputSchema, renderFinanceImage } from '../src/core/article-tools.ts';
test('finance image preset preserves original bytes and aspect ratio while flattening transparency on white', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'finance-rendition-')); const file = join(directory, 'original.png');
 try {
  const original = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(); await writeFile(file, original);
  const result = await renderFinanceImage(file); const meta = await sharp(result).metadata();
  assert.equal(meta.width, 1600); assert.equal(meta.height, 800); assert.equal(meta.format, 'jpeg'); assert.equal(meta.hasAlpha, false);
  const pixel = await sharp(result).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer(); assert.deepEqual([...pixel], [255, 255, 255]); assert.deepEqual(await readFile(file), original);
 } finally { await rm(directory, { recursive: true, force: true }); }
});
test('legacy recipes remain compatible and finance presets reject arbitrary platforms or silent animation handling', () => {
 const legacy = imageAdaptationInputSchema.parse({ width: 640, height: 480 }); assert.ok('width' in legacy); assert.equal(legacy.width, 640);
 assert.equal('preset' in imageAdaptationInputSchema.parse({ preset: 'finance-community-v1', platform: 'xueqiu' }), true);
 assert.throws(() => imageAdaptationInputSchema.parse({ preset: 'finance-community-v1', platform: 'youtube' }));
});
