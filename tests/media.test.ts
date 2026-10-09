import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildMedia } from '../src/core/media.ts';
import type { Draft, Platform } from '../src/core/model.ts';

const rendererAvailable = spawnSync('rsvg-convert', ['--version']).status === 0;
const videoAvailable = rendererAvailable && spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('say', ['-v', '?']).status === 0;

function draft(platform: Platform, text = 'A useful first idea.\nA practical second idea.'): Draft {
  return {
    id: randomUUID(), title: 'Local media', body: text, revision: 1, approvedHash: 'approved-content', createdAt: new Date().toISOString(),
    brief: { topic: 'Useful content', audience: 'New creators', angle: 'Practical steps', sources: [{ title: 'Source', url: 'https://example.com/source', excerpt: 'A provided source excerpt.' }], platforms: [platform] },
    variants: [{ platform, title: 'A clear title', text, tags: ['creation'], mediaPaths: [] }]
  };
}

async function withDataDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-media-test-'));
  const previous = process.env.STUDIO_DATA_DIR;
  process.env.STUDIO_DATA_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previous === undefined) delete process.env.STUDIO_DATA_DIR;
    else process.env.STUDIO_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('unapproved drafts and absent variants do not create output', async () => {
  await withDataDirectory(async directory => {
    await assert.rejects(buildMedia({ ...draft('xiaohongshu'), approvedHash: null }, 'xiaohongshu'), /Approve the current draft/u);
    await assert.rejects(buildMedia(draft('xiaohongshu'), 'youtube'), /no YouTube variant/u);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('PNG export preserves exact text, escapes XML injection, and does not mutate the draft', { skip: !rendererAvailable }, async () => {
  await withDataDirectory(async directory => {
    const original = draft('xiaohongshu', 'Text & <script>alert("unsafe")</script>\nQuotes: "yes" and \'no\'.');
    const before = JSON.stringify(original);
    const result = await buildMedia(original, 'xiaohongshu');
    assert.equal(result.kind, 'cards');
    assert.equal(result.files.length, 1);
    assert.equal(JSON.stringify(original), before);
    const path = result.files[0];
    assert.ok(path?.startsWith(join(directory, 'media')));
    assert.ok(path);
    const png = await readFile(path);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), 1080);
    assert.equal(png.readUInt32BE(20), 1440);
    const svg = await readFile(join(dirname(path), 'card-01.svg'), 'utf8');
    assert.ok(svg.includes('&amp;'));
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.ok(!svg.includes('<script>'));
    assert.equal(await readFile(join(dirname(path), 'narration.txt'), 'utf8'), `${original.variants[0]?.title}\n\n${original.variants[0]?.text}`);
    assert.ok((await readFile(join(dirname(path), 'caption.txt'), 'utf8')).endsWith('\n\n#creation'));
  });
});

test('long content paginates into unique exports without silently omitting later paragraphs', { skip: !rendererAvailable }, async () => {
  await withDataDirectory(async () => {
    const text = Array.from({ length: 28 }, (_, index) => `Paragraph ${index + 1}.`).join('\n');
    const first = await buildMedia(draft('reddit', text), 'reddit');
    const second = await buildMedia(draft('reddit', text), 'reddit');
    assert.equal(first.files.length, 2);
    assert.equal(second.files.length, 2);
    assert.notEqual(dirname(first.files[0] ?? ''), dirname(second.files[0] ?? ''));
    assert.ok((await readFile(join(dirname(first.files[1] ?? ''), 'card-02.svg'), 'utf8')).includes('Paragraph 28.'));
  });
});

test('missing tools yield an actionable failure before creating a media directory', async () => {
  await withDataDirectory(async directory => {
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await assert.rejects(buildMedia(draft('xiaohongshu'), 'xiaohongshu'), /Install librsvg/u);
      assert.deepEqual(await readdir(directory), []);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test('oversized content and unsafe control characters fail clearly instead of being truncated', async () => {
  await withDataDirectory(async directory => {
    await assert.rejects(buildMedia(draft('xiaohongshu', 'A paragraph.\n'.repeat(280)), 'xiaohongshu'), /approved text is never truncated/u);
    await assert.rejects(buildMedia(draft('xiaohongshu', 'A hidden\u0000 character.'), 'xiaohongshu'), /unsupported control characters/u);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('video export produces a genuine portrait MP4 with audio and preserves the narration script', { skip: !videoAvailable }, async () => {
  await withDataDirectory(async () => {
    const original = draft('youtube', 'Make one useful thing. Share what you learned.');
    const result = await buildMedia(original, 'youtube');
    assert.equal(result.kind, 'video');
    assert.equal(result.files.length, 1);
    const path = result.files[0];
    assert.ok(path);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', path], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const resultData: unknown = JSON.parse(probe.stdout);
    assert.ok(resultData && typeof resultData === 'object' && 'streams' in resultData);
    const streams: unknown = resultData.streams;
    assert.ok(Array.isArray(streams));
    assert.ok(streams.some((stream: unknown) => stream && typeof stream === 'object' && 'codec_type' in stream && stream.codec_type === 'audio'));
    assert.ok(streams.some((stream: unknown) => stream && typeof stream === 'object' && 'codec_type' in stream && stream.codec_type === 'video' && 'width' in stream && stream.width === 1080 && 'height' in stream && stream.height === 1920));
    assert.equal(await readFile(join(dirname(path), 'narration.txt'), 'utf8'), `${original.variants[0]?.title}\n\n${original.variants[0]?.text}`);
  });
});
