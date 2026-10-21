import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { copyBackupTrees } from '../scripts/docker.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eventSchema = z.object({ tool: z.string(), args: z.array(z.string()), locked: z.boolean() });
const execute = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'studio-kubernetes-lock-'));
  const root = join(directory, 'private runtime'); const binaries = join(directory, 'bin'); const events = join(directory, 'events.jsonl');
  const held = join(directory, 'held'); const release = join(directory, 'release'); const lock = join(root, '.kubernetes-lifecycle-lock');
  await mkdir(binaries); await mkdir(join(root, 'config'), { recursive: true }); await writeFile(join(root, 'config', 'compose.env'), '');
  const executable = `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs'),path=require('node:path');
const tool=path.basename(process.argv[1]),args=process.argv.slice(2);
fs.appendFileSync(process.env.STUDIO_TEST_EVENTS,JSON.stringify({tool,args,locked:fs.existsSync(process.env.STUDIO_TEST_LOCK)})+'\n');
(async()=>{
 if(tool==='docker'&&args.includes('image')&&args.includes('inspect')&&process.env.STUDIO_TEST_MISSING_IMAGE==='true')process.exit(1);
 if(tool==='docker'&&args.includes('run')&&args.some(value=>value.includes("readFileSync('/opt/content-studio/docker.mjs')"))&&process.env.STUDIO_TEST_MISSING_IMAGE==='true')process.exit(1);
 if(tool==='docker'&&args.includes('settings'))console.log(args[args.indexOf('--key')+1]==='mode'?'owner':'fixture-workspace');
 if(tool==='kubectl'&&args.includes('get')&&args.includes('pods'))console.log('pod/last-writer');
 if(tool==='kubectl'&&args.includes('current-context'))console.log('original-context');
 if(tool==='kubectl'&&args.includes('scale')&&args.includes('deployment/api')&&args.includes('--replicas=0')){
  if(process.env.STUDIO_TEST_FAIL_SCALE==='true')process.exit(17);
  if(process.env.STUDIO_TEST_BLOCK_SCALE==='true'){
   fs.writeFileSync(process.env.STUDIO_TEST_HELD,'held');
   while(!fs.existsSync(process.env.STUDIO_TEST_RELEASE))await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
 if(tool==='orb'){
  if(process.env.STUDIO_TEST_FAIL_ENABLE==='true')process.exit(19);
  if(process.env.STUDIO_TEST_BLOCK_ENABLE==='true'){
   fs.writeFileSync(process.env.STUDIO_TEST_HELD,'held');
   while(!fs.existsSync(process.env.STUDIO_TEST_RELEASE))await new Promise(resolve=>setTimeout(resolve,10));
  }
 }
})().catch(()=>process.exit(1));
`;
  for (const name of ['docker', 'kubectl', 'orb']) await writeFile(join(binaries, name), executable, { mode: 0o700 });
  const environment = { ...process.env, PATH: `${binaries}:${process.env.PATH ?? ''}`, STUDIO_TEST_EVENTS: events, STUDIO_TEST_LOCK: lock, STUDIO_TEST_HELD: held, STUDIO_TEST_RELEASE: release, STUDIO_BACKUP_ROOT: join(directory, 'backups') };
  const args = (action: string) => [join(project, 'scripts', 'kubernetes.sh'), action, '--root', root, '--namespace', 'studio-test'];
  const run = (action: string, extra: string[] = [], values: Record<string, string> = {}) => execute('sh', [...args(action), ...extra], { env: { ...environment, ...values } });
  const start = (action: string, values: Record<string, string>) => {
    const child = spawn('sh', args(action), { env: { ...environment, ...values }, stdio: 'ignore' });
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    return { child, result };
  };
  const calls = async () => (await readFile(events, 'utf8')).trim().split('\n').filter(Boolean).map(line => eventSchema.parse(JSON.parse(line)));
  const waitHeld = async () => { for (let index = 0; index < 200; index++) { if (await stat(held).then(() => true).catch(() => false)) return; await delay(10); } throw new Error('Lifecycle fixture did not reach its controlled wait.'); };
  return { directory, root, events, held, release, lock, environment, run, start, calls, waitHeld };
}

