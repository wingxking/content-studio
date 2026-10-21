import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const observationWindowMs = 48 * 3600000;
export const observationIntervalMs = 60000;
export const observationMaximumGapMs = 180000;
const maximumClockDriftMs = 5000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const fixedRelease = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const digest = /^[a-f0-9]{64}$/u;
class ObservationFailure extends Error {}
const reject = message => { throw new ObservationFailure(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function parseObservationOptions(args, environment) {
  const flags = new Map(); const switches = new Set();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (['--once', '--reset'].includes(name)) { if (switches.has(name)) reject('Duplicate observation option.'); switches.add(name); continue; }
    if (!['--workspace', '--release', '--source-digest', '--directory'].includes(name) || flags.has(name) || !args[index + 1] || args[index + 1].startsWith('--')) reject('Use explicit workspace, fixed release, source digest and observation directory; only --once and --reset are optional.');
    flags.set(name, args[++index]);
  }
  const workspaceId = flags.get('--workspace'); const version = flags.get('--release'); const sourceDigest = flags.get('--source-digest');
  if (environment.STUDIO_CONTAINER !== 'true') reject('Runtime observation must run inside the existing application container.');
  if (!uuid.test(workspaceId ?? '') || workspaceId !== environment.STUDIO_WORKSPACE_ID) reject('Expected workspace must exactly match this application container.');
  if (!fixedRelease.test(version ?? '') || version === 'latest' || !digest.test(sourceDigest ?? '')) reject('Provide the exact fixed release and SHA-256 source digest.');
  const directory = flags.get('--directory');
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory || directory !== '/data/runtime-observation' && !directory.startsWith('/data/runtime-observation/')) reject('Choose an explicit real directory under /data/runtime-observation.');
  const port = Number(environment.PORT ?? '4310');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) reject('The application loopback port is invalid.');
  return { workspaceId, release: { version, sourceDigest }, directory, port, once: switches.has('--once'), reset: switches.has('--reset') };
}

function releaseManifest(value) {
  const release = object(value);
  if (Object.keys(release).sort().join(',') !== 'builtAt,sourceDigest,version' || !fixedRelease.test(release.version ?? '') || release.version === 'latest' || !digest.test(release.sourceDigest ?? '') || !Number.isFinite(Date.parse(release.builtAt))) reject('The API release manifest is missing or invalid.');
  return { version: release.version, sourceDigest: release.sourceDigest, builtAt: release.builtAt };
}

/** Four bounded GETs on this Pod's loopback; no database, model or publishing client. */
export async function sampleRuntimeReadiness(expected, fetchJson) {
  const paths = ['/healthz', '/readyz', '/api/runtime/release', '/api/runtime/setup'];
  const [live, ready, metadata, setupValue] = await Promise.all(paths.map(path => fetchJson(path)));
  if (object(live).ready !== true || object(ready).ready !== true) reject('The API health or readiness check failed.');
  const release = releaseManifest(object(metadata).release); const setup = object(setupValue);
  if (release.version !== expected.version || release.sourceDigest !== expected.sourceDigest || JSON.stringify(releaseManifest(setup.release)) !== JSON.stringify(release)) reject('The running release changed; start a fresh observation window for the new release.');
  if (setup.runtime !== 'docker' || setup.scope !== 'existing_instance' || !Array.isArray(setup.steps)) reject('The API did not confirm the expected container runtime.');
  for (const id of ['docker', 'database', 'localfs', 'model']) {
    const steps = setup.steps.filter(step => object(step).id === id);
    if (steps.length !== 1 || object(steps[0]).status !== 'ready') reject(`The required ${id} readiness check failed.`);
  }
  return { release, checks: { apiHealth: true, apiReadiness: true, releaseMatched: true, requiredSetupReady: true } };
}

export function createObservationReport(options, at) {
  return { version: 1, scope: 'runtime_readiness_only', executionId: randomUUID(), workspaceId: options.workspaceId, release: { ...options.release, builtAt: null }, status: 'running', startedAt: new Date(at).toISOString(), checkedAt: null, targetHours: 48, intervalSeconds: 60, maximumGapSeconds: 180, samples: 0, elapsedHours: 0, monotonicElapsedHours: 0, accepted: false, qualityAccepted: false, productionAccepted: false, checks: null, error: null };
}

/** Real mode has a fixed 48-hour minimum; virtual clocks exist only as test inputs. */
export function advanceObservation(report, sample, timing, once = false) {
  const previousAt = Date.parse(report.checkedAt ?? report.startedAt); const wallElapsed = timing.at - Date.parse(report.startedAt);
  if (!Number.isFinite(timing.at) || !Number.isFinite(timing.elapsedMs) || !Number.isFinite(timing.gapMs) || timing.at < previousAt || timing.at - previousAt > observationMaximumGapMs || timing.gapMs < 0 || timing.gapMs > observationMaximumGapMs || timing.elapsedMs < report.monotonicElapsedHours * 3600000 || Math.abs(wallElapsed - timing.elapsedMs) > maximumClockDriftMs) reject('Observation continuity or the clock changed; a fresh uninterrupted window is required.');
  if (sample.release.version !== report.release.version || sample.release.sourceDigest !== report.release.sourceDigest || report.release.builtAt && sample.release.builtAt !== report.release.builtAt) reject('The running release changed; start a fresh observation window for the new release.');
  const samples = report.samples + 1;
  const accepted = !once && wallElapsed >= observationWindowMs && timing.elapsedMs >= observationWindowMs && samples >= Math.floor(observationWindowMs / observationIntervalMs) + 1;
  return { ...report, release: sample.release, samples, checkedAt: new Date(timing.at).toISOString(), elapsedHours: wallElapsed / 3600000, monotonicElapsedHours: timing.elapsedMs / 3600000, accepted, status: accepted ? 'passed' : once ? 'smoke_only' : 'running', checks: sample.checks };
}

