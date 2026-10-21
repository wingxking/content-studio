// Optional interactive phase of ecosystem-docker-smoke. Real API/DB/queue,
// deterministic research/model/extension, no public submission or owner files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configureTaskRuntime } from '../src/core/tasks.ts';
import { runWorkerOnce } from '../src/server/worker.ts';
import { addAccount, createDraft } from '../src/core/pipeline.ts';
import { createVideoProject, supabaseVideoRepository, videoRevisionHash } from '../src/core/video.ts';
import { videoFileHash } from '../src/core/video-tools.ts';
import { writeDraftArtifacts, draftDirectory } from '../src/core/artifacts.ts';
import { readState } from '../src/core/store.ts';
import { initializeJournalPresence } from '../src/core/publication-journal.ts';

export async function awaitWorkflowWebFixture(directory: string, workspaceId: string): Promise<void> {
  assert(process.argv.includes('--confirm-interactive-fixture'));
  await initializeJournalPresence();
  const source = { title: 'Synthetic software evidence', url: 'https://www.w3.org/', excerpt: 'Fixture evidence for software revision review; no live research.' };
  configureTaskRuntime({
    research: async () => ({ sources: [source], warnings: ['Deterministic research fixture.'] }),
    structured: async schema => schema.parse({ questions: [{ question: 'How should software teams review immutable content revisions?', audienceNeed: 'Practical software review', angle: 'Preserve original files', sourceUrls: [source.url], platforms: ['zhihu'], assessment: { status: 'allowed', reasons: ['Software fixture.'] } }], skipped: [] }),
    generateMaster: async () => ({ title: 'Web review software fixture', body: `Review and save the intended software revision. Source: ${source.url}` }),
    adaptMaster: async (_brief, _master, platform) => ({ platform, title: 'Web review platform fixture', text: `Review the software revision before delivery. ${source.url}`, tags: ['software'], mediaPaths: [], format: 'article' }),
  });
  const media = join(directory, 'videos', 'legacy.mp4'); await mkdir(join(directory, 'videos'), { recursive: true });
  await copyFile('/fixture-sample.mp4', media); const mediaHash = await videoFileHash(media);
  const legacy = await createDraft({ topic: 'Legacy media preview fixture', audience: 'Software authors', angle: 'Review media', sources: [source], platforms: ['youtube'] }, { title: 'Legacy MP4 compatibility fixture', body: 'Legacy article without rich document.', variants: [{ platform: 'youtube', title: 'Legacy video', text: 'Software media preview.', tags: [], mediaPaths: [media] }] });
  await writeDraftArtifacts(legacy);
  const snapshot = join(draftDirectory(legacy.id), 'revision-1', 'content.json'); const snapshotBytes = await readFile(snapshot);
  const youtube = await addAccount({ platform: 'youtube', label: 'Manual YouTube fixture', provider: 'native', integrationId: 'isolated-fixture', status: 'blocked', note: 'No platform connection; manual fixture only.', verifiedAt: null });
  const project = await createVideoProject({ explicitlyRequested: true, brief: { topic: 'Imported MP4 review fixture', audience: 'Software authors', instruction: 'Review saved software changes.', platform: 'youtube', sources: [] }, settings: { width: 320, height: 180 }, content: { title: 'Imported fixture video', script: 'Review saved software changes.', scenes: [{ id: 'scene-1', narration: 'Review saved software changes.', visualDescription: 'Original software fixture image.', assetId: null, caption: null, sourceUrls: [] }], disclosureReview: 'Isolated fixture; no publication.' } });
  const at = new Date().toISOString(); const renderId = randomUUID();
  await supabaseVideoRepository.save({ ...project, status: 'ready', renders: [{ id: renderId, revision: 1, inputHash: videoRevisionHash(project), status: 'succeeded', owner: randomUUID(), attempt: 1, phase: 'Imported previously decoded fixture MP4', startedAt: at, heartbeatAt: at, finishedAt: at, error: null, output: { rawPath: media, videoPath: media, captionsPath: null, manifestPath: join(directory, 'fixture-manifest.json'), hash: mediaHash, rawHash: mediaHash, duration: 2.417, width: 320, height: 180, upstreamRevision: mediaHash.slice(0, 32), reusedStages: 0, renderedAssetId: null } }] }, project.version);
  process.env.STUDIO_WORKER_ROLE = 'all'; process.env.STUDIO_PUBLIC_ORIGIN = 'http://127.0.0.1:14410'; process.env.STUDIO_LISTEN_HOST = '0.0.0.0'; process.env.PORT = '4310'; process.env.NODE_ENV = 'production';
  const api = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
  const exit = new Promise<number | null>(accept => api.once('exit', accept));
  const controller = new AbortController(); let workerFailure: unknown;
  const work = (async () => { while (!controller.signal.aborted) { try { if (!await runWorkerOnce(controller.signal)) await delay(100); } catch (error) { if (!controller.signal.aborted) workerFailure = error; } } })();
  const stop = new Promise<void>(accept => { process.once('SIGTERM', accept); process.once('SIGINT', accept); });
  try {
    let ready = false;
    for (let index = 0; index < 100 && !ready; index++) { ready = await fetch('http://127.0.0.1:4310/readyz').then(response => response.ok, () => false); if (!ready) await delay(100); }
    assert(ready); console.log(JSON.stringify({ interactiveFixtureReady: true, workspaceId, articleId: legacy.id, projectId: project.id, renderId, youtubeAccountId: youtube.id, mediaHash, origin: process.env.STUDIO_PUBLIC_ORIGIN, realRenderingThisRun: false, externalSubmissions: 0 }));
    await Promise.race([stop, exit.then(code => { throw new Error(`Fixture API exited early (${code}).`); })]);
    assert.equal(await videoFileHash(media), mediaHash); assert.deepEqual(await readFile(snapshot), snapshotBytes);
    const state = await readState(); assert.equal(state.paused, true); assert.equal(state.jobs.some(job => job.remoteId || job.remoteUrl || ['published', 'delivered', 'submitting'].includes(job.status)), false);
    assert.equal(workerFailure, undefined); console.log(JSON.stringify({ interactiveFixtureFinished: true, workspaceId, legacyRevisionBytesPreserved: true, mediaHashPreserved: true, externalSubmissions: 0 }));
  } finally {
    controller.abort(); await work; api.kill('SIGTERM');
    const ended = await Promise.race([exit.then(() => true), delay(28000).then(() => false)]); if (!ended) { api.kill('SIGKILL'); await exit; }
  }
}
