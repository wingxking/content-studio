import { type Source } from './model.ts';
import { taskInputSchema, type HotQuestion, type Task, type TaskInput } from './task-model.ts';

function label(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
}

export function taskFromQuestion(question: HotQuestion, snapshot: Task, sources: Source[], timezone: string): TaskInput {
  const selectedSources = sources.filter(source => question.sourceUrls.includes(source.url));
  return taskInputSchema.parse({
    ...snapshot,
    title: label(question.question, 200),
    audience: label(question.audienceNeed, 1000),
    angle: question.angle,
    prompt: `${question.question}\n\nAudience need: ${question.audienceNeed}\nRequested angle: ${question.angle}\nResearch the verified sources in depth and generate reviewable master content and destination-specific versions.`,
    platforms: question.platforms.length ? question.platforms : snapshot.platforms,
    sources: selectedSources.length ? selectedSources : question.sourceUrls.map(url => ({ url, title: '', excerpt: '' })),
    kind: 'content',
    topicOrigin: 'trend',
    frequency: { type: 'once', time: '09:00', timezone },
    enabled: true,
  });
}
