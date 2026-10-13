import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { briefSchema, generatedSchema, platformIds } from '../src/core/model.ts';
import { hotQuestionSchema, taskInputSchema, taskRunSchema } from '../src/core/task-model.ts';
import { buildArticlePrompt, buildDiscoveryPrompt, platformGuidancePrompt } from '../src/core/content-prompts.ts';
import { publishInputSchema } from '../src/core/delivery.ts';

test('all selectable platforms survive task, generation, discovery and publication contracts', () => {
  const sources = [{ title: 'Software evidence', url: 'https://example.org/evidence', excerpt: 'Reviewed source material.' }];
  const task = taskInputSchema.parse({ title: 'Practical software workflow', prompt: 'Explain the supplied evidence.', model: 'test-model', platforms: platformIds, kind: 'content', frequency: { type: 'once', time: '09:00', timezone: 'Asia/Singapore' }, enabled: false });
  const brief = briefSchema.parse({ topic: task.title, audience: 'Software creators', angle: 'Practical steps', sources, platforms: task.platforms });
  const content = generatedSchema.parse({ title: task.title, body: 'Source-backed explanation.', variants: platformIds.map(platform => ({ platform, title: 'Practical steps', text: 'Reviewed explanation.', tags: [], mediaPaths: [] })) });
  const question = hotQuestionSchema.parse({ question: 'How should creators preserve source context?', audienceNeed: 'Reliable explanations', angle: 'Practical steps', sourceUrls: sources.map(source => source.url), platforms: task.platforms, assessment: { status: 'allowed', reasons: ['Permitted software topic.'] } });
  assert.deepEqual(content.variants.map(variant => variant.platform), [...platformIds]);
  assert.deepEqual(taskRunSchema.shape.variants.parse(content.variants), content.variants);
  assert.deepEqual(question.platforms, [...platformIds]);
  assert.doesNotThrow(() => buildArticlePrompt(brief));
  assert.doesNotThrow(() => buildDiscoveryPrompt({ platforms: question.platforms, audience: brief.audience, instruction: task.prompt, sources, maxQuestions: 20 }));
  const guidance = platformGuidancePrompt([...platformIds]);
  for (const platform of platformIds) assert.ok(guidance.includes(`(${platform}):`));
  assert.equal(publishInputSchema.parse({ accountIds: platformIds.map(() => randomUUID()), expectedRevision: 1 }).accountIds.length, platformIds.length);
  assert.equal(taskInputSchema.safeParse({ ...task, platforms: [...platformIds, platformIds[0]] }).success, false);
  assert.equal(generatedSchema.safeParse({ ...content, variants: [...content.variants, content.variants[0]] }).success, false);
});
