import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createObservationReport, runRuntimeObservation } from '../scripts/runtime-observation.mjs';
import { runtimeObservation, startManagedObservation, stopRuntimeObservation } from '../src/core/runtime-observation.ts';

const at = Date.parse('2026-10-21T00:00:00.000Z');
const release = { version: 'review-fixture', sourceDigest: 'a'.repeat(64), builtAt: new Date(at).toISOString() };
test('read-only runtime status projects stale observations as interrupted without changing or restarting their evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observation-api-')); const workspaceId = randomUUID();
  try {
    assert.equal((await runtimeObservation({ directory, workspaceId, release, now: at })).status, 'not_started');
    const root = join(directory, 'current'); await mkdir(root);
    const report = { ...createObservationReport({ workspaceId, release, directory: root, port: 4310, once: false, reset: false }, at), checkedAt: new Date(at).toISOString(), elapsedHours: 19.77, samples: 1187 };
    const path = join(root, 'status.json'); const original = JSON.stringify(report); await writeFile(path, original);
    const live = await runtimeObservation({ directory, workspaceId, release, now: at + 60_000 }); assert.equal(live.status, 'running'); assert.equal(live.accepted, false);
    const stale = await runtimeObservation({ directory, workspaceId, release, now: at + 180_001 }); assert.equal(stale.status, 'interrupted'); assert.equal(stale.accepted, false); assert.equal(stale.elapsedHours, 19.77);
    assert.match(stale.message, /重新开始/u); assert.equal(await readFile(path, 'utf8'), original);
    assert.equal((await runtimeObservation({ directory, workspaceId: randomUUID(), release, now: at })).status, 'not_started');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('runtime observation rejects incomplete acceptance claims and does not expose private record errors or symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'observation-api-')); const workspaceId = randomUUID();
  try {
    const report = { ...createObservationReport({ workspaceId, release, directory, port: 4310, once: false, reset: false }, at), status: 'passed', accepted: true, error: '/private/token=secret' };
    const path = join(directory, 'status.json'); await writeFile(path, JSON.stringify(report));
    const result = await runtimeObservation({ directory, workspaceId, release, now: at }); assert.equal(result.status, 'failed'); assert.equal(result.accepted, false); assert.doesNotMatch(JSON.stringify(result), /private|token|secret/u);
    await rm(path); await symlink('/private/unavailable', path);
    assert.equal((await runtimeObservation({ directory, workspaceId, release, now: at })).status, 'unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the API owns observation cancellation and preserves separate windows without resuming elapsed time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-observation-')); const workspaceId = randomUUID();
  const runner: typeof runRuntimeObservation = (options, dependencies) => runRuntimeObservation(options, {
    ...dependencies,
    now: () => at,
    monotonic: () => 0,
    fetchJson: async path => path === '/healthz' || path === '/readyz' ? { ready: true } : path === '/api/runtime/release' ? { release } : { release, runtime: 'docker', scope: 'existing_instance', steps: ['docker', 'database', 'localfs', 'model'].map(id => ({ id, status: 'ready' })) },
    wait: async (_milliseconds, signal) => new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  try {
    for (const name of ['managed-first', 'managed-second']) {
      const root = join(directory, name);
      await startManagedObservation({ workspaceId, release, directory: root, port: 4310, once: false, reset: false }, runner);
      assert.equal((await stopRuntimeObservation()).stopped, true);
      const report = JSON.parse(await readFile(join(root, 'status.json'), 'utf8')) as { status: string; accepted: boolean; elapsedHours: number };
      assert.equal(report.status, 'interrupted'); assert.equal(report.accepted, false); assert.equal(report.elapsedHours, 0);
    }
    assert.equal((await stopRuntimeObservation()).stopped, false);
    const root = join(directory, 'managed-orphan'); await mkdir(root);
    await writeFile(join(root, 'status.json'), JSON.stringify(createObservationReport({ workspaceId, release, directory: root, port: 4310, once: false, reset: false }, at + 1)));
    assert.equal((await runtimeObservation({ directory, workspaceId, release, now: at + 2 })).status, 'interrupted', 'A new API process must not count the prior process as still running');
  } finally { await stopRuntimeObservation(); await rm(directory, { recursive: true, force: true }); }
});
