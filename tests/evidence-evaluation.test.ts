import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEvidenceEvaluation } from './evidence-evaluation.ts';

test('fixed evidence evaluation separates 80 development and 20 holdout cases across ten failure families', async () => {
  const { suite, hash } = await loadEvidenceEvaluation();
  assert.equal(suite.cases.length, 100); assert.equal(new Set(suite.cases.map(item => item.id)).size, 100);
  assert.equal(suite.cases.filter(item => item.split === 'holdout').length, 20);
  assert.equal(new Set(suite.cases.map(item => item.category)).size, 10);
  assert.match(hash, /^[a-f0-9]{64}$/u);
  for (const item of suite.cases) for (const key of item.gold.retrievalKeys) assert.ok(item.sources.some(source => source.key === key));
});
