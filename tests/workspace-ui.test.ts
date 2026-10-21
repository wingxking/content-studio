import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { draftSchema } from '../src/core/model.ts';
import { videoProjectSchema } from '../src/core/video-model.ts';
import type { VideoProjectView, VideoTargetView } from '../src/contracts/video.ts';
import { readWorkspace, writeWorkspace, workspaceQuery, workspaceDateBoundary, WorkspaceRequestError } from '../src/client/workspace.ts';
import { newTaskInput, TaskForm } from '../src/ui/task-panel.tsx';
import { ArticleReadOnly, DeliveryBatchResults, SavedTaskSchedule } from '../src/ui/workspace-pages.tsx';
import { VideoTargetEditor } from '../src/ui/video-workspace.tsx';
import { MediaPreview } from '../src/ui/media-preview.tsx';
import { readMediaKind } from '../src/client/media.ts';
import { DeliveryOverview, GettingStarted } from '../src/ui/home-page.tsx';
import { publishingCapability } from '../src/core/publishing-capabilities.ts';
import { workspaceSummarySchema } from '../src/contracts/workspace.ts';
import { QualityRefresh, QualityRunProgress } from '../src/ui/research-settings.tsx';
import { ReleaseDetails, RuntimeSwitches } from '../src/ui/setup-panel.tsx';
import { DraftBridgeRecovery, DraftIdentityCard } from '../src/ui/draft-connections.tsx';

function queryRender(element: ReturnType<typeof createElement>, client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })) {
  const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, element)));
  client.clear();
  return { markup, document: parseHTML(markup).document };
}

test('first-use guidance allows content creation before connecting publication accounts', () => {
  const summary = workspaceSummarySchema.parse({ paused: true, schedulerEnabled: false, accounts: [], readiness: { modelReady: true } });
  const { markup, document } = queryRender(createElement(GettingStarted, { summary, hasContent: false }));
  assert.match(markup, /模型已就绪/);
  assert.match(markup, /无需先连接发布账号/);
  assert.ok(document.querySelector('a[href="/tasks/new"]'));
  assert.ok(document.querySelector('a[href="/settings/accounts"]'));
  assert.equal(document.querySelectorAll('button').length, 0, 'checklist must not silently enable publication or scheduling');
});

test('home distinguishes actual draft capability from a connected account and video submission', () => {
  const accounts = (['zhihu', 'youtube'] as const).map(platform => ({ id: randomUUID(), platform, label: 'Creator', provider: 'native' as const, integrationId: platform === 'youtube' ? 'UC-owner' : '', status: 'connected' as const, note: '', verifiedAt: null }));
  const summary = workspaceSummarySchema.parse({ paused: true, schedulerEnabled: false, accounts, readiness: { modelReady: true } });
  const unbound = publishingCapability('zhihu', 'article', accounts[0]);
  const video = publishingCapability('youtube', 'video', accounts[1], { expectedYoutubeChannel: 'UC-owner' });
  const initial = queryRender(createElement(DeliveryOverview, { summary, capabilities: [unbound, video] }));
  assert.match(initial.markup, /复制内容，平台手动发布/);
  assert.match(initial.markup, /系统提交/);
  assert.doesNotMatch(initial.markup, /同步草稿，平台手动发布/);
  const paired = queryRender(createElement(DeliveryOverview, { summary, capabilities: [{ ...unbound, remoteDraft: true }, video] }));
  assert.match(paired.markup, /同步草稿，平台手动发布/);
  assert.match(paired.markup, /保存平台草稿后仍需在平台确认发布/);
  const unavailable = queryRender(createElement(DeliveryOverview, { summary, error: new Error('offline') }));
  assert.match(unavailable.markup, /暂时无法读取平台能力/);
  assert.doesNotMatch(unavailable.markup, /复制内容，平台手动发布/);
});

test('quality regeneration requires saved edits and describes its revision effect before submission', () => {
  const props = { draftId: randomUUID(), revision: 2 };
  const saved = queryRender(createElement(QualityRefresh, props));
  const editing = queryRender(createElement(QualityRefresh, { ...props, contentDirty: true }));
  assert.equal(saved.document.querySelector('button')?.hasAttribute('disabled'), false);
  assert.equal(editing.document.querySelector('button')?.hasAttribute('disabled'), true);
  assert.match(saved.markup, /保留当前修订，按原任务要求重新研究并生成新修订/);
  assert.match(saved.markup, /完成后需重新审批。不会自动发布/);
  assert.match(editing.markup, /请先保存当前编辑/);
});

