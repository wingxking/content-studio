import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { advanceObservation, createObservationReport, loopbackReadinessJson, observationIntervalMs, observationMaximumGapMs, observationStatusAt, observationWindowMs, parseObservationOptions, runRuntimeObservation, sampleRuntimeReadiness, type ObservationOptions, type ObservationReport } from '../scripts/runtime-observation.mjs';

const workspace = '11111111-1111-4111-8111-111111111111';
const release = { version: '20261019-observation-fixture', sourceDigest: 'a'.repeat(64), builtAt: '2026-10-19T00:00:00.000Z' };
const options: ObservationOptions = { workspaceId: workspace, release: { version: release.version, sourceDigest: release.sourceDigest }, directory: '/data/runtime-observation', port: 4310, once: false, reset: false };
const at = Date.parse('2026-10-19T01:00:00Z');
function healthy(path: string): Promise<unknown> {
  if (['/healthz', '/readyz'].includes(path)) return Promise.resolve({ ready: true });
  if (path === '/api/runtime/release') return Promise.resolve({ release });
  if (path === '/api/runtime/setup') return Promise.resolve({ runtime: 'docker', scope: 'existing_instance', release, steps: ['docker', 'database', 'localfs', 'model'].map(id => ({ id, status: 'ready' })) });
  throw new Error('Unexpected observation request.');
}
const sample = { release, checks: { apiHealth: true as const, apiReadiness: true as const, releaseMatched: true as const, requiredSetupReady: true as const } };

