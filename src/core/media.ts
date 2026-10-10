import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { z } from 'zod';
import { platformLabels, type Draft, type Platform } from './model.ts';

const videoPlatforms: ReadonlySet<Platform> = new Set(['youtube', 'tiktok', 'bilibili', 'kuaishou', 'douyin']);
const maxCards = 20;
const maxVideoSeconds = 180;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });

export interface MediaResult {
  files: string[];
  kind: 'cards' | 'video';
  note: string;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/gu, character => {
    const replacements: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
    return replacements[character] ?? character;
  });
}

function glyphWidth(character: string): number {
  if (/^[\u0020-\u007e]$/u.test(character)) return /[MW@#%]/u.test(character) ? 0.9 : 0.62;
  return 1.05;
}

function textWidth(text: string): number {
  return [...segmenter.segment(text)].reduce((total, item) => total + glyphWidth(item.segment), 0);
}

export function wrapText(text: string, width: number): string[] {
  if (!Number.isFinite(width) || width < 1.05) throw new Error('The text width must fit at least one readable glyph.');
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\n|\r/u)) {
    let line = '';
    let used = 0;
    const words = [...wordSegmenter.segment(paragraph)].map(item => item.segment);
    for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
      let word = words[wordIndex] ?? '';
      while (/^[\p{Pe}\p{Pf},.!?:;，。！？：；、]+$/u.test(words[wordIndex + 1] ?? '')) {
        word += words[wordIndex + 1];
        wordIndex += 1;
      }
      const wordWidth = textWidth(word);
      if (wordWidth <= width) {
        if (line && used + wordWidth > width) {
          lines.push(line);
          line = '';
          used = 0;
        }
        line += word;
        used += wordWidth;
        continue;
      }
      // A long identifier or URL can exceed a whole line; split only that token.
      for (const { segment } of segmenter.segment(word)) {
        const nextWidth = glyphWidth(segment);
        if (line && used + nextWidth > width) {
          lines.push(line);
          line = '';
          used = 0;
        }
        line += segment;
        used += nextWidth;
      }
    }
    lines.push(line);
  }
  return lines;
}

function visibleLines(text: string, width: number): string[] {
  return wrapText(text, width).map(line => line.trim()).filter((line, index, lines) => line || (index > 0 && index < lines.length - 1 && lines[index - 1]));
}

function isSectionHeading(line: string): boolean {
  return /^(?:#{1,6}\s+\S|信息卡\s*[①②③④⑤⑥⑦⑧⑨⑩\d]+\s*[｜|:：]|\d+[.)、]\s*\S)/u.test(line.trim());
}

function semanticBlocks(text: string): string[] {
  const blocks = text.split(/(?:\r\n|\n|\r){2,}/u).map(block => block.trim()).filter(Boolean);
  const grouped: string[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const next = blocks[index + 1];
    if (!block.includes('\n') && isSectionHeading(block) && next && !isSectionHeading(next.split(/\r\n|\n|\r/u)[0] ?? '')) {
      grouped.push(`${block}\n${next}`);
      index += 1;
    } else {
      grouped.push(block);
    }
  }
  return grouped;
}

function paginateText(text: string, width: number, limit: number): string[][] {
  const pages: string[][] = [];
  let page: string[] = [];
  const finishPage = (): void => {
    if (page.length) pages.push(page);
    page = [];
  };
  for (const block of semanticBlocks(text)) {
    const blockLines = visibleLines(block, width);
    if (blockLines.length <= limit) {
      const separator = page.length ? [''] : [];
      if (page.length + separator.length + blockLines.length > limit) finishPage();
      page.push(...(page.length ? separator : []), ...blockLines);
      continue;
    }
    // Prefer complete sentences when a paragraph is too large for one scene.
    finishPage();
    for (const { segment: sentence } of sentenceSegmenter.segment(block)) {
      const sentenceLines = visibleLines(sentence, width);
      // Balance an oversized sentence so its final word never becomes a lone scene.
      const chunkCount = Math.ceil(sentenceLines.length / limit);
      const chunkSize = Math.ceil(sentenceLines.length / chunkCount);
      for (let offset = 0; offset < sentenceLines.length; offset += chunkSize) {
        const chunk = sentenceLines.slice(offset, offset + chunkSize);
        if (page.length + chunk.length > limit) finishPage();
        page.push(...chunk);
      }
    }
  }
  finishPage();
  return pages.length ? pages : [['']];
}

function xiaohongshuPages(text: string, width: number, limit: number): string[][] {
  const sections: string[] = [];
  const sources: string[] = [];
  let section: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/u)) {
    if (/^\s*(?:来源|sources?|references?)\s*[:：]\s*https?:\/\/\S+\s*$/iu.test(line)) {
      sources.push(line.trim());
      continue;
    }
    if (isSectionHeading(line) && section.some(item => item.trim())) {
      sections.push(section.join('\n'));
      section = [];
    }
    section.push(line);
  }
  if (section.some(item => item.trim())) sections.push(section.join('\n'));
  const pages = sections.flatMap(item => paginateText(item, width, limit));
  if (sources.length) {
    const sourceText = `来源（按正文出现顺序）\n\n${sources.map((source, index) => `${index + 1}. ${source}`).join('\n\n')}`;
    pages.push(...paginateText(sourceText, width, limit));
  }
  return pages.length ? pages : [['']];
}

