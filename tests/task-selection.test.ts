import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskFromQuestion } from '../src/core/task-selection.ts';
import { hotQuestionSchema, taskInputSchema, taskSchema } from '../src/core/task-model.ts';

const source = { title: 'Verified source', url: 'https://example.org/verified', excerpt: 'Verified source excerpt retained for further research.' };
const snapshot = taskSchema.parse({
  id: 'b24f8c0a-a953-4bdd-9e81-ffec8171a099', title: 'Discovery fixture', prompt: 'Discover useful software topics.', audience: '', angle: '',
  model: 'selected-model', platforms: ['reddit', 'youtube'], sources: [], assetIds: ['5bfe9241-5c48-4784-974a-3d95e0b2c96c'],
  kind: 'discovery', topicOrigin: 'trend', enabled: true, frequency: { type: 'weekly', time: '15:00', timezone: 'Asia/Singapore', weekdays: [1] },
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', nextRunAt: null,
});

test('every maximum-size discovery candidate becomes a valid task without losing full generation context', () => {
  const question = hotQuestionSchema.parse({ question: 'Q'.repeat(1000), audienceNeed: 'A'.repeat(2000), angle: 'B'.repeat(4000), sourceUrls: [source.url], platforms: ['reddit'], assessment: { status: 'allowed', reasons: ['Useful verified software evidence.'] } });
  const input = taskFromQuestion(question, snapshot, [source, { ...source, url: 'https://example.org/unused' }], 'America/New_York');
  assert.doesNotThrow(() => taskInputSchema.parse(input));
  assert.equal(input.title.length, 200); assert.equal(input.audience.length, 1000);
  assert.ok(input.prompt.includes(question.question)); assert.ok(input.prompt.includes(question.audienceNeed)); assert.ok(input.prompt.includes(question.angle));
  assert.equal(input.angle, question.angle); assert.deepEqual(input.sources, [source]); assert.deepEqual(input.platforms, ['reddit']);
  assert.equal(input.model, snapshot.model); assert.deepEqual(input.assetIds, snapshot.assetIds); assert.equal(input.topicOrigin, 'trend');
  assert.deepEqual(input.frequency, { type: 'once', time: '09:00', timezone: 'America/New_York' }); assert.equal(input.kind, 'content');
});

test('candidate labels never end with a split surrogate and missing excerpts remain fetchable', () => {
  const question = hotQuestionSchema.parse({ question: `${'Q'.repeat(199)}😀 full question`, audienceNeed: `${'A'.repeat(999)}😀 full audience`, angle: 'Practical explanation', sourceUrls: [source.url], platforms: ['youtube'], assessment: { status: 'allowed', reasons: ['Verified useful question.'] } });
  const input = taskFromQuestion(question, snapshot, [], 'Asia/Singapore');
  assert.equal(input.title, 'Q'.repeat(199)); assert.equal(input.audience, 'A'.repeat(999));
  assert.ok(input.prompt.includes(question.question)); assert.ok(input.prompt.includes(question.audienceNeed));
  assert.deepEqual(input.sources, [{ title: '', url: source.url, excerpt: '' }]);
});
