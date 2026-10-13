import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { accountSchema, platformIds } from '../src/core/model.ts';
import { priorityPlatforms, publishingCapabilities } from '../src/core/publishing-capabilities.ts';
import { CapabilityGrid } from '../src/ui/capabilities-panel.tsx';
import { labels } from '../src/ui/api.ts';

test('capability grid renders every platform for each pipeline with priority platforms first', () => {
  const capabilities = publishingCapabilities([]);
  for (const kind of ['article', 'video'] as const) {
    const html = renderToStaticMarkup(createElement(CapabilityGrid, { capabilities, kind, accounts: [], busy: false, action: async () => {} }));
    const { document } = parseHTML(html);
    const cards = [...document.querySelectorAll('.capability-grid > article')];
    const headings = cards.map(card => card.querySelector('h3')?.textContent);
    assert.equal(cards.length, platformIds.length);
    assert.deepEqual(headings.slice(0, priorityPlatforms.length), priorityPlatforms.map(platform => labels[platform]));
    assert.deepEqual([...headings].sort(), platformIds.map(platform => labels[platform]).sort());
    assert.ok(headings.includes('YouTube'));
    assert.ok(headings.includes('LinkedIn'));
  }
});

test('capability cards distinguish connected native drafts from Postiz review drafts and public delivery', () => {
  const extensionId = 'a'.repeat(32);
  const native = accountSchema.parse({ id: randomUUID(), platform: 'zhihu', provider: 'native', label: 'Native author', integrationId: '', status: 'connected', note: '', verifiedAt: null, draftConnection: { adapter: 'wechatsync', userId: 'author', extensionId, checkedAt: new Date().toISOString(), permissionConfirmed: true } });
  const provider = accountSchema.parse({ id: randomUUID(), platform: 'linkedin', provider: 'postiz', label: 'Provider author', integrationId: 'linkedin-id', status: 'connected', note: '', verifiedAt: new Date().toISOString() });
  const accounts = [native, provider];
  const capabilities = publishingCapabilities(accounts, { postizConfigured: true, draftBridgeConnected: true, draftBridgeExtensionId: extensionId });
  const html = renderToStaticMarkup(createElement(CapabilityGrid, { capabilities, kind: 'article', accounts, busy: false, action: async () => {} }));
  const { document } = parseHTML(html);
  const cards = [...document.querySelectorAll('.capability-grid > article')];
  const nativeText = cards.find(card => card.querySelector('h3')?.textContent === labels.zhihu)?.textContent ?? '';
  const providerText = cards.find(card => card.querySelector('h3')?.textContent === labels.linkedin)?.textContent ?? '';
  assert.match(nativeText, /原生草稿：可保存，写入前复核账号/);
  assert.match(nativeText, /自动公开提交：不可用/);
  assert.match(providerText, /原生草稿：未接入自动保存/);
  assert.match(providerText, /服务商草稿：可保存到 Postiz（不是原生草稿）/);
  const defaults = renderToStaticMarkup(createElement(CapabilityGrid, { capabilities: publishingCapabilities(accounts), kind: 'article', accounts, busy: false, action: async () => {} }));
  assert.doesNotMatch(defaults, /草稿可保存 · 发布需人工|原生草稿：可保存|服务商草稿：可保存/);
});
