import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { accountSchema, draftSchema, jobSchema, type Job, type Variant } from '../src/core/model.ts';
import { isDraftAccountReady, JobPanel, PublishPanel } from '../src/ui/publish-panel.tsx';
import { statusLabel } from '../src/ui/api.ts';

function draftJob(status: Job['status']): Job {
  return jobSchema.parse({ id: randomUUID(), draftId: randomUUID(), accountId: randomUUID(), platform: 'bilibili', provider: 'native', deliveryAction: 'save_draft', approvedHash: 'reviewed-hash', status, scheduledAt: new Date().toISOString(), createdAt: new Date().toISOString(), remoteId: null, remoteUrl: null, attempts: status === 'needs_reconciliation' ? 1 : 0, error: null, history: [] });
}
function renderJob(job: Job) {
  const html = renderToStaticMarkup(createElement(JobPanel, { job, title: 'Reviewed source-backed article', busy: false, action: async () => {} }));
  return { html, document: parseHTML(html).document };
}

test('unknown draft save offers manual draft reconciliation without retry or public publication controls', () => {
  const { html, document } = renderJob(draftJob('needs_reconciliation'));
  assert.match(html, /核对原草稿并保存记录/);
  assert.match(html, /实际草稿 ID/);
  assert.match(html, /实际草稿 URL/);
  assert.equal(document.querySelector('a[href="https://member.bilibili.com/platform/upload/text"]') !== null, true);
  assert.doesNotMatch(html, /继续保存草稿|取消草稿任务|核验后记录发布结果|保存效果记录|继续已中断的上传/);
});

test('saved draft receipt displays destination and verification while remaining separate from public acceptance', () => {
  const job = draftJob('draft_saved');
  job.provider = 'postiz'; job.platform = 'linkedin';
  job.draftReceipt = { destination: 'provider', id: 'provider-draft-id', url: 'https://postiz.example/posts/provider-draft-id', verification: 'adapter_reported' };
  const { html, document } = renderJob(job);
  assert.match(html, /Postiz 审稿草稿/);
  assert.match(html, /已保存草稿 · 未发布/);
  assert.match(html, /适配器返回结果，尚需到草稿箱核对/);
  assert.equal(document.querySelector('a[href="https://postiz.example/posts/provider-draft-id"]') !== null, true);
  assert.doesNotMatch(html, /继续保存草稿|核验后记录发布结果|保存效果记录/);
  assert.equal(statusLabel('draft_saved'), '已保存草稿 · 未发布');
});

test('only a known unsent draft failure exposes continue and cancel actions', () => {
  const job = draftJob('failed');
  const known = renderJob(job).html;
  assert.match(known, /继续保存草稿/);
  assert.match(known, /取消草稿任务/);
  job.providerPostId = 'uncertain-provider-result';
  assert.doesNotMatch(renderJob(job).html, /继续保存草稿|取消草稿任务/);
  job.providerPostId = null;
  job.attempts = 1;
  assert.doesNotMatch(renderJob(job).html, /继续保存草稿|取消草稿任务/);
});

test('native draft selection requires an explicit article format on the matching bound account', () => {
  for (const platform of ['wechat', 'zhihu', 'bilibili'] as const) {
    const account = accountSchema.parse({ id: randomUUID(), platform, provider: 'native', label: 'Verified author', status: 'connected', integrationId: '', note: '', verifiedAt: null, draftConnection: { adapter: 'wechatsync', userId: 'author', extensionId: 'a'.repeat(32), checkedAt: new Date().toISOString(), permissionConfirmed: true } });
    const variant: Variant = { platform, title: 'Reviewed article', text: 'Reviewed text', tags: [], mediaPaths: [] };
    assert.equal(isDraftAccountReady(account, variant), false);
    assert.equal(isDraftAccountReady(account, { ...variant, format: 'video' }), false);
    assert.equal(isDraftAccountReady(account, { ...variant, format: 'article' }), true);
    assert.equal(isDraftAccountReady({ ...account, status: 'blocked' }, { ...variant, format: 'article' }), false);
    assert.equal(isDraftAccountReady({ ...account, draftConnection: undefined }, { ...variant, format: 'article' }), false);
  }
});

test('article delivery exposes separate draft and publish actions and explains Postiz storage', () => {
  const draft = draftSchema.parse({ id: randomUUID(), brief: { topic: 'Software workflow', audience: 'Creators', angle: 'Evidence-backed explanation', sources: [{ title: 'Evidence', url: 'https://example.org', excerpt: 'Reviewed evidence.' }], platforms: ['zhihu'] }, title: 'Reviewed article', body: 'Evidence-backed text.', variants: [{ platform: 'zhihu', title: 'Reviewed article', text: 'Evidence-backed text.', tags: [], mediaPaths: [] }], revision: 1, createdAt: new Date().toISOString(), approvedHash: null });
  const html = renderToStaticMarkup(createElement(PublishPanel, { draft, accounts: [], jobs: [], busy: false, dirty: true, action: async () => {} }));
  const { document } = parseHTML(html);
  const buttons = [...document.querySelectorAll('button')];
  assert.ok(buttons.find(button => button.textContent === '授权并保存当前版本到所选草稿箱')?.hasAttribute('disabled'));
  assert.ok(buttons.find(button => button.textContent === '授权并发布当前版本到所选账号 →')?.hasAttribute('disabled'));
  assert.match(html, /保存在 Postiz，不会写入平台原生草稿箱/);
});
