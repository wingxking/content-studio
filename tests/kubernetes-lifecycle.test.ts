import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const eventSchema = z.object({ tool: z.string(), args: z.array(z.string()), root: z.string().optional(), project: z.string().optional(), images: z.array(z.string().nullable()).optional() });

test('rollback waits for every Kubernetes writer before starting only the fixed Compose application bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-lifecycle-'));
  const binaries = join(directory, 'bin'); const root = join(directory, 'private runtime'); const events = join(directory, 'events.jsonl');
  const bundle = { application: 'content-studio:verified-release', model: 'content-studio-model:verified-release', renderer: 'content-studio-renderer:verified-release', tts: 'content-studio-tts:verified-release' };
  try {
    await mkdir(binaries); await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'compose.env'), '');
    const executable = `#!${process.execPath}\n` + String.raw`
const {appendFileSync}=require('node:fs');
const tool=require('node:path').basename(process.argv[1]);const args=process.argv.slice(2);
appendFileSync(process.env.STUDIO_TEST_EVENTS,JSON.stringify({tool,args,root:process.env.STUDIO_DOCKER_ROOT,project:process.env.STUDIO_PROJECT_DIR,images:['STUDIO_APPLICATION_IMAGE','STUDIO_MODEL_IMAGE','STUDIO_RENDERER_IMAGE','STUDIO_TTS_IMAGE'].map(key=>process.env[key]??null)})+'\n');
if(tool==='docker'&&args.includes('settings')){const key=args[args.indexOf('--key')+1];console.log(key==='mode'?'owner':'unadopted-next-release');}
if(tool==='docker'&&args.includes('adopted-image'))console.log(JSON.parse(process.env.STUDIO_TEST_BUNDLE)[args[args.indexOf('--component')+1]]);
if(tool==='kubectl'&&args.includes('get')&&args.includes('pods'))console.log('pod/last-writer');
`;
    for (const name of ['docker', 'kubectl']) await writeFile(join(binaries, name), executable, { mode: 0o700 });
    await promisify(execFile)('sh', [join(project, 'scripts', 'kubernetes.sh'), 'rollback', '--root', root, '--namespace', 'studio-test'], { env: { ...process.env, PATH: `${binaries}:${process.env.PATH ?? ''}`, STUDIO_TEST_EVENTS: events, STUDIO_TEST_BUNDLE: JSON.stringify(bundle), STUDIO_DOCKER_ROOT: '/wrong-root', STUDIO_PROJECT_DIR: '/wrong-project' } });
    const calls = (await readFile(events, 'utf8')).trim().split('\n').map(line => eventSchema.parse(JSON.parse(line)));
    const up = calls.findIndex(call => call.tool === 'docker' && call.args.includes('compose') && call.args.includes('up'));
    const waited = calls.findIndex(call => call.tool === 'kubectl' && call.args.includes('wait') && call.args.includes('--for=delete'));
    const composeOwner = calls.findIndex(call => call.tool === 'docker' && call.args.includes('record-runtime') && call.args.includes('compose') && call.args.includes('stopped'));
    assert.ok(waited >= 0 && composeOwner > waited && up > composeOwner, 'No Compose application starts before all Kubernetes writers exit and ownership transfers.');
    const start = calls[up]; assert.ok(start);
    assert.ok(start.args.includes('--no-deps')); assert.ok(start.args.includes('--wait'));
    assert.deepEqual(start.args.slice(start.args.indexOf('--wait') + 1).sort(), ['api', 'article-worker', 'delivery-worker', 'draft-bridge', 'model-runner', 'renderer', 'tts', 'video-worker']);
    assert.equal(start.root, root); assert.equal(start.project, project);
    assert.deepEqual(start.images, Object.values(bundle));
    assert.equal(calls.filter(call => call.tool === 'docker' && call.args.includes('compose') && call.args.includes('up')).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