test('runtime controls separate production and publication and cannot act on unknown state', () => {
  const props = { busy: false, onScheduler: () => {}, onPublishing: () => {} };
  const paused = queryRender(createElement(RuntimeSwitches, { ...props, schedulerEnabled: false, publishingPaused: true }));
  assert.equal(paused.document.querySelector('[aria-label="定时生产"] button')?.textContent, '启用定时生产');
  assert.equal(paused.document.querySelector('[aria-label="公开发布"] button')?.textContent, '恢复公开发布');
  assert.match(paused.markup, /已批准且到期的交付/);
  assert.match(paused.markup, /不会因此自动获得公开发布授权/);
  const unknown = queryRender(createElement(RuntimeSwitches, { ...props, schedulerEnabled: null, publishingPaused: null }));
  assert.equal(unknown.document.querySelectorAll('button:disabled').length, 2);
  assert.doesNotMatch(unknown.markup, /启用定时生产|恢复公开发布|已暂停|已启用/);
  assert.equal(unknown.document.querySelectorAll('a[href],form[action]').length, 0);
});

test('read-only content detail has snapshots and navigation but no editable or delivery controls', () => {
  const now = new Date().toISOString();
  const draft = draftSchema.parse({ id: randomUUID(), brief: { topic: 'Software revisions', audience: 'Developers', angle: 'Save immutable snapshots', sources: [{ title: 'Reference', url: 'https://example.com', excerpt: 'Use stable revisions.' }], platforms: ['zhihu'] }, title: 'Stable revisions', body: 'Read this revision.', variants: [{ platform: 'zhihu', title: 'Platform version', text: 'Platform immutable content.', tags: [], mediaPaths: [] }], revision: 2, createdAt: now, approvedHash: null });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['workspace', 'article-history', draft.id], { history: [{ revision: 1, title: 'Earlier revision', body: 'Earlier immutable bytes.', createdAt: now, variants: [{ platform: 'zhihu', title: 'Earlier Zhihu title', text: 'Earlier Zhihu platform bytes.', tags: [], mediaPaths: [] }] }] });
  const { markup, document } = queryRender(createElement(ArticleReadOnly, { draft, jobs: [] }), client);
  assert.match(markup, /Read this revision/);
  assert.match(markup, /Earlier immutable bytes/);
  assert.match(markup, /Earlier Zhihu platform bytes/);
  assert.equal(document.querySelectorAll('button,input,textarea,select').length, 0);
  assert.ok(document.querySelector(`a[href="/distribution?articleId=${draft.id}"]`));
});

test('new discovery task has compact structured defaults and explicit draft-only automation', () => {
  const input = newTaskInput('discovery');
  assert.equal(input.frequency.timezone, 'Asia/Singapore');
  assert.deepEqual(input.discoveryConfig, { countries: [], freshnessHours: 24, maxQuestions: 5 });
  assert.deepEqual(input.draftSync, { enabled: false, accountIds: [] });
  const { markup, document } = queryRender(createElement(TaskForm, { input, editing: false, accounts: [], models: [{ id: 'fixture-model', name: 'Fixture model', description: '' }], assets: [], busy: false, onUpload: () => {}, onSubmit: async () => {} }));
  assert.match(markup, /关注什么|国家／地区|热点时效/);
  assert.equal([...document.querySelectorAll('button')].filter(button => button.textContent?.includes('发布')).length, 0);
});

test('new content keeps research defaults while optional source configuration starts collapsed', () => {
  const input = newTaskInput('content'); input.prompt = '解释软件版本如何安全回退'; input.pipelineVersion = 2;
  const { document } = queryRender(createElement(TaskForm, { input, editing: false, accounts: [], models: [{ id: input.model, name: input.model, description: '' }], assets: [], busy: false, onUpload: () => {}, onSubmit: async () => {} }));
  const sources = [...document.querySelectorAll('summary')].find(item => item.textContent?.startsWith('调整来源与研究设置'))?.parentElement;
  assert.ok(sources);
  assert.equal(sources.hasAttribute('open'), false);
  assert.ok(document.querySelector('textarea[required]'));
  assert.ok([...document.querySelectorAll('button')].find(item => item.textContent === '保存并立即运行' && !item.closest('details')));
});

