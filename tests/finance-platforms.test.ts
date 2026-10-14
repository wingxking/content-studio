import assert from 'node:assert/strict';
import { test } from 'node:test';
import { financeCommunityPreview, financePilotDefaults } from '../src/core/finance-platforms.ts';
import { variantSchema, platformIds } from '../src/core/model.ts';
test('finance pilots stay out of default discovery and preserve explicitly named symbols and paragraph order', () => {
 assert.deepEqual(financePilotDefaults, { xueqiu: false, gelonghui: false, guba: false });assert.ok(!(platformIds as readonly string[]).includes('xueqiu'));
 const variant = variantSchema.parse({ platform: 'xueqiu', format: 'image_note', title: 'Original glossary', text: 'First paragraph.\n\nSecond paragraph.', tags: ['glossary'], mediaPaths: [], finance: { symbols: [{ market: 'SH', code: '600000', name: 'Owner-provided name' }] } });
 const preview=financeCommunityPreview(variant);assert.deepEqual(preview.paragraphs,['First paragraph.','Second paragraph.']);assert.equal(preview.symbols[0]?.name,'Owner-provided name');assert.equal(preview.automatic,false);
 assert.throws(()=>financeCommunityPreview({...variant,finance:{symbols:[variant.finance!.symbols[0]!,variant.finance!.symbols[0]!]}}),/once/);
 assert.throws(()=>financeCommunityPreview({...variant,format:'article'}),/Rich articles/);
});
