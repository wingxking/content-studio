import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { Account } from '../src/core/model.ts';
import type { EcosystemRoute } from '../src/core/publishing-ecosystem.ts';
import { DraftConnections, DraftIdentityCard, PublishingEcosystem } from '../src/ui/draft-connections.tsx';

const account = (platform: Account['platform'], provider: Account['provider'] = 'native'): Account => ({ id: randomUUID(), platform, provider, label: `${platform} ${provider}`, integrationId: '', status: 'connected', note: 'Isolated UI fixture', verifiedAt: null });

test('draft identity binding requires explicit permission and offers only matching native accounts', () => {
  const matching = account('zhihu');
  const accounts = [matching, account('wechat'), account('zhihu', 'postiz')];
  const html = renderToStaticMarkup(createElement(DraftIdentityCard, { identity: { platform: 'zhihu', isAuthenticated: true, userId: 'actual-platform-id', username: 'Detected author' }, accounts, connected: true, disabled: false, onConnect: async () => {} }));
  const { document } = parseHTML(html);
  assert.match(html, /actual-platform-id/);
  assert.deepEqual([...document.querySelectorAll('option')].map(option => option.getAttribute('value')), ['', matching.id]);
  assert.equal(document.querySelector('input[type="checkbox"]')?.hasAttribute('checked'), false);
  assert.equal(document.querySelector('button')?.hasAttribute('disabled'), true);
  assert.match(html, /不代表平台审批通过，也不授权公开发布/);
});

test('draft binding remains unavailable without both a connected extension and authenticated identity', () => {
  for (const state of [{ connected: false, isAuthenticated: true, userId: 'actual-id' }, { connected: true, isAuthenticated: false, userId: 'actual-id' }, { connected: true, isAuthenticated: true, userId: undefined }]) {
    const html = renderToStaticMarkup(createElement(DraftIdentityCard, { identity: { platform: 'wechat', isAuthenticated: state.isAuthenticated, userId: state.userId }, accounts: [], connected: state.connected, disabled: false, onConnect: async () => {} }));
    const { document } = parseHTML(html);
    assert.equal(document.querySelector('button')?.hasAttribute('disabled'), true);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
  }
});

test('saved draft binding is displayed only for the detected platform identity', () => {
  const bound = { ...account('zhihu'), draftConnection: { adapter: 'wechatsync' as const, userId: 'bound-author', extensionId: 'a'.repeat(32), checkedAt: new Date().toISOString(), permissionConfirmed: true as const } };
  const render = (userId: string, extensionId = bound.draftConnection.extensionId) => renderToStaticMarkup(createElement(DraftIdentityCard, { identity: { platform: 'zhihu', isAuthenticated: true, userId }, accounts: [bound], connected: true, extensionId, disabled: false, onConnect: async () => {} }));
  assert.match(render('bound-author'), /已启用草稿保存/);
  assert.doesNotMatch(render('different-author'), /已启用草稿保存/);
  assert.doesNotMatch(render('bound-author', 'b'.repeat(32)), /已启用草稿保存/);
  assert.match(render('bound-author', 'b'.repeat(32)), /需重新核对账号与扩展/);
});

test('pairing form masks credentials and never initially renders a private connection URL', () => {
  const html = renderToStaticMarkup(createElement(DraftConnections, { accounts: [], busy: false, action: async () => {} }));
  const { document } = parseHTML(html);
  const password = document.querySelector('input[type="password"]');
  assert.ok(password);
  assert.equal(password.getAttribute('value'), '');
  assert.equal(password.getAttribute('autoComplete') ?? password.getAttribute('autocomplete'), 'off');
  assert.equal(document.querySelector('textarea'), null);
  assert.equal(document.querySelectorAll('.capability-grid > article').length, 3);
  assert.equal(document.querySelector('select option[selected]')?.getAttribute('value'), 'zhihu');
  assert.match(html, /本轮仅核对知乎，未检查其他平台/);
  assert.equal([...document.querySelectorAll('.capability-grid .badge')].filter(badge => badge.textContent === '未核对本平台').length, 3);
});

test('an unchecked platform cannot reuse a previously detected identity for binding', () => {
  const html = renderToStaticMarkup(createElement(DraftIdentityCard, { identity: { platform: 'wechat', isAuthenticated: true, userId: 'previous-account' }, accounts: [], connected: true, checked: false, disabled: false, onConnect: async () => {} }));
  const { document } = parseHTML(html);
  assert.match(html, /未核对本平台/); assert.match(html, /本轮没有访问此平台/);
  assert.equal(document.querySelector('button')?.hasAttribute('disabled'), true);
  assert.equal(document.querySelector('input[type="checkbox"]'), null);
});

test('authentication check errors are displayed as unavailable rather than signed out', () => {
  for (const errorCode of ['timeout', 'check_failed'] as const) {
    const html = renderToStaticMarkup(createElement(DraftIdentityCard, { identity: { platform: 'zhihu', isAuthenticated: false, errorCode, error: '安全的核对诊断。' }, accounts: [], connected: true, disabled: false, onConnect: async () => {} }));
    const { document } = parseHTML(html);
    assert.match(html, errorCode === 'timeout' ? /身份核对超时/u : /身份核对不可用/u);
    assert.match(html, /不代表账号已经退出登录/u); assert.doesNotMatch(html, /待登录或连接|请登录目标创作者账号/u);
    assert.equal(document.querySelector('button')?.hasAttribute('disabled'), true);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
  }
});

test('ecosystem catalog distinguishes provider drafts from unfinished integrations', () => {
  const routes: EcosystemRoute[] = [{ id: 'provider-test', name: 'Provider review drafts', kind: 'provider_draft', status: 'requires_integration', platforms: ['linkedin'], docsUrl: 'https://example.org/docs', setupSteps: ['Connect the actual account.'], limitations: ['Drafts are stored by the provider, not in the platform editor.'] }];
  const html = renderToStaticMarkup(createElement(PublishingEcosystem, { routes }));
  assert.match(html, /服务商审稿草稿/);
  assert.match(html, /尚需完成适配接入/);
  assert.match(html, /Drafts are stored by the provider, not in the platform editor/);
  assert.doesNotMatch(html, /<button/);
});
