import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import express from 'express';
import { createReleaseManifest } from '../scripts/record-release.mjs';
import { readRuntimeRelease } from '../src/core/runtime-release.ts';
import { runtimeReleaseSchema } from '../src/contracts/runtime-release.ts';
import { runtimeApi } from '../src/server/runtime-api.ts';

async function sourceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'studio-release-'));
  for (const path of ['src', 'scripts', 'public', 'supabase/migrations', '.agents/skills', 'data', 'docs']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export const fixture = true;');
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  return root;
}

test('image release fingerprint changes with code or lock, independent of build time and private runtime data', async () => {
  const root = await sourceFixture();
  try {
    const first = await createReleaseManifest(root, 'release-15', '2026-10-19T00:00:00Z');
    await writeFile(join(root, 'data', 'auth.json'), '{"private":"fixture"}');
    await writeFile(join(root, '.env'), 'SECRET=fixture');
    await writeFile(join(root, 'docs', 'acceptance.md'), 'Post-deployment acceptance notes.');
    const later = await createReleaseManifest(root, 'release-15', '2026-10-19T01:00:00Z');
    assert.equal(first.sourceDigest, later.sourceDigest);
    assert.notEqual(first.builtAt, later.builtAt);
    assert.deepEqual(Object.keys(runtimeReleaseSchema.parse(first)).sort(), ['builtAt', 'sourceDigest', 'version']);
    await writeFile(join(root, 'src', 'main.ts'), 'export const fixture = false;');
    const edited = await createReleaseManifest(root, 'release-15');
    assert.notEqual(edited.sourceDigest, first.sourceDigest);
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    assert.notEqual((await createReleaseManifest(root, 'release-15')).sourceDigest, edited.sourceDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build metadata rejects floating identifiers and source links outside the build tree', async () => {
  const root = await sourceFixture();
  try {
    for (const version of ['latest', 'bad version', '../outside', '']) await assert.rejects(createReleaseManifest(root, version), /fixed release/u);
    await assert.rejects(createReleaseManifest(root, 'release-15', 'invalid'), /valid build time/u);
    await symlink(join(root, 'data'), join(root, 'src', 'private'));
    await assert.rejects(createReleaseManifest(root, 'release-15'), /symbolic links/u);
    await rm(join(root, 'src'), { recursive: true });
    await symlink(join(root, 'data'), join(root, 'src'));
    await assert.rejects(createReleaseManifest(root, 'release-15'), /regular directory/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('missing or malformed image metadata remains unknown without exposing arbitrary file fields', async () => {
  const root = await sourceFixture(); const path = join(root, 'release.json');
  try {
    assert.equal(await readRuntimeRelease(path), null);
    const release = await createReleaseManifest(root, 'release-15');
    await writeFile(path, JSON.stringify(release));
    assert.deepEqual(await readRuntimeRelease(path), release);
    for (const value of ['not-json', JSON.stringify({ ...release, token: 'private fixture' }), JSON.stringify({ ...release, sourceDigest: 'not-a-hash' }), ' '.repeat(4097)]) {
      await writeFile(path, value); assert.equal(await readRuntimeRelease(path), null);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release endpoint reads image metadata independently of database and account configuration', async () => {
  const app = express(); app.use('/api', runtimeApi);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime/release`);
    assert.equal(response.status, 200);
    const result = await response.json() as { release: unknown };
    assert.deepEqual(Object.keys(result), ['release']);
    if (result.release !== null) runtimeReleaseSchema.parse(result.release);
    assert.doesNotMatch(JSON.stringify(result), /SUPABASE|WORKSPACE|SECRET|private|\/Users|\/data/u);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
