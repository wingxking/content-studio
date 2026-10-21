import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { applicationNames, kubernetesResources } from '../scripts/kubernetes-resources.mjs';
import { adoptedRuntime, parsePrivateEnvironment, settingsFingerprint, validateCutoverEvidence, validateNamespace } from '../scripts/kubernetes.mjs';
import { verifyPortableBackup } from '../scripts/docker.mjs';

const settings = { namespace: 'studio-fixture', node: 'orbstack', nodeRoot: '/existing-private-root', uid: 501, gid: 20, images: { application: 'studio:build-1', model: 'model:build-1', renderer: 'renderer:build-1', tts: 'tts:build-1' }, supabaseUrl: 'http://host.orb.internal:56421', publicOrigin: 'http://127.0.0.1:14410', exposePublic: true, ttsFingerprint: `${'a'.repeat(64)}:${'b'.repeat(64)}` };
const resource = z.object({ kind: z.string(), metadata: z.object({ name: z.string() }), spec: z.record(z.string(), z.unknown()).optional() });
test('Kubernetes only deploys existing application roles with retained single-node storage', () => {
  const resources = z.array(resource).parse(kubernetesResources(settings));
  assert.equal(resources.filter(item => item.kind === 'Deployment').length, 8);
  assert.equal(resources.some(item => ['CronJob', 'StatefulSet', 'Secret'].includes(item.kind)), false);
  for (const deployment of resources.filter(item => item.kind === 'Deployment')) {
    assert.ok(applicationNames.includes(deployment.metadata.name));
    assert.equal(deployment.spec?.replicas, 0);
    assert.deepEqual(deployment.spec?.strategy, { type: 'Recreate' });
    const template = z.object({ spec: z.object({ automountServiceAccountToken: z.literal(false), securityContext: z.object({ runAsUser: z.literal(501), runAsGroup: z.literal(20) }), containers: z.array(z.object({ imagePullPolicy: z.literal('IfNotPresent'), readinessProbe: z.object({ exec: z.object({ command: z.array(z.string()) }) }), volumeMounts: z.array(z.object({ mountPath: z.string() })) })) }) }).parse(deployment.spec?.template);
    assert.equal(template.spec.containers.length, 1);
    assert.ok(template.spec.containers[0]?.readinessProbe.exec.command.join(' ').includes('127.0.0.1'));
  }
  for (const pv of resources.filter(item => item.kind === 'PersistentVolume')) {
    assert.equal(pv.spec?.persistentVolumeReclaimPolicy, 'Retain');
    assert.ok(JSON.stringify(pv.spec?.local).includes(settings.nodeRoot));
    assert.ok(pv.spec?.nodeAffinity);
  }
  const publicServices = resources.filter(item => item.kind === 'Service' && item.spec?.type === 'LoadBalancer');
  assert.deepEqual(publicServices.map(item => item.metadata.name).sort(), ['api', 'draft-companion']);
  assert.equal(JSON.stringify(publicServices).includes('8915'), false);
  assert.ok(JSON.stringify(resources.find(item => item.kind === 'Deployment' && item.metadata.name === 'tts')).includes('"name":"PORT","value":"8880"'));
  assert.equal(JSON.stringify(kubernetesResources({ ...settings, exposePublic: false })).includes('LoadBalancer'), false);
});

test('private mounts keep model and delivery credentials away from article and video workers', () => {
  const resources = z.array(resource).parse(kubernetesResources(settings));
  const deployment = (name: string) => resources.find(item => item.kind === 'Deployment' && item.metadata.name === name);
  for (const name of ['article-worker', 'video-worker', 'renderer', 'tts']) assert.equal(JSON.stringify(deployment(name)).includes('studio-private'), false);
  assert.equal(JSON.stringify(deployment('api')).includes('"subPath":"youtube"'), false);
  assert.ok(JSON.stringify(deployment('delivery-worker')).includes('"subPath":"youtube"'));
  assert.ok(JSON.stringify(deployment('model-runner')).includes('studio-auth'));
});

test('owner adoption requires fresh matching fixture evidence and all acceptance gates', () => {
  const at = Date.now(); const owner = { ...settings, mode: 'owner', root: '/existing-private-root', context: 'orbstack', workspaceId: 'workspace' };
  const preflight = { fingerprint: settingsFingerprint(owner), checkedAt: new Date(at).toISOString() };
  const evidence = { sourceRoot: owner.root, context: owner.context, workspaceId: owner.workspaceId, settingsFingerprint: settingsFingerprint(owner), images: owner.images, checkedAt: new Date(at).toISOString(), backupDirectory: '/private-backups/verified', checks: { typecheck: true, tests: true, fixtureFlow: true, videoDecode: true, restartRecovery: true, noDuplicateDelivery: true } };
  assert.doesNotThrow(() => validateCutoverEvidence(owner, preflight, evidence, at));
  assert.throws(() => validateCutoverEvidence(owner, preflight, { ...evidence, checks: { ...evidence.checks, videoDecode: false } }, at), /videoDecode/u);
  assert.throws(() => validateCutoverEvidence(owner, { ...preflight, fingerprint: 'other' }, evidence, at), /preflight/u);
  assert.throws(() => validateCutoverEvidence(owner, preflight, { ...evidence, sourceRoot: '/copy' }, at), /match/u);
  assert.throws(() => validateCutoverEvidence(owner, preflight, evidence, at + 3600001), /preflight/u);
  assert.throws(() => validateCutoverEvidence(owner, { ...preflight, checkedAt: new Date(at + 1).toISOString() }, evidence, at), /preflight/u);
  assert.throws(() => validateCutoverEvidence(owner, preflight, { ...evidence, checkedAt: new Date(at + 1).toISOString() }, at), /match/u);
  assert.throws(() => validateCutoverEvidence(owner, preflight, { ...evidence, settingsFingerprint: 'different-release' }, at), /exact candidate/u);
  assert.throws(() => validateCutoverEvidence(owner, preflight, { ...evidence, images: { ...owner.images, application: 'studio:untested-release' } }, at), /image bundle/u);
  assert.throws(() => validateCutoverEvidence(owner, preflight, evidence, at, '/private-backups/another-release'), /backup must match/u);
  assert.doesNotThrow(() => validateCutoverEvidence(owner, preflight, { ...evidence, images: Object.fromEntries(Object.entries(owner.images).reverse()) }, at, '/private-backups/verified'));
  const next = { ...owner, images: { ...owner.images, application: 'studio:next-release' } };
  assert.throws(() => validateCutoverEvidence(next, { ...preflight, fingerprint: settingsFingerprint(next) }, evidence, at), /exact candidate/u);
});