export function layoutMediaText(title: string, text: string, platform: Platform): { titleLines: string[]; pages: string[][] } {
  const titleLines = wrapText(title, 17.8).map(line => line.trim());
  if (titleLines.length > 4) throw new Error('Shorten this variant title so it fits four readable card lines.');
  const video = videoPlatforms.has(platform);
  const width = video ? 14.2 : 18.8;
  const limit = video ? 7 : 14;
  const pages = platform === 'xiaohongshu' ? xiaohongshuPages(text, width, limit) : paginateText(text, width, limit);
  if (pages.length > maxCards) throw new Error(`This text requires ${pages.length} cards. Shorten the variant to at most ${maxCards} cards; approved text is never truncated.`);
  return { titleLines, pages };
}

function renderCard(title: string[], body: string[], index: number, count: number, height: number): string {
  const titleSize = 50;
  const video = height === 1920;
  const bodySize = video ? 64 : 48;
  const bodyStart = video ? 520 : 380;
  const lineHeight = video ? 94 : 64;
  const titleLines = title.map((line, lineIndex) => `<text x="84" y="${142 + lineIndex * 60}" font-size="${titleSize}" font-weight="700">${escapeXml(line)}</text>`).join('\n');
  const bodyLines = body.map((line, lineIndex) => `<text x="84" y="${bodyStart + lineIndex * lineHeight}" font-size="${bodySize}">${escapeXml(line)}</text>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}">
<rect width="1080" height="${height}" fill="#f8f5ef"/>
<rect x="56" y="54" width="968" height="${height - 108}" rx="28" fill="#ffffff"/>
<rect x="84" y="80" width="82" height="8" rx="4" fill="#cc4935"/>
<g font-family="Arial, PingFang SC, Noto Sans CJK SC, sans-serif" fill="#182d34" xml:space="preserve">
${titleLines}
${bodyLines}
<text x="84" y="${height - 86}" font-size="28" fill="#718089">${index + 1} / ${count}</text>
</g>
</svg>\n`;
}

async function findTool(name: string): Promise<string> {
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  const instructions = name === 'rsvg-convert'
    ? 'Install librsvg to provide rsvg-convert, then ensure its executable is on PATH.'
    : name === 'say'
      ? 'Narrated video export requires the macOS say command. Run this stage on the Mac.'
      : 'Install FFmpeg, including ffprobe, and ensure both executables are on PATH.';
  throw new Error(`Media export requires ${name}. ${instructions}`);
}

async function runTool(executable: string, args: readonly string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-32_768); });
    child.stderr.on('data', (data: Buffer) => { errors = (errors + data.toString()).slice(-32_768); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`Could not run media tool: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('Media tool timed out. Check the local tool installation and shorten the draft before retrying.'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Media tool failed (${code ?? 'signal'}): ${errors.trim().slice(-2000) || 'No diagnostic output.'}`));
        return;
      }
      resolveOutput(output);
    });
  });
}

async function requireFile(path: string): Promise<void> {
  const file = await stat(path);
  if (!file.isFile() || file.size === 0) throw new Error('The media tool did not produce a usable output file.');
}

