import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type { Variant } from '../src/core/model.ts';
import { NativeDraftFormatField } from '../src/ui/editor-panel.tsx';

const variant = (platform: Variant['platform'], format?: Variant['format']): Variant => ({ platform, format, title: 'Reviewed article', text: 'Reviewed text', tags: [], mediaPaths: [] });
function render(value: Variant) {
  const html = renderToStaticMarkup(createElement(NativeDraftFormatField, { variant: value, disabled: false, onChange: () => assert.fail('Rendering must not mutate the saved format.') }));
  return parseHTML(html).document;
}

test('legacy native draft formats require explicit selection without silently selecting an article', () => {
  for (const platform of ['wechat', 'zhihu', 'bilibili'] as const) {
    const blank = render(variant(platform));
    assert.equal(blank.querySelector('option[selected]')?.getAttribute('value'), '');
    assert.ok(blank.querySelector('option[value="article"]'));
    const legacy = render(variant(platform, 'text'));
    assert.equal(legacy.querySelector('option[selected]')?.getAttribute('value'), 'text');
    assert.equal(render(variant(platform, 'article')).querySelector('option[selected]')?.getAttribute('value'), 'article');
  }
});

test('Bilibili preserves video format and exposes article and video as separate choices', () => {
  const document = render(variant('bilibili', 'video'));
  assert.equal(document.querySelector('option[selected]')?.getAttribute('value'), 'video');
  assert.deepEqual([...document.querySelectorAll('option')].map(option => option.getAttribute('value')), ['', 'article', 'video']);
  assert.equal(render(variant('wechat')).querySelector('option[value="video"]'), null);
  assert.equal(render(variant('x')).querySelector('select'), null);
});
