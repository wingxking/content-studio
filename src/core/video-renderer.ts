import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { getAsset, resolveAssetPath } from './assets.ts';
import { dataDirectory } from './store.ts';
import { videoRevisionSchema, type VideoOutput, type VideoRevision } from './video-model.ts';
import { cacheVideoStage, probeVideoMedia, readVideoJson, runVideoTool, splitVideoSentences, videoFileHash, videoFingerprint, videoSrt, writeVideoJson, type VideoCaption } from './video-tools.ts';

export interface VideoRendererOptions {
  signal?: AbortSignal;
  dataRoot?: string;
  renderId: string;
  fence?: () => Promise<void>;
  onProgress?: (phase: string) => Promise<void>;
  resolveAsset?: (id: string) => Promise<{ path: string; hash: string; mime: string }>;
  rendererUrl?: string;
  ttsUrl?: string;
  // An operator-provided immutable image/model/voice fingerprint invalidates audio caches on upgrades.
  ttsFingerprint?: string;
}
function serviceOrigin(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Video services need a configured HTTP(S) origin.');
  return url.origin;
}
async function rendererRequest(origin: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.STUDIO_RENDERER_TOKEN ? { Authorization: `Bearer ${process.env.STUDIO_RENDERER_TOKEN}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(1800000), ...(signal ? [signal] : [])]), redirect: 'error' });
  const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error('Renderer receipt exceeded its limit.');
  if (!response.ok) throw new Error(`Renderer service failed (HTTP ${response.status}); check its stage diagnostics.`);
  return JSON.parse(text) as unknown;
}
export async function synthesizeCpuSpeech(origin: string, text: string, voice: string, speed: number, path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
  const response = await fetch(`${origin}/v1/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'kokoro', input: text, voice, speed, response_format: 'wav', stream: false }), signal: requestSignal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`CPU TTS failed (HTTP ${response.status}); verify the configured voice and downloaded model.`);
  const reader = response.body.getReader(); const handle = await open(path, 'wx', 0o600); let bytes = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 64 * 1024 * 1024) throw new Error('A TTS sentence exceeded the 64 MiB limit.');
      await handle.writeFile(chunk.value);
    }
    await handle.sync();
  } finally { await reader.cancel().catch(() => undefined); await handle.close(); }
  const probe = await probeVideoMedia(path, signal); if (!probe.streams.some(stream => stream.codec_type === 'audio')) throw new Error('CPU TTS returned no audio stream.');
}
const mptReceiptSchema = z.object({ revision_id: z.string().regex(/^[a-f0-9]{32}$/u) }).passthrough();
const mptResultSchema = z.object({ state: z.literal('succeeded'), export: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }), stages: z.record(z.string(), z.object({ reused: z.boolean() }).passthrough()) }).passthrough();
export async function cancelRendererProject(projectId: string, upstreamRevision: string, rendererUrl = process.env.STUDIO_RENDERER_URL ?? 'http://renderer:8900'): Promise<void> {
  await rendererRequest(serviceOrigin(rendererUrl), `/projects/${z.uuid().parse(projectId)}/cancel`, { revision: z.string().regex(/^[a-f0-9]{32}$/u).parse(upstreamRevision) });
}
export async function renderVideoRevision(projectId: string, input: VideoRevision, options: VideoRendererOptions): Promise<VideoOutput> {
  z.uuid().parse(projectId); z.uuid().parse(options.renderId); const revision = videoRevisionSchema.parse(input);
  if (!revision.content) throw new Error('Create and review a storyboard before rendering.');
  const root = resolve(options.dataRoot ?? dataDirectory()); const directory = join(root, 'videos', projectId, 'renders', options.renderId);
  const stagesDirectory = join(root, 'videos', projectId, 'stages'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const rendererOrigin = serviceOrigin(options.rendererUrl ?? process.env.STUDIO_RENDERER_URL ?? 'http://renderer:8900');
  const ttsOrigin = serviceOrigin(options.ttsUrl ?? process.env.STUDIO_TTS_URL ?? 'http://tts:8880');
  const ttsFingerprint = options.ttsFingerprint ?? process.env.STUDIO_TTS_FINGERPRINT;
  if (!ttsFingerprint?.trim()) throw new Error('Set STUDIO_TTS_FINGERPRINT to the pinned CPU TTS image/model/voice revision before rendering.');
  const signal = options.signal;
  const fence = async (): Promise<void> => { signal?.throwIfAborted(); await options.fence?.(); signal?.throwIfAborted(); };
  const progress = async (phase: string): Promise<void> => { await fence(); await options.onProgress?.(phase); };
  const tools = { ffmpeg: (await runVideoTool('ffmpeg', ['-version'], directory, signal, 15000)).split('\n')[0], ffprobe: (await runVideoTool('ffprobe', ['-version'], directory, signal, 15000)).split('\n')[0], contract: 'studio-video-v1' };
  const resolveAsset = options.resolveAsset ?? (async (id: string) => {
    const asset = await getAsset(id);
    return { path: await resolveAssetPath(id), hash: asset.hash, mime: asset.mime };
  });
  const prepared: { id: string; footage: string; audio: string; narration: string }[] = [];
  const manifests: Record<string, unknown>[] = []; const captions: VideoCaption[] = []; let timeline = 0; let reusedStages = 0;
  for (const scene of revision.content.scenes) {
    if (!scene.assetId) throw new Error(`Scene ${scene.id} needs a real rights-cleared image or video asset before rendering.`);
    await progress(`Preparing scene ${scene.id}`); const asset = await resolveAsset(scene.assetId);
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(asset.mime)) throw new Error('Storyboard footage must be PNG, JPEG, WebP or MP4.');
    if (await videoFileHash(asset.path) !== asset.hash) throw new Error('Storyboard source asset integrity failed.');
    const sentenceAudio: { path: string; hash: string; duration: number; text: string }[] = [];
    for (const [index, text] of splitVideoSentences(scene.narration).entries()) {
      await progress(`CPU narration ${scene.id}, sentence ${index + 1}`);
      const key = videoFingerprint({ stage: 'tts', text, voice: revision.settings.voice, speed: revision.settings.speed, ttsFingerprint });
      const audio = await cacheVideoStage(stagesDirectory, key, 'wav', path => synthesizeCpuSpeech(ttsOrigin, text, revision.settings.voice, revision.settings.speed, path, signal), fence);
      if (audio.reused) reusedStages += 1;
      const measured = await probeVideoMedia(audio.path, signal); const duration = measured.format.duration;
      if (duration > 90) throw new Error('A narration sentence exceeds 90 seconds; shorten it before retrying.');
      sentenceAudio.push({ path: audio.path, hash: audio.hash, duration, text });
    }
    const audioKey = videoFingerprint({ stage: 'scene-audio', hashes: sentenceAudio.map(sentence => sentence.hash), tools });
    const audio = await cacheVideoStage(stagesDirectory, audioKey, 'wav', async path => {
      const work = await mkdtemp(join(dirname(path), 'concat-'));
      try {
        for (const [index, sentence] of sentenceAudio.entries()) await copyFile(sentence.path, join(work, `${index}.wav`));
        await writeFile(join(work, 'audio.txt'), sentenceAudio.map((_, index) => `file '${index}.wav'\n`).join(''), { mode: 0o600 });
        await runVideoTool('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', 'audio.txt', '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', path], work, signal);
      } finally { await rm(work, { recursive: true, force: true }); }
    }, fence);
    if (audio.reused) reusedStages += 1;
    const duration = (await probeVideoMedia(audio.path, signal)).format.duration;
    if (timeline + duration > revision.settings.maxSeconds) throw new Error(`Narration exceeds the reviewed ${revision.settings.maxSeconds}-second limit; no text was truncated.`);
    if (scene.caption !== null) captions.push({ text: scene.caption, start: timeline, end: timeline + duration });
    else {
      let elapsed = 0; const total = sentenceAudio.reduce((sum, sentence) => sum + sentence.duration, 0);
      for (const sentence of sentenceAudio) {
        const seconds = sentence.duration * duration / total; captions.push({ text: sentence.text, start: timeline + elapsed, end: timeline + elapsed + seconds }); elapsed += seconds;
      }
    }
    const footageKey = videoFingerprint({ stage: 'footage', sourceHash: asset.hash, mime: asset.mime, width: revision.settings.width, height: revision.settings.height, fps: revision.settings.fps, maxSeconds: revision.settings.maxSeconds, tools });
    const footage = await cacheVideoStage(stagesDirectory, footageKey, 'mp4', async path => {
      const settings = revision.settings; const visual = `scale=${settings.width}:${settings.height}:force_original_aspect_ratio=decrease,pad=${settings.width}:${settings.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${settings.fps}`;
      await runVideoTool('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', ...(asset.mime.startsWith('image/') ? ['-loop', '1'] : []), '-protocol_whitelist', 'file,pipe', '-i', asset.path, '-t', String(asset.mime.startsWith('image/') ? 1 : settings.maxSeconds), '-map', '0:v:0', '-an', '-vf', visual, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], directory, signal);
      const measured = await probeVideoMedia(path, signal); if (!measured.streams.some(stream => stream.codec_type === 'video')) throw new Error('Pre-encoded footage has no video stream.');
    }, fence);
    if (footage.reused) reusedStages += 1;
    prepared.push({ id: scene.id, footage: footage.path, audio: audio.path, narration: scene.narration });
    manifests.push({ sceneId: scene.id, assetId: scene.assetId, sourceHash: asset.hash, footageHash: footage.hash, audioHash: audio.hash, duration, sentences: sentenceAudio.map(({ path: _path, ...sentence }) => sentence) });
    timeline += duration;
  }
  const mptManifest = { project_id: projectId, settings: { width: revision.settings.width, height: revision.settings.height, fps: revision.settings.fps, narration_volume: 1, bgm_volume: 0 }, scenes: prepared };
  const mptKey = videoFingerprint({ mptManifest, manifests: manifests.map(scene => ({ sceneId: scene.sceneId, footageHash: scene.footageHash, audioHash: scene.audioHash })), tools });
  const manifestPath = join(directory, 'manifest.json'); const mptManifestPath = join(directory, 'mpt-input.json');
  await writeVideoJson(mptManifestPath, mptManifest);
  await writeVideoJson(manifestPath, { version: 1, renderId: options.renderId, projectId, revision: revision.number, settings: revision.settings, sourceArticle: revision.sourceArticle, tools, ttsFingerprint, scenes: manifests, mptKey });
  await progress('Snapshotting prepared media in the renderer');
  const receipt = mptReceiptSchema.parse(await rendererRequest(rendererOrigin, `/projects/${projectId}/revise`, { manifestPath: mptManifestPath, requestId: mptKey }, signal));
  await writeVideoJson(join(directory, 'upstream.json'), { revision: receipt.revision_id, requestId: mptKey });
  const abortRenderer = (): void => { void cancelRendererProject(projectId, receipt.revision_id, rendererOrigin).catch(() => undefined); };
  signal?.addEventListener('abort', abortRenderer, { once: true });
  let result: z.infer<typeof mptResultSchema>;
  try {
    await progress('Rendering the prepared MPT project');
    await rendererRequest(rendererOrigin, `/projects/${projectId}/plan`, { revision: receipt.revision_id }, signal);
    result = mptResultSchema.parse(await rendererRequest(rendererOrigin, `/projects/${projectId}/render`, { revision: receipt.revision_id, retry: true }, signal));
    await fence();
  } finally { signal?.removeEventListener('abort', abortRenderer); }
  const rawPath = resolve(result.export.path); const mptRoot = join(root, 'renderers', 'mpt', 'projects', projectId);
  const inside = relative(mptRoot, rawPath); if (!inside || inside.startsWith('..') || inside.startsWith('/')) throw new Error('Renderer returned an export outside its project directory.');
  const rawHash = await videoFileHash(rawPath); if (rawHash !== result.export.sha256) throw new Error('Renderer export integrity failed.');
  reusedStages += Object.values(result.stages).filter(stage => stage.reused).length;
  const rawProbe = await probeVideoMedia(rawPath, signal); const rawVideo = rawProbe.streams.find(stream => stream.codec_type === 'video');
  if (!rawVideo || !rawProbe.streams.some(stream => stream.codec_type === 'audio')) throw new Error('MPT output needs both video and audio streams.');
  if (Math.abs(rawProbe.format.duration - timeline) > Math.max(0.5, prepared.length * 2 / revision.settings.fps)) throw new Error('Rendered video duration does not match measured narration.');
  const captionsPath = revision.settings.captions ? join(directory, 'captions.srt') : null;
  if (captionsPath) await writeFile(captionsPath, videoSrt(captions), { encoding: 'utf8', mode: 0o600 });
  let videoPath = rawPath;
  if (captionsPath && revision.settings.burnCaptions) {
    await progress('Burning reviewed sentence captions');
    const srt = await readFile(captionsPath, 'utf8'); const key = videoFingerprint({ stage: 'captions', rawHash, srt, font: revision.settings.font, width: revision.settings.width, height: revision.settings.height, tools });
    const final = await cacheVideoStage(stagesDirectory, key, 'mp4', async path => {
      // The filter uses a fixed relative filename so bind paths cannot become filter expressions.
      const style = `FontName=${revision.settings.font},FontSize=20,Outline=2,MarginV=38,Alignment=2`;
      await runVideoTool('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-i', rawPath, '-vf', `subtitles=filename=captions.srt:force_style='${style}'`, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', path], directory, signal);
    }, fence);
    if (final.reused) reusedStages += 1; videoPath = final.path;
  }
  await progress('Checking audio, dimensions, timing and full decoding');
  const measured = await probeVideoMedia(videoPath, signal); const video = measured.streams.find(stream => stream.codec_type === 'video'); const audio = measured.streams.find(stream => stream.codec_type === 'audio');
  if (!video || !audio || video.width !== revision.settings.width || video.height !== revision.settings.height) throw new Error('The final video dimensions or audio stream failed quality checks.');
  if (audio.duration !== undefined && video.duration !== undefined && Math.abs(audio.duration - video.duration) > 0.5) throw new Error('The final audio and video stream durations differ by more than half a second.');
  await runVideoTool('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', videoPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], directory, signal);
  await fence();
  const output: VideoOutput = { rawPath, videoPath, captionsPath, manifestPath, rawHash, hash: await videoFileHash(videoPath), duration: measured.format.duration, width: video.width, height: video.height, upstreamRevision: receipt.revision_id, reusedStages, renderedAssetId: null };
  await writeVideoJson(join(directory, 'completed.json'), output); await fence();
  return output;
}
export async function readRendererRevision(projectId: string, renderId: string, root = dataDirectory()): Promise<string | null> {
  const input = await readVideoJson(join(root, 'videos', z.uuid().parse(projectId), 'renders', z.uuid().parse(renderId), 'upstream.json')).catch(() => null);
  return z.object({ revision: z.string().regex(/^[a-f0-9]{32}$/u) }).safeParse(input).data?.revision ?? null;
}