export async function buildMedia(draft: Draft, platform: Platform): Promise<MediaResult> {
  if (!draft.approvedHash) throw new Error('Approve the current draft before generating media.');
  const variant = draft.variants.find(candidate => candidate.platform === platform);
  if (!variant) throw new Error(`This draft has no ${platformLabels[platform]} variant.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(`${variant.title}${variant.text}`)) {
    throw new Error('Remove unsupported control characters from the title and text before generating media.');
  }

  const kind = videoPlatforms.has(platform) ? 'video' : 'cards';
  const height = kind === 'video' ? 1920 : 1440;
  const { titleLines, pages } = layoutMediaText(variant.title, variant.text, platform);

  const renderer = await findTool('rsvg-convert');
  const ffmpeg = kind === 'video' ? await findTool('ffmpeg') : null;
  const ffprobe = kind === 'video' ? await findTool('ffprobe') : null;
  const speech = kind === 'video' ? await findTool('say') : null;
  const directory = join(resolve(process.env.STUDIO_DATA_DIR ?? '.studio'), 'media', randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    const narration = `${variant.title}\n\n${variant.text}`;
    const hashtags = variant.tags.map(tag => tag.startsWith('#') ? tag : `#${tag}`).join(' ');
    await writeFile(join(directory, 'narration.txt'), narration, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(directory, 'caption.txt'), `${narration}${hashtags ? `\n\n${hashtags}` : ''}`, { encoding: 'utf8', mode: 0o600 });
    const images: string[] = [];
    for (const [index, page] of pages.entries()) {
      const base = `card-${String(index + 1).padStart(2, '0')}`;
      const svgPath = join(directory, `${base}.svg`);
      const pngPath = join(directory, `${base}.png`);
      await writeFile(svgPath, renderCard(titleLines, page, index, pages.length, height), { encoding: 'utf8', mode: 0o600 });
      await runTool(renderer, ['--width', '1080', '--height', String(height), '--output', pngPath, svgPath], directory);
      await requireFile(pngPath);
      const header = await readFile(pngPath);
      if (!header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Card renderer did not return a PNG image.');
      images.push(pngPath);
    }

    if (kind === 'cards') {
    return { files: images, kind, note: `Created ${images.length} PNG cards at 1080 × 1440. Exact caption.txt and SVG sources are stored beside the cards; standalone source URLs may be grouped on a separate source card in their original order. Review the rendered cards and approve the assembled draft again before publication.` };
    }
    if (!ffmpeg || !ffprobe || !speech) throw new Error('Required video tools were not resolved.');
    const audioPath = join(directory, 'narration.aiff');
    const voice = process.env.STUDIO_TTS_VOICE ?? (/\p{Script=Han}/u.test(narration) ? 'Tingting' : 'Samantha');
    await runTool(speech, ['-v', voice, '-r', '170', '-f', join(directory, 'narration.txt'), '-o', audioPath], directory);
    await requireFile(audioPath);
    const duration = Number((await runTool(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioPath], directory)).trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not measure the generated narration audio.');
    if (duration > maxVideoSeconds) throw new Error(`Narration lasts ${Math.ceil(duration)} seconds. Shorten this variant to ${maxVideoSeconds} seconds or less; no approved text was truncated.`);

    const weights = pages.map((page, index) => Math.max(1, page.join('').length + (index === 0 ? variant.title.length : 0)));
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    const slides = ['ffconcat version 1.0', ...weights.flatMap((weight, index) => [`file card-${String(index + 1).padStart(2, '0')}.png`, `duration ${(duration * weight / totalWeight).toFixed(6)}`]), `file card-${String(pages.length).padStart(2, '0')}.png`, ''].join('\n');
    await writeFile(join(directory, 'slides.ffconcat'), slides, { encoding: 'utf8', mode: 0o600 });
    const videoPath = join(directory, 'video.mp4');
    await runTool(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '1', '-i', 'slides.ffconcat', '-i', 'narration.aiff', '-map', '0:v:0', '-map', '1:a:0', '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-t', duration.toFixed(6), 'video.mp4'], directory);
    await requireFile(videoPath);
    const probeOutput = await runTool(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', videoPath], directory);
    const probeSchema = z.object({ streams: z.array(z.object({ codec_type: z.string() })) });
    const streams = probeSchema.parse(JSON.parse(probeOutput) as unknown).streams.map(stream => stream.codec_type);
    if (!streams.includes('video') || !streams.includes('audio')) throw new Error(`The generated MP4 is missing its video or narration track (found: ${streams.join(', ') || 'none'}).`);
    return { files: [videoPath], kind, note: `Created a ${Math.ceil(duration)}-second narrated slideshow MP4 at 1080 × 1920 using the ${voice} macOS voice. Exact narration.txt, caption.txt and source cards are stored beside it. Review the video and approve the assembled draft again before publication.` };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
