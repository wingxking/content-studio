import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { youtubeAuthorizationNotice } from '../scripts/docker.mjs';
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
