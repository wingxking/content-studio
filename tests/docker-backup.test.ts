import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyBackupTrees, writeBackupDestination } from '../scripts/docker.mjs';

const trees = ['storage', 'data', 'config', 'model-auth', 'model-cache', 'delivery-private', 'tts-cache'];
async function fixture(): Promise<{ directory: string; source: string; destination: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'studio-backup-regression-'));
  const source = join(directory, 'source');
  for (const tree of trees) await mkdir(join(source, tree), { recursive: true });
  return { directory, source, destination: join(directory, 'backup') };
}

test('backup omits only ephemeral Codex tmp and preserves durable authentication', async () => {
  const { directory, source, destination } = await fixture();
  try {
    await writeFile(join(source, 'model-auth', 'auth.json'), '{"auth_mode":"test"}');
    await mkdir(join(source, 'model-auth', 'tmp', 'arg0'), { recursive: true });
    await symlink('/outside/ephemeral-target', join(source, 'model-auth', 'tmp', 'arg0', 'apply_patch'));
    await writeBackupDestination(destination, () => copyBackupTrees(source, destination));
    assert.deepEqual(await readdir(join(destination, 'model-auth')), ['auth.json']);
    assert.equal(await readFile(join(destination, 'model-auth', 'auth.json'), 'utf8'), '{"auth_mode":"test"}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a symlink outside Codex tmp fails closed and removes partial private payload', async () => {
  const { directory, source, destination } = await fixture();
  try {
    await writeFile(join(source, 'config', 'application.env'), 'TEST_PRIVATE_VALUE=fixture');
    await symlink('/outside/durable-target', join(source, 'model-auth', 'auth.json'));
    await assert.rejects(writeBackupDestination(destination, () => copyBackupTrees(source, destination)), /partial payload was removed/);
    assert.deepEqual(await readdir(destination), ['incomplete.json']);
    const marker: unknown = JSON.parse(await readFile(join(destination, 'incomplete.json'), 'utf8'));
    assert.ok(typeof marker === 'object' && marker !== null && 'complete' in marker && marker.complete === false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a dump or encryption failure leaves neither plaintext nor a complete manifest', async () => {
  const { directory, destination } = await fixture();
  try {
    await assert.rejects(writeBackupDestination(destination, async () => {
      await writeFile(join(destination, 'database.dump'), 'private fixture dump');
      await writeFile(join(destination, 'roles.sql'), 'private fixture role');
      await writeFile(join(destination, 'manifest.json'), '{"format":3}');
      throw new Error('Injected encryption failure');
    }), /partial payload was removed/);
    assert.deepEqual(await readdir(destination), ['incomplete.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
