import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdaptation } from '../src/core/editor.ts';
import { detectMedia } from '../src/core/assets.ts';
import type { Variant } from '../src/core/model.ts';
const base: Variant = { platform: 'x', title: 'Base', text: 'Original fact', tags: ['one'], mediaPaths: ['/local/image.png'] };
test('master adaptation refreshes untouched fields and preserves independent platform edits and real media', () => {
  const local: Variant = { ...base, text: 'My independent explanation' };
  const next: Variant = { ...base, title: 'New master title', text: 'New explanation', tags: ['two'], mediaPaths: [] };
  const result = mergeAdaptation(base, local, next);
  assert.equal(result.variant.title, 'New master title');
  assert.equal(result.variant.text, 'My independent explanation');
  assert.deepEqual(result.variant.tags, ['two']);
  assert.deepEqual(result.variant.mediaPaths, ['/local/image.png']);
  assert.deepEqual(result.conflicts, ['x.text']);
});
test('legacy content without a baseline is never silently overwritten by adaptation', () => {
  const result = mergeAdaptation(undefined, base, { ...base, text: 'Replace everything', title: 'Changed' });
  assert.deepEqual(result.variant, base); assert.deepEqual(result.conflicts, ['x.title', 'x.text']);
});
test('uploaded media is identified by bytes, not a misleading extension', () => {
  assert.throws(() => detectMedia(Buffer.from('<script>fake image</script>')), /media|PNG|JPEG|WebP/i);
  assert.equal(detectMedia(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])).mime, 'image/png');
});

test('Product Hunt master synchronization updates untouched launch data and protects manual launch edits', () => {
  const launch = { url: 'https://product.example/', name: 'Product', tagline: 'Original tagline', description: 'Original description', firstComment: 'Original maker comment' };
  const before: Variant = { ...base, platform: 'producthunt', format: 'product_launch', launch };
  const incoming: Variant = { ...before, launch: { ...launch, description: 'Updated description' } };
  assert.deepEqual(mergeAdaptation(before, before, incoming).variant.launch, incoming.launch);
  const local: Variant = { ...before, launch: { ...launch, firstComment: 'Personally edited maker comment' } };
  const result = mergeAdaptation(before, local, incoming);
  assert.deepEqual(result.variant.launch, local.launch); assert.ok(result.conflicts.includes('producthunt.launch'));
});
