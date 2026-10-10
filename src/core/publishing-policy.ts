import { type Account, type Draft } from './model.ts';

export function assertAutomatedPublishingAllowed(draft: Draft, account: Account): void {
  if (account.platform !== 'x' || account.provider !== 'postiz') return;
  const trendOrigin = draft.brief.topicOrigin === 'trend' || draft.brief.sources.some(source => new URL(source.url).hostname === 'trends.google.com');
  if (trendOrigin) throw new Error('X prohibits automated posts about trending topics. Use a genuine human review and manual native publication, or choose an editorial topic unrelated to trends.');
}
