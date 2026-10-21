import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assertComposeAction, assertKnowledgeBuildCapacity, modelLoginCommand, modelLoginMethod, prepareDraftBridgeDirectory, prepareKnowledgeDirectory, readRuntimeOrchestrator, restoreRuntimeOrchestrator, validateKnowledgeSource, youtubeAuthorizationNotice, type RuntimeOrchestrator } from '../scripts/docker.mjs';
const execute = promisify(execFile);
const runtimeMarker = (phase: RuntimeOrchestrator['phase'] = 'active'): RuntimeOrchestrator => ({ version: 1, orchestrator: 'kubernetes', phase, namespace: 'fixture-runtime', context: 'orbstack', images: { application: 'content-studio:release-fixture', model: 'content-studio-model:release-fixture', renderer: 'content-studio-renderer:release-fixture', tts: 'content-studio-tts:release-fixture' } });
test('lifecycle wrapper reuses exact cached operations source and rebuilds a mismatched image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-operations-cache-'));
  try {
    const capture = join(directory, 'calls');
    await writeFile(join(directory, 'docker'), '#!/usr/bin/env node\nconst fs=require("node:fs");const args=process.argv.slice(2);fs.appendFileSync(process.env.STUDIO_WRAPPER_CAPTURE,JSON.stringify(args)+"\\n");if(args.includes("--network"))process.exit(Number(process.env.STUDIO_WRAPPER_CACHE_EXIT));\n', { mode: 0o700 });
    for (const cached of [true, false]) {
      await writeFile(capture, '');
      await execute('sh', [resolve('scripts/docker.sh'), 'status', '--root', join(directory, 'root')], { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, STUDIO_BACKUP_ROOT: join(directory, 'backups'), STUDIO_WRAPPER_CAPTURE: capture, STUDIO_WRAPPER_CACHE_EXIT: cached ? '0' : '1' } });
      const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
      assert.equal(calls[0]?.[0], 'run');
      assert.ok(calls[0]?.includes('none'), 'Cache verification has no network access.');
      assert.ok(calls[0]?.some(value => value.includes("readFileSync('/opt/content-studio/docker.mjs')")));
      assert.equal(calls.some(args => args[0] === 'build'), !cached);
      assert.equal(calls.at(-1)?.[0], 'run');
      assert.ok(calls.at(-1)?.includes('status'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('large knowledge builds reject insufficient disk capacity before creating image layers', () => {
  for (const bytes of [0, 14 * 1024 ** 3, NaN, Infinity]) assert.throws(() => assertKnowledgeBuildCapacity(bytes), /15 GiB/);
  assert.doesNotThrow(() => assertKnowledgeBuildCapacity(15 * 1024 ** 3));
});
test('configured evidence services participate in lifecycle operations while legacy instances remain unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-evidence-lifecycle-'));
  try {
    const binary = join(directory, 'bin'); const root = join(directory, 'root'); const capture = join(directory, 'calls');
    await mkdir(binary); await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(binary, 'docker'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.STUDIO_WRAPPER_CAPTURE,JSON.stringify(process.argv.slice(2)))\n', { mode: 0o700 });
    for (const configured of [false, true]) {
      await writeFile(join(root, 'config', 'compose.env'), `STUDIO_MODEL_IMAGE="fixture-model"\n${configured ? 'STUDIO_KNOWLEDGE_IMAGE="fixture-knowledge:locked"\n' : ''}`);
      await execute(process.execPath, [resolve('scripts/docker.mjs'), 'stop', '--root', root], { env: { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture } });
      const call = JSON.parse(await readFile(capture, 'utf8')) as string[];
      assert.equal(call[0], 'compose'); assert.equal(call.at(-1), 'stop');
      assert.equal(call.includes('--profile'), configured);
      if (configured) assert.deepEqual(call.slice(-3), ['--profile', 'evidence', 'stop']);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('the host knowledge wrapper checks host capacity before invoking the Docker operations container', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-host-capacity-'));
  try {
    const capture = join(directory, 'calls'); await writeFile(capture, '');
    await writeFile(join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STUDIO_WRAPPER_CAPTURE"\n', { mode: 0o700 });
    await writeFile(join(directory, 'df'), '#!/bin/sh\nprintf "Filesystem Blocks Used Available Capacity Mounted\\nfixture 20000000 1 1000000 90%% /project\\n"\n', { mode: 0o700 });
    await assert.rejects(execute('sh', [resolve('scripts/docker.sh'), 'knowledge-build', '--image', 'studio:fixture'], { env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture } }), /15 GiB/);
    assert.equal(await readFile(capture, 'utf8'), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('runtime image transfers reject low disk capacity before reading image layers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-image-capacity-'));
  try {
    const capture = join(directory, 'calls');
    await writeFile(join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STUDIO_WRAPPER_CAPTURE"\ncase "$*" in *"image inspect"*) printf "1073741824\\n" ;; *" save "*) printf "fixture image" ;; *" load") cat >/dev/null ;; esac\n', { mode: 0o700 });
    await writeFile(join(directory, 'df'), '#!/bin/sh\nprintf "Filesystem Blocks Used Available Capacity Mounted\\nfixture 20000000 1 %s 1%% /project\\n" "$STUDIO_FIXTURE_CAPACITY"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture };
    const argv = [resolve('scripts/load-runtime-image.sh'), '--source', 'fixture-source', '--target', 'fixture-target', '--image', 'studio:fixture-v1'];
    await assert.rejects(execute('sh', argv, { env: { ...env, STUDIO_FIXTURE_CAPACITY: '9437184' } }), /headroom/);
    assert.doesNotMatch(await readFile(capture, 'utf8'), / save | load/);
    await execute('sh', argv, { env: { ...env, STUDIO_FIXTURE_CAPACITY: '12582912' } });
    const calls = await readFile(capture, 'utf8'); assert.match(calls, /fixture-source save studio:fixture-v1/); assert.match(calls, /fixture-target load/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
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

test('Docker ownership gate rejects Kubernetes mutations before invoking Docker and keeps stopped ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runtime-gate-'));
  try {
    const binary = join(directory, 'bin'); const root = join(directory, 'root'); const path = join(root, 'config', 'runtime-orchestrator.json'); const capture = join(directory, 'calls');
    await mkdir(binary); await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(binary, 'docker'), '#!/bin/sh\nprintf "called\\n" >> "$STUDIO_WRAPPER_CAPTURE"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture };
    await writeFile(path, JSON.stringify(runtimeMarker()), { mode: 0o600 });
    for (const command of ['start', 'backup', 'stop', 'migrate']) {
      await assert.rejects(execute(process.execPath, [resolve('scripts/docker.mjs'), command, '--root', root], { env }), /Kubernetes owns/u);
    }
    assert.equal(await stat(capture).then(() => true, () => false), false);
    await writeFile(path, JSON.stringify(runtimeMarker('stopped')));
    await assert.rejects(assertComposeAction(root, 'start'), /Kubernetes owns/u);
    for (const command of ['backup', 'stop', 'migrate']) await assertComposeAction(root, command);
    assert.equal((await readRuntimeOrchestrator(root))?.orchestrator, 'kubernetes');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime marker errors fail closed while legacy Compose roots keep working', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runtime-invalid-'));
  try {
    const binary = join(directory, 'bin'); const root = join(directory, 'root'); const path = join(root, 'config', 'runtime-orchestrator.json'); const capture = join(directory, 'calls');
    await mkdir(binary); await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'compose.env'), 'STUDIO_MODEL_IMAGE="legacy-model"\n');
    await writeFile(join(binary, 'docker'), '#!/bin/sh\nprintf "called\\n" >> "$STUDIO_WRAPPER_CAPTURE"\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture };
    assert.equal(await readRuntimeOrchestrator(root), null); await restoreRuntimeOrchestrator(root);
    await execute(process.execPath, [resolve('scripts/docker.mjs'), 'config', '--root', root], { env });
    assert.equal(await stat(path).then(() => true, () => false), false); await rm(capture);
    for (const value of ['private-invalid-json', JSON.stringify({ ...runtimeMarker(), images: { application: 'incomplete' } }), JSON.stringify({ ...runtimeMarker(), phase: 'unknown' })]) {
      await writeFile(path, value, { mode: 0o600 });
      await assert.rejects(execute(process.execPath, [resolve('scripts/docker.mjs'), 'config', '--root', root], { env }), /ownership marker is unreadable or invalid/u);
      assert.equal(await stat(capture).then(() => true, () => false), false);
    }
    await rm(path); const external = join(directory, 'external-marker'); await writeFile(external, JSON.stringify(runtimeMarker())); await symlink(external, path);
    await assert.rejects(readRuntimeOrchestrator(root), /ownership marker is unreadable or invalid/u);
    await rm(path); await mkdir(path); await assert.rejects(readRuntimeOrchestrator(root), /ownership marker is unreadable or invalid/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Compose fallback uses every fixed release image and records phase only after command success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runtime-images-'));
  try {
    const binary = join(directory, 'bin'); const root = join(directory, 'root'); const path = join(root, 'config', 'runtime-orchestrator.json'); const capture = join(directory, 'calls');
    await mkdir(binary); await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'compose.env'), `STUDIO_UID=${JSON.stringify(String(process.getuid?.() ?? 1000))}\nSTUDIO_GID=${JSON.stringify(String(process.getgid?.() ?? 1000))}\nSTUDIO_APPLICATION_IMAGE="content-studio:old"\nSTUDIO_MODEL_IMAGE="old-model"\nSTUDIO_RENDERER_IMAGE="old-renderer"\nSTUDIO_TTS_IMAGE="old-tts"\n`);
    await writeFile(path, JSON.stringify({ ...runtimeMarker('stopped'), orchestrator: 'compose' }), { mode: 0o600 });
    await writeFile(join(binary, 'docker'), '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync(process.env.STUDIO_WRAPPER_CAPTURE,JSON.stringify({args:process.argv.slice(2),images:[process.env.STUDIO_APPLICATION_IMAGE,process.env.STUDIO_MODEL_IMAGE,process.env.STUDIO_RENDERER_IMAGE,process.env.STUDIO_TTS_IMAGE]})+"\\n");process.exit(Number(process.env.STUDIO_FIXTURE_EXIT||0));\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture, STUDIO_APPLICATION_IMAGE: 'old-process-image' };
    const command = (name: string, exit = '0') => execute(process.execPath, [resolve('scripts/docker.mjs'), name, '--root', root], { env: { ...env, STUDIO_FIXTURE_EXIT: exit } });
    await assert.rejects(command('start', '1')); assert.equal((await readRuntimeOrchestrator(root))?.phase, 'stopped');
    await command('start'); assert.equal((await readRuntimeOrchestrator(root))?.phase, 'active');
    await assert.rejects(command('stop', '1')); assert.equal((await readRuntimeOrchestrator(root))?.phase, 'active');
    await command('stop'); const marker = await readRuntimeOrchestrator(root); assert.equal(marker?.phase, 'stopped'); assert.deepEqual(marker?.images, runtimeMarker().images);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; images: string[] });
    assert.equal(calls.length, 4); for (const call of calls) assert.deepEqual(call.images, Object.values(runtimeMarker().images));
    assert.ok(calls[1]?.args.includes('up')); assert.ok(calls[3]?.args.includes('stop'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('isolated restore rewrites copied Kubernetes ownership before its first Compose command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-runtime-restore-'));
  try {
    const binary = join(directory, 'bin'); const source = join(directory, 'backup'); const root = join(directory, 'restored'); const keyPath = join(directory, 'backup.key'); const capture = join(directory, 'calls');
    await mkdir(binary); await mkdir(join(source, 'config'), { recursive: true });
    const key = randomBytes(32); await writeFile(keyPath, key, { mode: 0o600 });
    const files = { 'config/compose.env': 'STUDIO_APPLICATION_IMAGE="old-image"\n', 'config/runtime-orchestrator.json': JSON.stringify(runtimeMarker()) };
    const inventory: { key: string; size: number; sha256: string }[] = [];
    for (const [name, content] of Object.entries(files)) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(name));
      const encrypted = Buffer.concat([cipher.update(content), cipher.final()]); const bytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]); const filename = `${name}.enc`;
      await writeFile(join(source, filename), bytes); inventory.push({ key: filename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    await writeFile(join(source, 'manifest.json'), JSON.stringify({ format: 3, encryption: 'aes-256-gcm', paused: true, inventory: inventory.sort((left, right) => left.key.localeCompare(right.key)) }));
    await writeFile(join(binary, 'docker'), '#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.STUDIO_WRAPPER_CAPTURE,JSON.stringify({args:process.argv.slice(2),images:[process.env.STUDIO_APPLICATION_IMAGE,process.env.STUDIO_MODEL_IMAGE,process.env.STUDIO_RENDERER_IMAGE,process.env.STUDIO_TTS_IMAGE]}));process.exit(1);\n', { mode: 0o700 });
    const env = { ...process.env, PATH: `${binary}:${process.env.PATH ?? ''}`, STUDIO_WRAPPER_CAPTURE: capture };
    await assert.rejects(execute(process.execPath, [resolve('scripts/docker.mjs'), 'restore', '--root', root, '--source', source, '--key-file', keyPath], { env }), /docker failed/u);
    const marker = await readRuntimeOrchestrator(root); assert.equal(marker?.orchestrator, 'compose'); assert.equal(marker?.phase, 'stopped'); assert.deepEqual(marker?.images, runtimeMarker().images); assert.equal(marker?.namespace, 'fixture-runtime');
    const call = JSON.parse(await readFile(capture, 'utf8')) as { args: string[]; images: string[] }; assert.ok(call.args.includes('config')); assert.deepEqual(call.images, Object.values(runtimeMarker().images));
    const restoredConfig = await readFile(join(root, 'config', 'compose.env'), 'utf8'); assert.match(restoredConfig, /content-studio:release-fixture/u); assert.doesNotMatch(restoredConfig, /old-image/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