test('configuration rejects path injection and environment parsing never evaluates shell code', () => {
  assert.throws(() => validateNamespace('../../owner'), /namespace/u);
  assert.deepEqual(parsePrivateEnvironment('SUPABASE_URL="http://example"\nSTUDIO_NOTE="$(no-command)"\n'), { SUPABASE_URL: 'http://example', STUDIO_NOTE: '$(no-command)' });
});

test('runtime ownership records the verified image bundle only in its configured authority root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kubernetes-owner-'));
  const mountRoot = join(directory, 'isolated-fixture');
  const privateDirectory = join(directory, 'config', 'kubernetes', settings.namespace);
  try {
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(join(privateDirectory, 'settings.json'), JSON.stringify({ ...settings, mountRoot, context: 'orbstack', sourceDockerContext: 'desktop-linux', workspaceId: 'fixture-workspace' }));
    const script = new URL('../scripts/kubernetes.mjs', import.meta.url).pathname;
    const argumentsFor = (phase: string) => [script, 'record-runtime', '--root', directory, '--namespace', settings.namespace, '--phase', phase];
    const scope = [script, 'assert-scope', '--root', directory, '--namespace', settings.namespace, '--docker-context', 'desktop-linux', '--context'];
    await promisify(execFile)(process.execPath, [...scope, 'orbstack']);
    await assert.rejects(promisify(execFile)(process.execPath, [...scope, 'unrelated-cluster']), /contexts differ/u);
    await promisify(execFile)(process.execPath, argumentsFor('active'));
    const marker = join(mountRoot, 'config', 'runtime-orchestrator.json');
    const value = z.object({ version: z.literal(1), orchestrator: z.literal('kubernetes'), phase: z.literal('active'), images: z.record(z.string(), z.string()), namespace: z.string() }).parse(JSON.parse(await readFile(marker, 'utf8')));
    assert.deepEqual(value.images, settings.images); assert.equal(value.namespace, settings.namespace);
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
    await assert.rejects(readFile(join(directory, 'config', 'runtime-orchestrator.json')), /ENOENT/u);
    // Preparing a failed upgrade must never replace the adopted recovery bundle.
    const configured = { ...settings, mountRoot, context: 'orbstack', workspaceId: 'fixture-workspace', images: { ...settings.images, application: 'studio:unadopted-next-release' } };
    await writeFile(join(privateDirectory, 'settings.json'), JSON.stringify(configured));
    assert.deepEqual((await adoptedRuntime(configured)).images, settings.images);
    await assert.rejects(adoptedRuntime({ ...configured, namespace: 'another-runtime' }), /does not match/u);
    await promisify(execFile)(process.execPath, [...argumentsFor('stopped'), '--orchestrator', 'compose']);
    assert.equal(z.object({ orchestrator: z.literal('compose'), phase: z.literal('stopped') }).parse(JSON.parse(await readFile(marker, 'utf8'))).phase, 'stopped');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')).images, settings.images);
    await assert.rejects(promisify(execFile)(process.execPath, argumentsFor('unknown')), /valid runtime/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reviewable base remains stopped and does not contain account or database credentials', async () => {
  const base = JSON.parse(await readFile(new URL('../infra/k8s/base/workloads.json', import.meta.url), 'utf8')) as { items: unknown[] };
  const resources = z.array(resource).parse(base.items);
  assert.equal(resources.filter(item => item.kind === 'Deployment').every(item => item.spec?.replicas === 0), true);
  assert.equal(JSON.stringify(base).includes('SUPABASE_SECRET_KEY'), false);
});

test('cutover backup verification rejects a tampered or incomplete encrypted inventory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kubernetes-backup-'));
  try {
    const keys = ['database.dump.enc', 'roles.sql.enc', 'pgmq-studio.json.enc', 'config/application.env.enc', 'config/compose.env.enc', 'config/supabase.compose.json.enc'].sort((a, b) => a.localeCompare(b));
    const payload = Buffer.alloc(40, 1);
    const inventory = keys.map(key => ({ key, size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }));
    for (const key of keys) { await mkdir(dirname(join(directory, key)), { recursive: true }); await writeFile(join(directory, key), payload); }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ format: 3, encryption: 'aes-256-gcm', paused: true, inventory }));
    assert.deepEqual(await verifyPortableBackup(directory), { verifiedFiles: 6 });
    await writeFile(join(directory, 'database.dump.enc'), 'tampered');
    await assert.rejects(verifyPortableBackup(directory), /hashes differ/u);
    await writeFile(join(directory, 'database.dump.enc'), payload);
    await rm(join(directory, 'roles.sql.enc'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ format: 3, encryption: 'aes-256-gcm', paused: true, inventory: inventory.filter(item => item.key !== 'roles.sql.enc') }));
    await assert.rejects(verifyPortableBackup(directory), /missing required/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
