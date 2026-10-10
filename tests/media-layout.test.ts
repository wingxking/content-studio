import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { layoutMediaText, wrapText } from '../src/core/media.ts';

const withoutWhitespace = (text: string): string => text.replace(/\s/gu, '');

async function fixture(name: string): Promise<{ title: string; text: string }> {
  const script = await readFile(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
  const [title, ...paragraphs] = script.split('\n\n');
  assert.ok(title);
  return { title, text: paragraphs.join('\n\n') };
}

test('ordinary Latin words remain whole while every source character is preserved', () => {
  const text = 'Navi Pillay’s Nobel Peace Prize: committee and international law.';
  const lines = wrapText(text, 17.8);
  assert.equal(lines.join(''), text);
  for (const word of ['Pillay’s', 'Peace', 'Prize', 'committee', 'international']) {
    assert.ok(lines.some(line => line.includes(word)), `${word} was split between lines`);
  }
});

test('oversized identifiers wrap without losing Unicode graphemes', () => {
  const text = `${'a'.repeat(50)} 👩🏽‍💻 e\u0301`;
  const lines = wrapText(text, 4);
  assert.equal(lines.join(''), text);
  assert.ok(lines.some(line => line.includes('👩🏽‍💻')));
  assert.ok(lines.some(line => line.includes('e\u0301')));
  assert.throws(() => wrapText(text, 0), /readable glyph/u);
});

test('card page breaks keep fitting paragraphs and heading bodies together', () => {
  const first = '1. First idea\nRead a useful explanation before deciding how to publish it.';
  const second = '2. Second idea\nVerify all the evidence and save the sources for the reader.';
  const third = '3. Third idea\nRecord the final result and the conditions of public visibility.';
  const { pages } = layoutMediaText('Publishing notes', [first, second, third].join('\n\n'), 'reddit');
  for (const block of [first, second, third]) {
    assert.ok(pages.some(page => withoutWhitespace(page.join('')).includes(withoutWhitespace(block))));
  }
  assert.equal(withoutWhitespace(pages.flat().join('')), withoutWhitespace([first, second, third].join('')));
  assert.ok(pages.every(page => page.length <= 14));
});

test('the real video script produces readable scenes with all exact spoken content represented', async () => {
  const { title, text } = await fixture('video');
  const { titleLines, pages } = layoutMediaText(title, text, 'youtube');
  assert.ok(titleLines.some(line => line.includes('Prize')));
  assert.equal(withoutWhitespace(titleLines.join('')), withoutWhitespace(title));
  assert.equal(withoutWhitespace(pages.flat().join('')), withoutWhitespace(text));
  assert.ok(pages.every(page => page.length >= 4 && page.length <= 7));
  assert.equal(pages.length, 8);
});

test('an oversized sentence is balanced instead of producing a one-word final scene', () => {
  const text = `${'One meaningful observation follows another with clear evidence '.repeat(3)}today.`;
  const { pages } = layoutMediaText('Evidence', text, 'youtube');
  assert.equal(withoutWhitespace(pages.flat().join('')), withoutWhitespace(text));
  assert.ok(pages.every(page => page.length > 1 && page.length <= 7));
});

test('three information sections remain separate and all original URLs appear on the source card', async () => {
  const { title, text } = await fixture('xiaohongshu');
  const { pages } = layoutMediaText(title, text, 'xiaohongshu');
  assert.equal(pages.length, 4);
  assert.ok(pages[0]?.[0]?.startsWith('信息卡①'));
  assert.ok(pages[1]?.[0]?.startsWith('信息卡②'));
  assert.ok(pages[2]?.[0]?.startsWith('信息卡③'));
  const sourceCard = pages[3];
  assert.ok(sourceCard);
  assert.ok(sourceCard[0]?.startsWith('来源（按正文出现顺序）'));
  const sources = text.split('\n').filter(line => line.startsWith('来源：'));
  const sourceText = withoutWhitespace(sourceCard.join(''));
  let lastIndex = -1;
  for (const source of sources) {
    const index = sourceText.indexOf(withoutWhitespace(source));
    assert.ok(index > lastIndex, 'A source URL is missing or out of its original order');
    lastIndex = index;
  }
  const body = text.split('\n').filter(line => !line.startsWith('来源：')).join('\n');
  assert.equal(withoutWhitespace(pages.slice(0, 3).flat().join('')), withoutWhitespace(body));
  assert.ok(pages.every(page => page.length <= 14));
});

test('source extraction never removes non-URL prose after a source label', () => {
  const text = '信息卡①｜Source\n来源：The report is an interpretation, not a verdict.';
  const { pages } = layoutMediaText('A source note', text, 'xiaohongshu');
  assert.equal(pages.length, 1);
  assert.equal(withoutWhitespace(pages.flat().join('')), withoutWhitespace(text));
});

test('unstructured explicit lines remain in their original order without truncation', () => {
  const text = Array.from({ length: 28 }, (_, index) => `Paragraph ${index + 1}.`).join('\n');
  const { pages } = layoutMediaText('Explicit lines', text, 'reddit');
  assert.equal(pages.length, 2);
  assert.equal(withoutWhitespace(pages.flat().join('')), withoutWhitespace(text));
});

test('excessive pages are rejected rather than silently dropping later content', () => {
  assert.throws(() => layoutMediaText('Too much', 'A paragraph.\n'.repeat(281), 'xiaohongshu'), /approved text is never truncated/u);
});
