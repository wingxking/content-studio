import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareDraftBridgeDirectory, youtubeAuthorizationNotice } from '../scripts/docker.mjs';
const execute = promisify(execFile);
test('Docker lifecycle wrapper deduplicates default backup targets and shared source roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-wrapper-'));
  try {
    const binary = join(directory, 'bin'); const root = join(directory, 'data'); const backups = join(directory, 'backups'); const capture = join(directory, 'arguments');
    await Promise.all([mkdir(binary), mkdir(root), mkdir(backups)]);
    await writeFile(join(binary, 'docker'), '#!/bin/sh\nif [ "$1" = build ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$STUDIO_WRAPPER_CAPTURE"\n', { mode: 0o700 });
    const client = join(directory, 'client.json'); await writeFile(client, '{}');
    const env = { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_BACKUP_ROOT: backups, STUDIO_WRAPPER_CAPTURE: capture };
    for (const args of [
      ['backup', '--root', root, '--target', join(backups, 'cutover')],
      ['youtube-auth', '--root', root, '--client-file', client, '--callback-port', '18765'],
      ['restore', '--root', root, '--source', root, '--data-source', root],
      ['restore', '--root', root, '--source', backups, '--data-source', backups],
    ]) {
      await execute('sh', [resolve('scripts/docker.sh'), ...args], { env });
      const values = (await readFile(capture, 'utf8')).trimEnd().split('\n'); const mounts = values.filter((_value, index) => values[index - 1] === '--mount');
      const destinations = mounts.map(value => value.split(',').find(part => part.startsWith('dst='))?.slice(4));
      assert.equal(destinations.length, new Set(destinations).size);
      if (args[0] === 'youtube-auth') assert.ok(mounts.includes(`type=bind,src=${client},dst=${client},readonly`));
      assert.ok(mounts.includes(`type=bind,src=${root},dst=${root}`));
      assert.ok(mounts.includes(`type=bind,src=${backups},dst=${backups}`));
      assert.deepEqual(values.slice(values.indexOf('content-studio-operations:local') + 1), args);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Docker auth output exposes only the trusted authorization URL', () => {
  const authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&response_type=code';
  assert.deepEqual(Object.keys(youtubeAuthorizationNotice(JSON.stringify({ authorizationUrl, token: 'private fixture' })) ?? {}), ['authorizationUrl', 'nextAction']);
  for (const value of ['not-json', JSON.stringify({ token: 'private fixture' }), JSON.stringify({ authorizationUrl: 'https://example.com/auth' }), JSON.stringify({ authorizationUrl: `${authorizationUrl}&access_token=private` })]) assert.equal(youtubeAuthorizationNotice(value), null);
});

test('Docker start prepares a private bridge directory without generating or replacing pairing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-bridge-directory-'));
  const uid = process.getuid?.() ?? 1000; const gid = process.getgid?.() ?? 1000;
  try {
    const bridge = join(directory, 'delivery-private', 'draft-bridge');
    await prepareDraftBridgeDirectory(directory, uid, gid);
    assert.deepEqual(await readdir(bridge), []);
    await writeFile(join(bridge, 'config.json'), '{"fixture":"retained"}', { mode: 0o600 });
    await chmod(bridge, 0o755);
    await prepareDraftBridgeDirectory(directory, uid, gid);
    const metadata = await stat(bridge);
    assert.equal(metadata.mode & 0o777, 0o700);
    assert.equal(metadata.uid, uid); assert.equal(metadata.gid, gid);
    assert.equal(await readFile(join(bridge, 'config.json'), 'utf8'), '{"fixture":"retained"}');
    await assert.rejects(prepareDraftBridgeDirectory(directory, Number.NaN, gid), /Invalid Docker host UID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Docker start rejects a private bridge bind directory redirected through a symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-bridge-link-'));
  try {
    const target = join(directory, 'outside'); const bindRoot = join(directory, 'root');
    await mkdir(target, { mode: 0o755 }); await mkdir(bindRoot);
    await symlink(target, join(bindRoot, 'delivery-private'));
    await assert.rejects(prepareDraftBridgeDirectory(bindRoot, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000), /symbolic link/);
    assert.deepEqual(await readdir(target), []);
    assert.equal((await stat(target)).mode & 0o777, 0o755);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