test('model outage permits saving an existing plan while withholding execution', () => {
  const input = newTaskInput('content'); input.model = 'previous-model'; input.prompt = '保留并停用已有生产计划'; input.enabled = false;
  const render = (editing: boolean) => queryRender(createElement(TaskForm, { input, editing, accounts: [], models: [], assets: [], busy: false, onUpload: () => {}, onSubmit: async () => {} }));
  const existing = render(true);
  assert.equal(existing.document.querySelector('button[value="save"]')?.hasAttribute('disabled'), false);
  assert.equal(existing.document.querySelector('button[value="run"]')?.hasAttribute('disabled'), true);
  assert.equal(existing.document.querySelector('option[value="previous-model"]')?.textContent, 'previous-model（当前不可用）');
  assert.match(existing.markup, /仍可保存配置或停用计划/);
  assert.equal(render(false).document.querySelector('button[value="save"]')?.hasAttribute('disabled'), true);
  const scheduleToggle = [...existing.document.querySelectorAll('label')].find(label => label.textContent === '启用此任务的定时计划');
  assert.ok(scheduleToggle?.querySelector('input[type="checkbox"]'));
  assert.equal(scheduleToggle?.closest('details'), null);
});

test('saved schedule distinguishes a per-task plan from the paused global scheduler', () => {
  const task = { id: randomUUID(), enabled: true, frequency: { type: 'daily' as const, time: '09:00', timezone: 'Asia/Singapore' }, nextRunAt: '2026-10-20T01:00:00.000Z' };
  const { markup, document } = queryRender(createElement(SavedTaskSchedule, { task, schedulerEnabled: false }));
  assert.match(markup, /计划已启用/);
  assert.match(markup, /定时生产总开关已暂停/);
  assert.match(markup, /计划下次生产/);
  assert.ok(document.querySelector(`a[href="/history?taskId=${task.id}"]`));
  assert.equal(document.querySelectorAll('button').length, 0);
});

test('failed quality research continues the same run and active research never offers another retry', () => {
  const run = { id: randomUUID(), status: 'failed' as const, progress: 45, error: 'Model unavailable' };
  const failed = queryRender(createElement(QualityRunProgress, { run, busy: false, onRetry: () => {} }));
  assert.match(failed.markup, /继续同一次研究并保留已完成步骤/);
  assert.equal(failed.document.querySelector('button')?.textContent, '继续此次研究');
  assert.ok(failed.document.querySelector(`a[href="/history?runId=${run.id}"]`));
  const active = queryRender(createElement(QualityRunProgress, { run: { ...run, status: 'researching', error: null }, busy: false, onRetry: () => {} }));
  assert.equal(active.document.querySelectorAll('button').length, 0);
  const dirty = queryRender(createElement(QualityRunProgress, { run, busy: false, disabled: true, onRetry: () => {} }));
  assert.equal(dirty.document.querySelector('button')?.hasAttribute('disabled'), true);
  assert.doesNotMatch(dirty.markup, /正在继续研究/);
});

test('disconnected draft bridge exposes safe recovery metadata and preserves stored binding context', () => {
  const extensionId = 'a'.repeat(32);
  const recovery = queryRender(createElement(DraftBridgeRecovery, { bridge: { configured: true, connected: false, extensionId, bridgePort: 19527 } }));
  assert.match(recovery.markup, new RegExp(extensionId));
  assert.match(recovery.markup, /19527|核对已有未确认任务|复制或导出文稿/);
  assert.equal(recovery.document.querySelectorAll('button,input').length, 0);
  const account = { id: randomUUID(), platform: 'zhihu' as const, label: 'Stored author', provider: 'native' as const, integrationId: '', status: 'connected' as const, note: '', verifiedAt: null, draftConnection: { adapter: 'wechatsync' as const, userId: 'stored-uid', extensionId, checkedAt: new Date().toISOString(), permissionConfirmed: true as const } };
  const card = queryRender(createElement(DraftIdentityCard, { identity: { platform: 'zhihu', isAuthenticated: false }, accounts: [account], connected: false, checked: false, disabled: false, onConnect: async () => {} }));
  assert.match(card.markup, /已保存绑定：Stored author/);
  assert.match(card.markup, /连接中断不能证明平台已经退出登录/);
  assert.equal(card.document.querySelector('button')?.hasAttribute('disabled'), true);
});