test('observation CLI requires its exact container workspace, pinned release and explicit private observation path', () => {
  const args = ['--workspace', workspace, '--release', release.version, '--source-digest', release.sourceDigest, '--directory', '/data/runtime-observation'];
  const environment = { STUDIO_CONTAINER: 'true', STUDIO_WORKSPACE_ID: workspace };
  assert.deepEqual(parseObservationOptions(args, environment), options);
  assert.throws(() => parseObservationOptions(args, { ...environment, STUDIO_CONTAINER: 'false' }), /container/u);
  assert.throws(() => parseObservationOptions(args, { ...environment, STUDIO_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222' }), /exactly match/u);
  for (const extra of [['--hours', '1'], ['--interval', '1'], ['--workspace', workspace]]) assert.throws(() => parseObservationOptions([...args, ...extra], environment));
  for (const directory of ['/tmp/observation', '/data/runtime-observation/../other', '/data/runtime-observation-other', 'relative']) assert.throws(() => parseObservationOptions([...args.slice(0, -1), directory], environment), /directory/u);
  assert.throws(() => parseObservationOptions(args.map(value => value === release.version ? 'latest' : value), environment), /exact fixed release/u);
});

test('samples issue only the four read-only runtime requests and retain no response metadata', async () => {
  const paths: string[] = [];
  assert.deepEqual(await sampleRuntimeReadiness(release, async path => { paths.push(path); return healthy(path); }), sample);
  assert.deepEqual(paths.sort(), ['/api/runtime/release', '/api/runtime/setup', '/healthz', '/readyz']);
  await assert.rejects(sampleRuntimeReadiness(release, async path => path === '/readyz' ? { ready: false } : healthy(path)), /readiness/u);
  await assert.rejects(sampleRuntimeReadiness(release, async path => path === '/api/runtime/setup' ? { runtime: 'docker', scope: 'existing_instance', release, steps: ['docker', 'database', 'localfs'].map(id => ({ id, status: 'ready' })) } : healthy(path)), /model/u);
  await assert.rejects(sampleRuntimeReadiness(release, async path => path === '/api/runtime/release' ? { release: { ...release, sourceDigest: 'b'.repeat(64) } } : healthy(path)), /release changed/u);
});

test('a slow-dripping HTTP response cannot extend the total readiness deadline', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    const drip = setInterval(() => response.write(' '), 5);
    response.once('close', () => clearInterval(drip));
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const controller = new AbortController();
  const fallback = setTimeout(() => { controller.abort(); server.closeAllConnections(); }, 1500);
  try {
    const started = performance.now();
    await assert.rejects(loopbackReadinessJson(address.port, '/readyz', controller.signal, 75), /bounded loopback readiness request failed/u);
    assert.ok(performance.now() - started < 750, 'Repeated incoming bytes must not reset the total deadline.');
    for (const deadline of [0, 15001, Infinity]) assert.throws(() => loopbackReadinessJson(address.port, '/readyz', undefined, deadline), /at most 15 seconds/u);
  } finally { clearTimeout(fallback); controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a complete virtual 48-hour runtime window is required and never grants quality or production acceptance', () => {
  let report = createObservationReport(options, at);
  for (let index = 0; index <= observationWindowMs / observationIntervalMs; index++) {
    report = advanceObservation(report, sample, { at: at + index * observationIntervalMs, elapsedMs: index * observationIntervalMs, gapMs: index ? observationIntervalMs : 0 });
    if (index < observationWindowMs / observationIntervalMs) assert.equal(report.accepted, false);
  }
  assert.equal(report.samples, 2881); assert.equal(report.status, 'passed'); assert.equal(report.accepted, true);
  assert.equal(report.scope, 'runtime_readiness_only'); assert.equal(report.qualityAccepted, false); assert.equal(report.productionAccepted, false);
  assert.equal(report.targetHours, 48); assert.equal(report.elapsedHours, 48); assert.equal(report.monotonicElapsedHours, 48);
});

test('once can never pass even when given a complete 48-hour virtual history', () => {
  const prior: ObservationReport = { ...createObservationReport(options, at), samples: 2880, checkedAt: new Date(at + observationWindowMs - observationIntervalMs).toISOString(), monotonicElapsedHours: (observationWindowMs - observationIntervalMs) / 3600000 };
  const report = advanceObservation(prior, sample, { at: at + observationWindowMs, elapsedMs: observationWindowMs, gapMs: observationIntervalMs }, true);
  assert.equal(report.status, 'smoke_only'); assert.equal(report.accepted, false);
});

test('missed observations, backward time and wall-clock jumps cannot produce an accepted window', () => {
  const report = advanceObservation(createObservationReport(options, at), sample, { at, elapsedMs: 0, gapMs: 0 });
  for (const timing of [
    { at: at + observationMaximumGapMs + 1, elapsedMs: observationMaximumGapMs + 1, gapMs: observationMaximumGapMs + 1 },
    { at: at - 1, elapsedMs: 1, gapMs: 1 },
    { at: at + observationWindowMs, elapsedMs: observationIntervalMs, gapMs: observationIntervalMs },
    { at: at + observationIntervalMs, elapsedMs: 0, gapMs: 0 },
  ]) assert.throws(() => advanceObservation(report, sample, timing), /continuity|clock/u);
  assert.equal(observationStatusAt(report, at + observationMaximumGapMs + 1).status, 'interrupted');
  assert.equal(observationStatusAt(report, at + observationMaximumGapMs + 1).accepted, false);
  assert.equal(observationStatusAt(report, at + observationIntervalMs).status, 'running');
});

test('an image rebuild, even with the same release name and source hash, ends the existing window', () => {
  const report = advanceObservation(createObservationReport(options, at), sample, { at, elapsedMs: 0, gapMs: 0 });
  assert.throws(() => advanceObservation(report, { ...sample, release: { ...release, builtAt: '2026-10-19T00:30:00Z' } }, { at: at + 1, elapsedMs: 1, gapMs: 1 }), /release changed/u);
});

test('atomic smoke report requires explicit reset, archives its predecessor and releases its own lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-observation-'));
  try {
    const config = { ...options, directory, once: true };
    const dependencies = { now: () => at, monotonic: () => 0, fetchJson: healthy, log: () => undefined };
    const first = await runRuntimeObservation(config, dependencies);
    assert.equal(first.status, 'smoke_only'); assert.equal(first.samples, 1); assert.equal(first.accepted, false);
    assert.equal((await stat(join(directory, 'status.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')), first);
    await assert.rejects(runRuntimeObservation(config, dependencies), /Use --reset/u);
    const second = await runRuntimeObservation({ ...config, reset: true }, dependencies);
    assert.notEqual(second.executionId, first.executionId); assert.equal(second.samples, 1); assert.equal(second.elapsedHours, 0);
    assert.equal((await readdir(directory)).filter(name => name.startsWith('prior-')).length, 1);
    await assert.rejects(stat(join(directory, '.observer.lock')), /ENOENT/u);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('active observers exclude a concurrent reset and stopping requires a fresh window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-observation-'));
  const controller = new AbortController(); let entered!: () => void;
  const sleeping = new Promise<void>(resolve => { entered = resolve; });
  const run = runRuntimeObservation({ ...options, directory }, { now: () => at, monotonic: () => 0, fetchJson: healthy, log: () => undefined, signal: controller.signal, wait: async (_ms, signal) => { entered(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('fixture interrupted')), { once: true })); } });
  try {
    await sleeping;
    await assert.rejects(runRuntimeObservation({ ...options, directory, reset: true }, { fetchJson: healthy }), /already owns/u);
    controller.abort(); const report = await run; assert.equal(report.status, 'interrupted'); assert.equal(report.accepted, false);
    await assert.rejects(runRuntimeObservation({ ...options, directory, once: true }, { fetchJson: healthy }), /Use --reset/u);
    await assert.rejects(stat(join(directory, '.observer.lock')), /ENOENT/u);
  } finally { controller.abort(); await run; await rm(directory, { recursive: true, force: true }); }
});

test('a stalled virtual loop fails before another sample and never accumulates downtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-observation-')); let time = 0; let requests = 0;
  try {
    const report = await runRuntimeObservation({ ...options, directory }, { now: () => at + time, monotonic: () => time, fetchJson: async path => { requests++; return healthy(path); }, log: () => undefined, wait: async () => { time += observationMaximumGapMs + 1; } });
    assert.equal(report.status, 'failed'); assert.equal(report.samples, 1); assert.equal(report.accepted, false); assert.equal(requests, 4);
    assert.match(report.error ?? '', /continuity/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('readiness failure reports safe diagnostics without raw HTTP output or credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-observation-'));
  try {
    const report = await runRuntimeObservation({ ...options, directory }, { now: () => at, monotonic: () => 0, fetchJson: async () => { throw new Error('raw private token fixture-do-not-record'); }, log: () => undefined });
    assert.equal(report.status, 'failed'); assert.equal(report.accepted, false); assert.equal(report.samples, 0);
    assert.doesNotMatch(await readFile(join(directory, 'status.json'), 'utf8'), /private token|fixture-do-not-record/u);
    await writeFile(join(directory, '.observer.lock'), JSON.stringify({ executionId: 'stale', pid: 99999999, host: 'different-host' }));
    await assert.rejects(runRuntimeObservation({ ...options, directory, reset: true }, { fetchJson: healthy }), /stale lock only after confirming/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