/** A killed/stalled observer cannot leave a running record looking current. */
export function observationStatusAt(report, at = Date.now()) {
  if (report.status === 'running' && (!Number.isFinite(Date.parse(report.checkedAt ?? report.startedAt)) || at < Date.parse(report.checkedAt ?? report.startedAt) || at - Date.parse(report.checkedAt ?? report.startedAt) > observationMaximumGapMs)) return { ...report, status: 'interrupted', accepted: false, error: 'The observation is stale; a fresh uninterrupted window is required.' };
  return report;
}

async function saveReport(path, report) {
  const temporary = `${path}.${report.executionId}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(report, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

export function loopbackReadinessJson(port, path, signal, deadlineMs = 15000) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15000) reject('Readiness requests require a total deadline of at most 15 seconds.');
  const deadline = AbortSignal.timeout(deadlineMs);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise((accept, fail) => {
    const call = request({ hostname: '127.0.0.1', port, path, method: 'GET', timeout: deadlineMs, signal: boundedSignal }, response => {
      let bytes = 0; const chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) call.destroy(new Error('limit')); else chunks.push(chunk); });
      response.once('error', () => fail(new ObservationFailure('A bounded loopback readiness request failed.')));
      response.once('end', () => { try { if (response.statusCode !== 200) throw new Error('status'); accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new ObservationFailure('A loopback readiness response was unavailable or invalid.')); } });
    });
    call.once('timeout', () => call.destroy(new Error('timeout')));
    call.once('error', () => fail(new ObservationFailure('A bounded loopback readiness request failed.'))); call.end();
  });
}

export async function runRuntimeObservation(options, dependencies = {}) {
  const now = dependencies.now ?? Date.now; const monotonic = dependencies.monotonic ?? (() => performance.now());
  const wait = dependencies.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  const log = dependencies.log ?? (report => console.log(JSON.stringify(report)));
  const signal = dependencies.signal; const fetchJson = dependencies.fetchJson ?? (path => loopbackReadinessJson(options.port, path, signal));
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(options.directory)).isDirectory() || await realpath(options.directory) !== options.directory) reject('Observation directory must be a real directory, not a link.');
  const lockPath = join(options.directory, '.observer.lock'); let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') reject('An observation already owns this directory. Inspect its process and .observer.lock; remove a stale lock only after confirming its process has stopped.'); throw error; }
  let report = createObservationReport(options, now()); const path = join(options.directory, 'status.json');
  const owner = { executionId: report.executionId, pid: process.pid, host: hostname() };
  try {
    await lock.writeFile(JSON.stringify(owner)); await lock.sync();
    const prior = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (prior !== null) {
      if (!prior.isFile() || prior.size > 32768) reject('The prior observation record is invalid. Inspect it before starting a fresh window.');
      if (!options.reset) reject('A prior observation exists. Use --reset to archive it and start a fresh 48-hour window; observations never resume or accumulate elapsed time.');
      await rename(path, join(options.directory, `prior-${randomUUID()}.json`));
    }
    const started = monotonic(); let previous = started;
    try {
      await saveReport(path, report);
      dependencies.onStarted?.();
      for (;;) {
        if (signal?.aborted) reject('Runtime observation was interrupted; a fresh uninterrupted window is required.');
        const before = monotonic(); const at = now();
        // Check a pause before sending any request, then check again after the bounded sample.
        if (before - previous > observationMaximumGapMs || at - Date.parse(report.checkedAt ?? report.startedAt) > observationMaximumGapMs) reject('Observation continuity was interrupted; a fresh uninterrupted window is required.');
        const sample = await sampleRuntimeReadiness(options.release, fetchJson);
        const checked = monotonic();
        report = advanceObservation(report, sample, { at: now(), elapsedMs: checked - started, gapMs: checked - previous }, options.once);
        previous = checked; await saveReport(path, report);
        if (report.samples === 1 || report.samples % 30 === 0 || report.accepted || options.once) log(report);
        if (report.accepted || options.once) return report;
        await wait(Math.max(0, started + report.samples * observationIntervalMs - monotonic()), signal);
      }
    } catch (error) {
      report = { ...report, status: signal?.aborted ? 'interrupted' : 'failed', accepted: false, checkedAt: new Date(now()).toISOString(), error: signal?.aborted ? 'Runtime observation was interrupted; a fresh uninterrupted window is required.' : error instanceof ObservationFailure ? error.message : 'Runtime observation failed. Inspect the local runtime before starting a fresh window.' };
      await saveReport(path, report).catch(() => undefined); log(report); return report;
    }
  } finally {
    await lock.close();
    const current = await lstat(lockPath).then(info => info.isFile() && info.size <= 4096 ? readFile(lockPath, 'utf8').then(JSON.parse) : null).catch(() => null);
    if (current?.executionId === owner.executionId) await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  try {
    const report = await runRuntimeObservation(parseObservationOptions(process.argv.slice(2), process.env), { signal: controller.signal });
    if (['failed', 'interrupted'].includes(report.status)) process.exitCode = 1;
  } catch (error) { console.error(error instanceof ObservationFailure ? error.message : 'Could not start runtime observation. Inspect its directory and process ownership.'); process.exitCode = 1; }
}