test('runtime version metadata shows immutable release identity and honest unavailable state', () => {
  const { markup, document } = queryRender(createElement(ReleaseDetails, { release: { version: '20261019-unified-v15', builtAt: '2026-10-19T00:00:00.000Z', sourceDigest: 'b'.repeat(64) } }));
  assert.match(markup, /20261019-unified-v15/);
  assert.equal(document.querySelector('code')?.textContent, 'b'.repeat(12));
  assert.match(queryRender(createElement(ReleaseDetails, {})).markup, /版本信息暂不可用/);
});

test('Bilibili target only offers manual delivery when official capability is unavailable', () => {
  const now = new Date().toISOString();
  const raw = videoProjectSchema.parse({ id: randomUUID(), version: 1, createdAt: now, updatedAt: now, brief: { topic: 'Software workflow', audience: 'Creators', instruction: '', platform: 'youtube', sources: [] }, revision: 1, revisions: [{ number: 1, createdAt: now, content: null, settings: {}, sourceArticle: null, assessment: null }], proposals: [], renders: [], status: 'editing', approval: null, deliveryApproval: null });
  const target: VideoTargetView = { id: randomUUID(), platform: 'bilibili', revision: 1, sourceRevision: 1, accountId: null, renderId: null, title: 'Bilibili copy', text: 'Independent platform wording', tags: [], deliverySettings: {}, approval: null, capability: { automatic: false, remoteDraft: false, reason: 'Official app permission required.' } };
  const project: VideoProjectView = { ...raw, targets: [target], renders: [] };
  const { markup, document } = queryRender(createElement(VideoTargetEditor, { project, target, accounts: [] }));
  assert.match(markup, /Independent platform wording|Official app permission required/);
  assert.ok([...document.querySelectorAll('input[type="checkbox"]')].find(input => input.hasAttribute('disabled')));
  assert.ok([...document.querySelectorAll('button')].find(button => button.textContent === '审核并创建手动发布包')?.hasAttribute('disabled'));
});

test('workspace reads validate schema, support cancellation, and preserve HTTP conflicts', async () => {
  const original = globalThis.fetch; const controller = new AbortController(); let receivedSignal: AbortSignal | null | undefined;
  try {
    globalThis.fetch = async (input, init) => { assert.equal(String(input), '/api/workspace/summary'); receivedSignal = init?.signal; return new Response(JSON.stringify({ count: 'bad' }), { status: 200 }); };
    await assert.rejects(readWorkspace('summary', z.object({ count: z.number() }), controller.signal), /number/);
    assert.equal(receivedSignal, controller.signal);
    globalThis.fetch = async (_input, init) => { assert.equal(init?.method, 'POST'); return new Response(JSON.stringify({ error: 'Revision changed' }), { status: 409 }); };
    await assert.rejects(writeWorkspace('deliveries/batch', { commandId: randomUUID() }, z.object({ ok: z.boolean() })), error => error instanceof WorkspaceRequestError && error.status === 409);
    assert.equal(workspaceDateBoundary('2026-10-15'), '2026-10-14T16:00:00.000Z');
    assert.equal(workspaceDateBoundary('2026-10-15', true), '2026-10-15T15:59:59.999Z');
    assert.equal(workspaceQuery({ kind: 'article', cursor: 'a+b/=', empty: undefined }), '?kind=article&cursor=a%2Bb%2F%3D');
  } finally { globalThis.fetch = original; }
});

test('stable article and asset references preview their actual media MIME rather than guessing from IDs', async () => {
  const reference = `studio-article-media:${randomUUID()}:1:youtube:0`;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['media-preview', reference], 'video');
  const { document } = queryRender(createElement(MediaPreview, { reference, alt: 'Legacy video' }), client);
  assert.equal(document.querySelectorAll('video').length, 1); assert.equal(document.querySelectorAll('img').length, 0);
  assert.equal(document.querySelector('video')?.getAttribute('src'), `/api/media?path=${encodeURIComponent(reference)}`);
  const fetcher = globalThis.fetch; const controller = new AbortController();
  try {
    globalThis.fetch = async (url, init) => { assert.equal(url, `/api/media?path=${encodeURIComponent(reference)}`); assert.equal(init?.method, 'HEAD'); assert.equal(init.signal, controller.signal); return new Response(null, { headers: { 'Content-Type': 'image/webp' } }); };
    assert.equal(await readMediaKind(reference, controller.signal), 'image');
  } finally { globalThis.fetch = fetcher; }
});