test('Kubernetes root mutations are exclusive while status remains usable and the next start cannot be hidden by an older stop', async () => {
  const f = await fixture(); const stop = f.start('stop', { STUDIO_TEST_BLOCK_SCALE: 'true' });
  try {
    await f.waitHeld();
    assert.equal((await stat(f.lock)).mode & 0o777, 0o700);
    for (const name of ['storage', 'data', 'model-auth', 'model-cache', 'delivery-private', 'tts-cache']) await mkdir(join(f.root, name));
    const backup = join(f.directory, 'backup-copy'); await copyBackupTrees(f.root, backup);
    await assert.rejects(stat(join(backup, '.kubernetes-lifecycle-lock')), /ENOENT/u);
    const before = (await f.calls()).length;
    for (const action of ['configure', 'render', 'validate', 'preflight', 'start', 'stop', 'backup', 'cutover', 'rollback', 'enable']) {
      await assert.rejects(f.run(action), /Another Kubernetes lifecycle operation owns this root: stop in studio-test/u);
    }
    assert.equal((await f.calls()).length, before, 'Rejected mutations cannot run Docker or Kubernetes commands.');
    await f.run('status');
    assert.ok((await f.calls()).some(call => call.tool === 'kubectl' && call.args.includes('deployments,pods,services,pvc')));
    await writeFile(f.release, 'release'); assert.equal((await stop.result).code, 0);
    await assert.rejects(stat(f.lock), /ENOENT/u);
    await f.run('start');
    const calls = await f.calls();
    const lastHide = calls.findLastIndex(call => call.tool === 'kubectl' && call.args.includes('patch'));
    const firstStart = calls.findIndex(call => call.tool === 'kubectl' && call.args.includes('--replicas=1'));
    assert.ok(lastHide >= 0 && firstStart > lastHide, 'Every old stop mutation finishes before a new start can acquire ownership.');
    await assert.rejects(stat(f.lock), /ENOENT/u);
  } finally { await writeFile(f.release, 'release'); await stop.result; await rm(f.directory, { recursive: true, force: true }); }
});

test('failed Kubernetes actions release their own mutex and do not block the next configuration', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run('stop', [], { STUDIO_TEST_FAIL_SCALE: 'true' }));
    await assert.rejects(stat(f.lock), /ENOENT/u);
    await f.run('configure'); await assert.rejects(stat(f.lock), /ENOENT/u);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('SIGTERM preserves ownership until the active command finishes, restores context and releases the mutex', async () => {
  const f = await fixture(); const enable = f.start('enable', { STUDIO_TEST_BLOCK_ENABLE: 'true' });
  try {
    await f.waitHeld(); enable.child.kill('SIGTERM'); await delay(100);
    assert.ok(await stat(f.lock));
    await assert.rejects(f.run('configure'), /Another Kubernetes lifecycle operation/u);
    await writeFile(f.release, 'release'); assert.equal((await enable.result).code, 143);
    const restore = (await f.calls()).find(call => call.tool === 'kubectl' && call.args.includes('use-context'));
    assert.ok(restore); assert.ok(restore.args.includes('original-context')); assert.equal(restore.locked, true);
    await assert.rejects(stat(f.lock), /ENOENT/u);
    await f.run('configure');
  } finally { await writeFile(f.release, 'release'); await enable.result; await rm(f.directory, { recursive: true, force: true }); }
});

test('failed cluster enable restores the previous context before releasing lifecycle ownership', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run('enable', [], { STUDIO_TEST_FAIL_ENABLE: 'true' }));
    assert.ok((await f.calls()).some(call => call.tool === 'kubectl' && call.args.includes('use-context') && call.args.includes('original-context') && call.locked));
    await assert.rejects(stat(f.lock), /ENOENT/u);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('cleanup cannot remove a replacement lock and interrupted ownership fails closed', async () => {
  const f = await fixture(); const stop = f.start('stop', { STUDIO_TEST_BLOCK_SCALE: 'true' });
  try {
    await f.waitHeld(); await rename(f.lock, `${f.lock}-previous`); await mkdir(f.lock);
    const replacement = join(f.lock, 'owner.replacement'); await writeFile(replacement, '12345\nstart\nstudio-new\n');
    await writeFile(f.release, 'release'); assert.equal((await stop.result).code, 0);
    assert.equal(await readFile(replacement, 'utf8'), '12345\nstart\nstudio-new\n');
    await assert.rejects(f.run('configure'), /inspect running lifecycle processes/u);
    await f.run('status');
  } finally { await writeFile(f.release, 'release'); await stop.result; await rm(f.directory, { recursive: true, force: true }); }
});

test('nested Kubernetes backup keeps one mutex through Compose backup, database restart and verification', async () => {
  const f = await fixture();
  try {
    await f.run('backup', ['--target', join(f.directory, 'backup')]);
    const calls = await f.calls();
    for (const action of ['backup', 'database', 'verify-backup']) {
      assert.ok(calls.some(call => call.tool === 'docker' && call.args.includes('run') && call.args.includes(action) && call.locked), `Nested ${action} must retain the Kubernetes lifecycle mutex.`);
    }
    await assert.rejects(stat(f.lock), /ENOENT/u);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('missing cached operations images are built locally and probes never request a public pull', async () => {
  const f = await fixture();
  try {
    await f.run('configure', [], { STUDIO_TEST_MISSING_IMAGE: 'true' });
    await execute('sh', [join(project, 'scripts', 'docker.sh'), 'config', '--root', f.root], { env: { ...f.environment, STUDIO_TEST_MISSING_IMAGE: 'true' } });
    const calls = await f.calls(); const builds = calls.filter(call => call.tool === 'docker' && call.args.includes('build'));
    assert.equal(builds.length, 2);
    const probes = calls.filter(call => call.tool === 'docker' && call.args.includes('run'));
    assert.ok(probes.length >= 3);
    for (const call of probes.filter(call => call.args.some(value => value.endsWith('/kubernetes.mjs') || value.includes("readFileSync('/opt/content-studio/docker.mjs')")))) assert.equal(call.args[call.args.indexOf('--pull') + 1], 'never');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
