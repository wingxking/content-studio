// Explicit fixture-only API acceptance; run in the API container with stdin or a test mount.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

assert.equal(process.env.STUDIO_ORCHESTRATOR, 'kubernetes');
assert.ok(process.env.STUDIO_FIXTURE_WORKSPACE_ID, 'Provide the dedicated fixture UUID.');
assert.equal(process.env.STUDIO_WORKSPACE_ID, process.env.STUDIO_FIXTURE_WORKSPACE_ID, 'Never run against the owner workspace.');
const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://127.0.0.1:4310';
const directory = join(process.env.STUDIO_DATA_DIR ?? '/data', 'kubernetes-acceptance');
const statePath = join(directory, 'state.json');
await mkdir(directory, { recursive: true, mode: 0o700 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#2363c4' } }).png().toBuffer();
async function call(path, body, method = 'POST') {
  const response = await fetch(`${origin}/api/${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${method} ${path} failed: ${response.status}`); return response.json();
}
async function save(value) { await writeFile(statePath, JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function operation(id) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const row = await call(`operations/${id}`, undefined, 'GET');
    if (row.status === 'succeeded') return row;
    assert.ok(!['failed', 'cancelled'].includes(row.status), `Fixture operation ${id} ended ${row.status}: ${row.error}`);
    await delay(1000);
  }
  throw new Error('Fixture operation deadline expired.');
}
const landscape = { width: 320, height: 180, fps: 12, voice: 'af_heart', maxSeconds: 30 };
const portrait = { ...landscape, width: 180, height: 320 };
const phase = process.env.STUDIO_TEST_PHASE ?? 'prepare';
if (phase === 'prepare') {
  // An explicit fixture write initializes its workspace; read-only summary queries do not.
  await call('accounts', { platform: 'bilibili', provider: 'native', label: `Fixture initialization ${Date.now()}`, integrationId: 'fixture-only', status: 'needs_login', note: 'Isolated local fixture; no authorization or external submission.', verifiedAt: null });
  await call('pause', { paused: true });
  const created = await fetch(`${origin}/api/uploads`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(png.length), 'Upload-Metadata': `filename ${Buffer.from('kubernetes-original-fixture.png').toString('base64')}` } });
  assert.equal(created.status, 201); const location = created.headers.get('location'); assert.ok(location);
  const uploadUrl = new URL(location, origin).href;
  const offset = Math.floor(png.length / 2);
  const partial = await fetch(uploadUrl, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: png.subarray(0, offset) });
  assert.equal(partial.status, 204); await save({ uploadUrl, offset, pngHash: digest(png), workspaceId: process.env.STUDIO_WORKSPACE_ID });
  console.log(JSON.stringify({ phase, partialTusBytes: offset, restartApiNow: true }));
} else if (phase === 'render') {
  const saved = JSON.parse(await readFile(statePath, 'utf8')); assert.equal(saved.pngHash, digest(png));
  const retained = await fetch(saved.uploadUrl, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
  assert.equal(retained.status, 200); assert.equal(Number(retained.headers.get('upload-offset')), saved.offset);
  const finished = await fetch(saved.uploadUrl, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(saved.offset), 'Content-Type': 'application/offset+octet-stream' }, body: png.subarray(saved.offset) });
  assert.equal(finished.status, 204);
  const assetResponse = await fetch(`${saved.uploadUrl}/asset`); assert.equal(assetResponse.status, 200);
  const { asset } = await assetResponse.json(); assert.equal(asset.hash, saved.pngHash);
  const narration = 'Blue frame. Portable video.';
  const project = await call('video-projects', { explicitlyRequested: true, brief: { topic: 'Original fictional blue frame fixture', audience: 'Local acceptance operator', instruction: 'Explicit synthetic non-factual acceptance example; no external publication.', sources: [], platform: 'youtube' }, settings: landscape, content: { title: 'Kubernetes original video fixture', script: narration, scenes: [{ id: 'blue', narration, visualDescription: 'Original solid blue image', assetId: asset.id, caption: null, sourceUrls: [] }], disclosureReview: 'Synthetic original fixture with CPU narration; keep within the isolated workspace.' } });
  const outputs = [];
  for (const [name, settings] of [['landscape', landscape], ['portrait', portrait]]) {
    const queued = await call(`video-projects/${project.id}/render-variants`, { expectedRevision: project.revision, settings, approved: true });
    await operation(queued.id);
    const view = await call(`video-projects/${project.id}/view`, undefined, 'GET');
    const render = view.renders.find(item => item.status === 'succeeded' && item.output?.width === settings.width && item.output?.height === settings.height); assert.ok(render?.output);
    const video = Buffer.from(await (await fetch(new URL(render.output.mediaUrl, origin))).arrayBuffer()); assert.equal(digest(video), render.output.hash);
    const downloaded = join(directory, `${name}.mp4`); await writeFile(downloaded, video, { mode: 0o600 });
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-i', downloaded, '-f', 'null', '-'], { timeout: 30000, maxBuffer: 8192 });
    outputs.push({ id: render.id, hash: render.output.hash, width: render.output.width, height: render.output.height });
  }
  await save({ ...saved, projectId: project.id, revision: project.revision, outputs, tusRestart: true, realCpuTts: true, fullDecode: true });
  for (const platform of ['youtube', 'bilibili']) {
    const account = await call('accounts', { platform, provider: 'native', label: `Isolated Kubernetes ${platform} manual fixture`, integrationId: `fixture-${platform}`, status: 'needs_login', note: 'Fixture only. No platform login or external submission.', verifiedAt: null });
    let view = await call(`video-projects/${project.id}/view`, undefined, 'GET');
    let target = view.targets.find(item => item.platform === platform);
    const metadata = { expectedRevision: project.revision, accountId: account.id, renderId: outputs[0].id, title: `${platform} fixture metadata`, text: 'Synthetic original acceptance example; manual export only.', tags: [], deliverySettings: {} };
    if (target) { view = await call(`video-projects/${project.id}/targets/${target.id}`, { ...metadata, expectedTargetRevision: target.revision }, 'PUT'); }
    else view = await call(`video-projects/${project.id}/targets`, { ...metadata, platform });
    target = view.targets.find(item => item.platform === platform); assert.ok(target);
    const approval = { expectedRevision: project.revision, expectedTargetRevision: target.revision, automatic: false };
    const job = await call(`video-projects/${project.id}/targets/${target.id}/publish`, approval);
    const duplicate = await call(`video-projects/${project.id}/targets/${target.id}/publish`, approval);
    assert.equal(job.id, duplicate.id); assert.equal(job.status, 'awaiting_operator');
  }
  const status = await call('status', undefined, 'GET');
  assert.equal(status.state.jobs.length, 2); assert.equal(status.state.paused, true);
  assert.ok(status.state.jobs.every(job => job.attempts === 0 && job.remoteId === null && job.remoteUrl === null));
  await save({ ...saved, projectId: project.id, revision: project.revision, outputs, jobs: status.state.jobs.map(job => job.id), tusRestart: true, realCpuTts: true, fullDecode: true });
  console.log(JSON.stringify({ phase, projectId: project.id, realCpuTts: true, decodedMp4: outputs, manualJobs: 2, duplicateWrites: 0, externalPosts: 0, restartWorkersNow: true }));
} else if (phase === 'verify') {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  const before = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  const queued = await call(`video-projects/${saved.projectId}/render-variants`, { expectedRevision: saved.revision, settings: landscape, approved: true });
  await operation(queued.id);
  const after = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  assert.equal(after.renders.length, before.renders.length);
  for (const output of saved.outputs) {
    const render = after.renders.find(item => item.id === output.id); assert.equal(render?.output?.hash, output.hash);
    const bytes = Buffer.from(await (await fetch(new URL(render.output.mediaUrl, origin))).arrayBuffer()); assert.equal(digest(bytes), output.hash);
  }
  const status = await call('status', undefined, 'GET'); assert.deepEqual(status.state.jobs.map(job => job.id), saved.jobs);
  assert.ok(status.state.jobs.every(job => job.attempts === 0 && job.remoteId === null));
  await save({ ...saved, restartRecovery: true, noDuplicateDelivery: true, verifiedAt: new Date().toISOString() });
  console.log(JSON.stringify({ phase, workspaceId: saved.workspaceId, tusRestart: true, fullDecode: true, restartRecovery: true, noDuplicateDelivery: true, externalPosts: 0 }));
} else if (phase === 'interrupt-start') {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  const before = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  const settings = { ...landscape, width: 960, height: 540, fps: 24, burnCaptions: false };
  const queued = await call(`video-projects/${saved.projectId}/render-variants`, { expectedRevision: saved.revision, settings, approved: true });
  await save({ ...saved, interruption: { operationId: queued.id, settings, previousTargets: before.targets, startedAt: new Date().toISOString() } });
  console.log(JSON.stringify({ phase, operationId: queued.id, holdRendererDuringMptNow: true }));
} else if (phase === 'interrupt-snapshot') {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  const view = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  const render = view.renders.find(item => item.settings?.width === saved.interruption.settings.width && item.settings?.height === saved.interruption.settings.height);
  assert.equal(render?.status, 'running'); assert.equal(render.output, null);
  await save({ ...saved, interruption: { ...saved.interruption, renderId: render.id, firstOwner: render.owner, firstAttempt: render.attempt, heldAt: new Date().toISOString() } });
  console.log(JSON.stringify({ phase, renderId: render.id, attempt: render.attempt, outputPromoted: false, terminateVideoWorkerNow: true }));
} else if (phase === 'interrupt-aborted') {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  const view = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  const render = view.renders.find(item => item.id === saved.interruption.renderId);
  assert.equal(render?.status, 'cancelled'); assert.equal(render.output, null);
  const queued = await call(`operations/${saved.interruption.operationId}`, undefined, 'GET');
  assert.equal(queued.status, 'running');
  await save({ ...saved, interruption: { ...saved.interruption, gracefulAbort: true, lateOutputNotPromoted: true, abortedAt: new Date().toISOString() } });
  console.log(JSON.stringify({ phase, gracefulAbort: true, durableOperationRetained: true, outputPromoted: false }));
} else if (phase === 'interrupt-late') {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  const receipt = JSON.parse(await readFile(join(process.env.STUDIO_DATA_DIR ?? '/data', 'videos', saved.projectId, 'renders', saved.interruption.renderId, 'upstream.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(join(process.env.STUDIO_DATA_DIR ?? '/data', 'renderers', 'mpt', 'projects', saved.projectId, 'revisions', receipt.revision, 'status.json'), 'utf8'));
  assert.equal(upstream.state, 'succeeded');
  const view = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  const render = view.renders.find(item => item.id === saved.interruption.renderId);
  assert.equal(render?.attempt, saved.interruption.firstAttempt); assert.equal(render.status, 'cancelled'); assert.equal(render.output, null);
  await save({ ...saved, interruption: { ...saved.interruption, oldUpstreamSucceeded: true, oldUpstreamRevision: receipt.revision, lateReceiptCheckedAt: new Date().toISOString() } });
  console.log(JSON.stringify({ phase, upstreamSucceeded: true, obsoleteAttemptCancelled: true, lateOutputPromoted: false }));
} else if (phase === 'interrupt-verify') {
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  await operation(saved.interruption.operationId);
  const view = await call(`video-projects/${saved.projectId}/view`, undefined, 'GET');
  const render = view.renders.find(item => item.id === saved.interruption.renderId);
  assert.equal(render?.status, 'succeeded'); assert.ok(render.output);
  assert.notEqual(render.owner, saved.interruption.firstOwner);
  assert.equal(render.attempt, saved.interruption.firstAttempt + 1);
  assert.equal(saved.interruption.oldUpstreamSucceeded, true);
  assert.equal(view.renders.filter(item => item.id === render.id).length, 1);
  assert.deepEqual(view.targets, saved.interruption.previousTargets);
  const bytes = Buffer.from(await (await fetch(new URL(render.output.mediaUrl, origin))).arrayBuffer());
  assert.equal(digest(bytes), render.output.hash);
  const path = join(directory, 'interrupted-recovered.mp4'); await writeFile(path, bytes, { mode: 0o600 });
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { timeout: 30000, maxBuffer: 8192 });
  const status = await call('status', undefined, 'GET');
  assert.ok(status.state.jobs.every(job => job.attempts === 0 && job.remoteId === null));
  const completed = { ...saved.interruption, recovered: true, hash: render.output.hash, reusedStages: render.output.reusedStages, verifiedAt: new Date().toISOString() };
  await save({ ...saved, interruption: completed });
  console.log(JSON.stringify({ phase, renderId: render.id, attempt: render.attempt, hash: render.output.hash, reusedStages: render.output.reusedStages, gracefulAbort: true, lateOutputNotPromoted: true, actualLeaseRecovery: true, decoded: true, duplicateRenderIds: 0, externalPosts: 0 }));
} else throw new Error('Use prepare, render, verify or interrupt-* phases.');