test('video delivery cannot approve the saved render while shared script edits remain unsaved', () => {
  const at = new Date().toISOString(); const renderId = randomUUID();
  const raw = videoProjectSchema.parse({ id: randomUUID(), version: 1, createdAt: at, updatedAt: at, brief: { topic: 'Software workflow', audience: 'Creators', instruction: '', platform: 'youtube', sources: [] }, revision: 1, revisions: [{ number: 1, createdAt: at, content: null, settings: {}, sourceArticle: null, assessment: null }], proposals: [], renders: [], status: 'editing', approval: null, deliveryApproval: null });
  const target: VideoTargetView = { id: randomUUID(), platform: 'bilibili', revision: 1, sourceRevision: 1, accountId: randomUUID(), renderId, title: 'Platform wording', text: 'Saved wording', tags: [], deliverySettings: {}, approval: null, capability: { automatic: false, remoteDraft: false, reason: null } };
  const project: VideoProjectView = { ...raw, targets: [target], renders: [{ id: renderId, revision: 1, inputHash: 'a'.repeat(64), status: 'succeeded', owner: randomUUID(), attempt: 1, phase: 'Completed', startedAt: at, heartbeatAt: at, finishedAt: at, error: null, output: { hash: 'b'.repeat(64), width: 1920, height: 1080, duration: 2, reusedStages: 0, mediaUrl: '/api/video/render', captionsUrl: null } }] };
  const button = (dirty: boolean) => [...queryRender(createElement(VideoTargetEditor, { project, target, accounts: [], contentDirty: dirty })).document.querySelectorAll('button')].find(item => item.textContent === '审核并创建手动发布包');
  assert.equal(button(false)?.hasAttribute('disabled'), false);
  assert.equal(button(true)?.hasAttribute('disabled'), true);
});

test('mixed batch results distinguish same-name accounts and link to each platform version', () => {
  const articleId = randomUUID(); const accounts = (['zhihu', 'wechat'] as const).map(platform => ({ id: randomUUID(), platform, label: 'Same creator', provider: 'native' as const, integrationId: '', status: 'blocked' as const, note: '', verifiedAt: null }));
  const result = { batchId: randomUUID(), items: accounts.map((account, index) => ({ articleId, accountId: account.id, status: index ? 'blocked' as const : 'accepted' as const, jobId: null, error: index ? 'No version for this target.' : null })) };
  const { markup, document } = queryRender(createElement(DeliveryBatchResults, { result, accounts, params: new URLSearchParams() }));
  assert.match(markup, /知乎 · Same creator/u); assert.match(markup, /微信公众号 · Same creator/u);
  const urls = [...document.querySelectorAll('a')].map(link => new URL(link.getAttribute('href')!, 'http://localhost/distribution'));
  assert.deepEqual(urls.map(url => url.searchParams.get('platform')), ['zhihu', 'wechat']);
  assert(urls.every(url => url.searchParams.get('articleId') === articleId));
});


test('automatic task form separates production/publication and exposes grant and brand controls', () => {
  const input = newTaskInput('content'); input.frequency = { type: 'daily', time: '09:00', timezone: 'Asia/Singapore' };
  input.pipelineVersion=1; input.platforms=['x']; const account={id:randomUUID(),platform:'x' as const,label:'Fixture',provider:'postiz' as const,integrationId:'fixture',status:'connected' as const,note:'fixture',verifiedAt:null};
  input.delivery = { mode: 'automatic', accountIds: [account.id], publicationTime: '18:00', dayOffset: 0, authorized: false };
  const { markup, document } = queryRender(createElement(TaskForm, { input, editing: false, accounts: [account], models: [{ id: 'fixture-model', name: 'Fixture model', description: '' }], assets: [], busy: false, onUpload: () => {}, onSubmit: async () => {} }));
  assert.deepEqual(newTaskInput('content').platforms, ['wechat', 'zhihu', 'bilibili']);
  assert.match(markup, /生产时间与发布时间分别设置|到点未就绪转待处理|修改配置后需重新勾选授权/);
  assert.equal(document.querySelectorAll('input[type="time"]').length, 2);
  assert.ok([...document.querySelectorAll('input[type="checkbox"]')].some(element => element.hasAttribute('required')));
  assert.match(markup, /品牌语气与封面规范/);
});
