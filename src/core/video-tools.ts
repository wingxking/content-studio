import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export function videoFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function videoFileHash(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes as Buffer);
  return digest.digest('hex');
}
export async function writeVideoJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}
export async function readVideoJson(path: string): Promise<unknown> { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
export async function runVideoTool(executable: 'ffmpeg' | 'ffprobe', args: readonly string[], cwd: string, signal?: AbortSignal, timeoutMs = 600000): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolveOutput, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = ''; let errors = ''; let failure: Error | null = null;
    const stop = (error: Error): void => {
      failure ??= error;
      if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL');
    };
    const abort = (): void => stop(new Error('Video operation cancelled.'));
    const timer = setTimeout(() => stop(new Error(`${executable} timed out; completed stages are retained.`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); if (output.length > 2 * 1024 * 1024) stop(new Error('Video tool output exceeded its limit.')); });
    child.stderr.on('data', (bytes: Buffer) => { errors = (errors + bytes.toString()).slice(-8192); });
    child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error(`${executable} is unavailable in this video worker image.`)); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure); else if (code !== 0) reject(new Error(`${executable} failed: ${errors.trim().slice(-2000)}`)); else resolveOutput(output);
    });
  });
}
const probeSchema = z.object({ format: z.object({ duration: z.coerce.number().positive() }), streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional(), duration: z.coerce.number().optional(), avg_frame_rate: z.string().optional() })) });
export async function probeVideoMedia(path: string, signal?: AbortSignal) {
  const info = await stat(path); if (!info.isFile() || !info.size) throw new Error('The media stage did not produce a regular nonempty file.');
  return probeSchema.parse(JSON.parse(await runVideoTool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type,width,height,duration,avg_frame_rate', '-of', 'json', path], dirname(path), signal)) as unknown);
}
export function splitVideoSentences(text: string): string[] {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Narration contains unsupported control characters.');
  const result: string[] = [];
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text)) {
    const glyphs = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(segment.trim())].map(part => part.segment);
    for (let offset = 0; offset < glyphs.length;) {
      let end = Math.min(offset + 70, glyphs.length);
      if (end < glyphs.length && /[\p{Script=Latin}\p{Number}]/u.test(glyphs[end - 1] ?? '') && /[\p{Script=Latin}\p{Number}]/u.test(glyphs[end] ?? '')) {
        const boundary = glyphs.slice(offset, end).findLastIndex(glyph => /\s/u.test(glyph));
        if (boundary > 0) end = offset + boundary;
      }
      const value = glyphs.slice(offset, end).join('').trim(); if (value) result.push(value); offset = end;
    }
  }
  if (!result.length) throw new Error('Each scene needs speakable narration.');
  return result;
}
export interface VideoCaption { text: string; start: number; end: number }
export function videoSrt(captions: readonly VideoCaption[]): string {
  const timestamp = (seconds: number): string => {
    const total = Math.round(seconds * 1000);
    return `${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total / 60000) % 60).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`;
  };
  let previous = 0;
  return captions.map((caption, index) => {
    if (!Number.isFinite(caption.start) || !Number.isFinite(caption.end) || caption.start < previous - 0.001 || caption.end <= caption.start) throw new Error('Caption times must be ordered, positive and nonoverlapping.');
    previous = caption.end;
    const glyphs = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(caption.text.replace(/\s+/gu, ' ').trim())].map(part => part.segment);
    const width = /\p{Script=Han}/u.test(caption.text) ? 24 : 42;
    if (!glyphs.length || glyphs.length > width * 3) throw new Error('Shorten a caption to at most three readable lines.');
    const lines: string[] = []; for (let offset = 0; offset < glyphs.length; offset += width) lines.push(glyphs.slice(offset, offset + width).join(''));
    return `${index + 1}\n${timestamp(caption.start)} --> ${timestamp(caption.end)}\n${lines.join('\n')}\n`;
  }).join('\n');
}
export async function cacheVideoStage(directory: string, key: string, extension: 'wav' | 'mp4', producer: (path: string) => Promise<void>, fence: () => Promise<void>): Promise<{ path: string; hash: string; reused: boolean }> {
  const folder = join(directory, key); await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `output.${extension}`); const recordPath = join(folder, 'record.json');
  const record = z.object({ key: z.literal(key), hash: z.string().regex(/^[a-f0-9]{64}$/u) }).safeParse(await readVideoJson(recordPath).catch(() => null));
  if (record.success && await videoFileHash(path).catch(() => '') === record.data.hash) { await fence(); return { path, hash: record.data.hash, reused: true }; }
  const temporary = join(folder, `work-${randomUUID()}.${extension}`);
  try {
    await producer(temporary); await fence(); const info = await stat(temporary); if (!info.size) throw new Error('Empty video stage output.');
    const hash = await videoFileHash(temporary); await rename(temporary, path); await writeVideoJson(recordPath, { key, hash });
    return { path, hash, reused: false };
  } finally { await rm(temporary, { force: true }); }
}
