import test from 'node:test';
import assert from 'node:assert/strict';
import { assertXText, xWeightedLength } from '../src/core/text-limits.ts';
test('X uses Chinese weights and canonical URL lengths', () => {
  assert.equal(xWeightedLength('中'.repeat(140)), 280);
  assert.doesNotThrow(() => assertXText('中'.repeat(140)));
  assert.throws(() => assertXText('中'.repeat(141)), /280 weighted/);
  assert.equal(xWeightedLength('https://example.com/' + 'a'.repeat(400)), 23);
  assert.doesNotThrow(() => assertXText('https://example.com/' + 'a'.repeat(400)));
  assert.equal(xWeightedLength('👨‍👩‍👧‍👦'), 2);
  assert.equal(xWeightedLength('cafe\u0301'), 4);
});
