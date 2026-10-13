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
});

test('ecosystem catalog distinguishes provider drafts from unfinished integrations', () => {
  const routes: EcosystemRoute[] = [{ id: 'provider-test', name: 'Provider review drafts', kind: 'provider_draft', status: 'requires_integration', platforms: ['linkedin'], docsUrl: 'https://example.org/docs', setupSteps: ['Connect the actual account.'], limitations: ['Drafts are stored by the provider, not in the platform editor.'] }];
  const html = renderToStaticMarkup(createElement(PublishingEcosystem, { routes }));
  assert.match(html, /服务商审稿草稿/);
  assert.match(html, /尚需完成适配接入/);
  assert.match(html, /Drafts are stored by the provider, not in the platform editor/);
  assert.doesNotMatch(html, /<button/);
});
