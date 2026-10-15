import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { modelLoginCommand, modelLoginMethod, prepareDraftBridgeDirectory, prepareKnowledgeDirectory, validateKnowledgeSource, youtubeAuthorizationNotice } from '../scripts/docker.mjs';
const execute = promisify(execFile);
test('model login defaults to device and browser OAuth publishes only a temporary loopback relay', () => {
  assert.equal(modelLoginMethod(['model-login']), 'device');
  assert.equal(modelLoginMethod(['model-login', '--method', 'device']), 'device');
  assert.equal(modelLoginMethod(['model-login', '--method', 'browser']), 'browser');
  for (const argv of [['--method'], ['--method=browser'], ['--method', '--root', '/private'], ['--method', 'other'], ['--method', 'browser', '--method', 'device']]) assert.throws(() => modelLoginMethod(argv));
  assert.deepEqual(modelLoginCommand('device'), ['run', '--rm', '--no-deps', 'model-runner', 'codex', 'login', '--device-auth']);
  const name = `content-studio-model-login-${crypto.randomUUID()}`;
  const command = modelLoginCommand('browser', name, '/project/scripts/model-browser-login.mjs');
  assert.deepEqual(command, ['run', '--rm', '--no-deps', '--name', name, '--publish', '127.0.0.1:1455:1456', '--volume', '/project/scripts/model-browser-login.mjs:/opt/content-studio/model-browser-login.mjs:ro', 'model-runner', 'node', '/opt/content-studio/model-browser-login.mjs']);
  for (const path of ['relative.mjs', '/project/helper:rw', '/project/helper,extra']) assert.throws(() => modelLoginCommand('browser', name, path));
});

test('model browser lifecycle forwards CLI streams and removes only its own one-off after success or failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-model-wrapper-'));
  try {
    const binary = join(directory, 'bin'); const root = join(directory, 'root'); const capture = join(directory, 'calls');
    await mkdir(binary); await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'compose.env'), 'STUDIO_MODEL_IMAGE="fixture-model"\n');
    await writeFile(join(binary, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STUDIO_WRAPPER_CAPTURE"\nif [ "$1" = compose ]; then printf "fixture stdout\\n"; printf "fixture stderr\\n" >&2; exit "${STUDIO_FIXTURE_EXIT:-0}"; fi\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture };
    for (const code of ['0', '1']) {
      let stdout = ''; let stderr = '';
      try { const result = await execute(process.execPath, [resolve('scripts/docker.mjs'), 'model-login', '--root', root, '--method', 'browser'], { env: { ...env, STUDIO_FIXTURE_EXIT: code } }); stdout = result.stdout; stderr = result.stderr; assert.equal(code, '0'); }
      catch (caught) { assert.equal(code, '1'); const error = caught as { stdout: string; stderr: string }; stdout = error.stdout; stderr = error.stderr; }
      assert.match(stdout, /fixture stdout/); assert.match(stderr, /fixture stderr/);
    }
    const calls = (await readFile(capture, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 4);
    for (let index = 0; index < calls.length; index += 2) {
      const call = calls[index]!; const name = /--name (content-studio-model-login-[0-9a-f-]{36})/.exec(call)?.[1];
      assert.ok(name); assert.ok(call.includes(`--volume ${resolve('scripts/model-browser-login.mjs')}:/opt/content-studio/model-browser-login.mjs:ro`));
      assert.equal(calls[index + 1], `rm --force ${name}`);
      assert.doesNotMatch(call, /--device-auth| up | stop |--service-ports/);
    }
    assert.notEqual(calls[1], calls[3]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('canceling browser login before a delayed container creation aborts compose and cannot start OAuth afterward', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'studio-model-cancel-'));
    try {
      const binary = join(directory, 'bin'); const root = join(directory, 'root'); const capture = join(directory, 'calls'); const started = join(directory, 'started');
      await mkdir(binary); await mkdir(join(root, 'config'), { recursive: true });
      await writeFile(join(root, 'config', 'compose.env'), 'STUDIO_MODEL_IMAGE="fixture-model"\n');
      await writeFile(join(binary, 'docker'), `#!/usr/bin/env node\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(process.env.STUDIO_WRAPPER_CAPTURE,JSON.stringify(args)+'\\n'); if(args[0]==='compose'){fs.writeFileSync(process.env.STUDIO_WRAPPER_STARTED,'ready');setTimeout(()=>{fs.appendFileSync(process.env.STUDIO_WRAPPER_CAPTURE,'CREATED_AFTER_DELAY\\n');},300);setInterval(()=>{},1000);}`, { mode: 0o700 });
      const child = spawn(process.execPath, [resolve('scripts/docker.mjs'), 'model-login', '--root', root, '--method', 'browser'], { env: { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture, STUDIO_WRAPPER_STARTED: started }, stdio: 'ignore' });
      const completion = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
      try {
        for (let attempt = 0; attempt < 100 && !await stat(started).then(() => true, () => false); attempt++) await delay(10);
        assert.ok(await stat(started)); child.kill(signal); assert.equal(await completion, 1);
        const text = await readFile(capture, 'utf8'); assert.doesNotMatch(text, /CREATED_AFTER_DELAY/);
        const calls = text.trim().split('\n').map(line => JSON.parse(line) as string[]); const compose = calls[0]!; const name = compose[compose.indexOf('--name') + 1]; assert.ok(name);
        for (const call of calls.slice(1)) assert.deepEqual(call, ['rm', '--force', name]);
        assert.ok(calls.length >= 2);
      } finally { child.kill('SIGKILL'); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
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
      ['knowledge-config', '--root', root, '--knowledge-source', binary],
      ['restore', '--root', root, '--source', root, '--data-source', root],
      ['restore', '--root', root, '--source', backups, '--data-source', backups],
    ]) {
      await execute('sh', [resolve('scripts/docker.sh'), ...args], { env });
      const values = (await readFile(capture, 'utf8')).trimEnd().split('\n'); const mounts = values.filter((_value, index) => values[index - 1] === '--mount');
      const destinations = mounts.map(value => value.split(',').find(part => part.startsWith('dst='))?.slice(4));
      assert.equal(destinations.length, new Set(destinations).size);
      if (args[0] === 'youtube-auth') assert.ok(mounts.includes(`type=bind,src=${client},dst=${client},readonly`));
      if (args[0] === 'knowledge-config') assert.ok(mounts.includes(`type=bind,src=${binary},dst=${binary},readonly`));
      assert.ok(mounts.includes(`type=bind,src=${root},dst=${root}`));
      assert.ok(mounts.includes(`type=bind,src=${backups},dst=${backups}`));
      assert.deepEqual(values.slice(values.indexOf('content-studio-operations:local') + 1), args);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Knowledge mounts preserve private input and reject symlink and bind separator escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-knowledge-mount-'));
  try {
    await prepareKnowledgeDirectory(directory, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000);
    const inbox = join(directory, 'knowledge-inbox');
    await writeFile(join(inbox, 'guide.md'), 'retained');
    assert.equal(await validateKnowledgeSource(inbox), inbox);
    await prepareKnowledgeDirectory(directory, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000);
    assert.equal(await readFile(join(inbox, 'guide.md'), 'utf8'), 'retained');
    const alias = join(directory, 'alias'); await symlink(inbox, alias);
    for (const value of [alias, '/', `${inbox}:rw`, `${inbox},readonly`]) await assert.rejects(validateKnowledgeSource(value));
    await rm(inbox, { recursive: true }); await symlink(directory, inbox);
    await assert.rejects(prepareKnowledgeDirectory(directory, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000), /symbolic link/);
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
