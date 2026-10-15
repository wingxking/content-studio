import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { safeMarkdownToHtml } from '../src/core/safe-markdown.ts';

test('Markdown article formatting preserves headings, emphasis, lists, code and GFM tables', () => {
  const html = safeMarkdownToHtml('## Fixed revision\n\n**Keep** *evidence* and `sha256`.\n\n- First\n- Second\n\n> A backup\n\n```ts\nconst revision = "<fixed>";\n```\n\n| Item | State |\n| --- | --- |\n| Revision | Fixed |');
  for (const expected of ['<h2>Fixed revision</h2>', '<strong>Keep</strong>', '<em>evidence</em>', '<code>sha256</code>', '<ul>', '<li>First</li>', '<blockquote>', '<pre><code class="language-ts">', '<table>', '<td>Fixed</td>']) assert.ok(html.includes(expected), expected);
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelector('pre code')?.textContent, 'const revision = "<fixed>";\n');
  assert.equal(document.querySelector('pre fixed'), null);
  assert.ok(!html.includes('## Fixed'));
});

test('untrusted HTML and Markdown images cannot create executable markup or image fetches', () => {
  const html = safeMarkdownToHtml('<script>alert(1)</script>\n\n<img src="https://remote.example/raw.png" onerror="alert(1)">\n\nKeep <b>this</b>.\n\n![Remote alt](https://remote.example/image.png)\n\n![Reference alt][image]\n\n[image]: data:image/png;base64,AAAA\n\n![Inline alt](data:image/png;base64,AAAA)');
  assert.ok(html.includes('Keep this.'));
  for (const alt of ['Remote alt', 'Reference alt', 'Inline alt']) assert.ok(html.includes(alt));
  for (const forbidden of ['<script', 'alert(', '<img', 'onerror', 'src=', 'remote.example', 'data:image', '<b>']) assert.ok(!html.includes(forbidden), forbidden);
});

test('article links allow HTTP(S) without credentials and strip unsafe or relative destinations', () => {
  const html = safeMarkdownToHtml('[Source](https://example.com/a?q=1&b=2) [HTTP](http://example.com) [JS](javascript:alert%281%29) [Data](data:text/html,unsafe) [File](file:///tmp/private) [Relative](/private) [Credentials](https://user:password@example.com)');
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelector('a')?.getAttribute('href'), 'https://example.com/a?q=1&b=2');
  assert.ok(html.includes('href="http://example.com"'));
  assert.equal((html.match(/href=/g) ?? []).length, 2);
  for (const text of ['JS', 'Data', 'File', 'Relative', 'Credentials']) assert.ok(html.includes(`>${text}</a>`));
  for (const forbidden of ['javascript:', 'data:text', 'file:', 'password', '/private']) assert.ok(!html.includes(forbidden));
});
