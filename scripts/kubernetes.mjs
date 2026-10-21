import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubernetesResources } from './kubernetes-resources.mjs';
import { readRuntimeOrchestrator, verifyPortableBackup } from './docker.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const root = resolve(flag('--root') ?? process.env.STUDIO_DOCKER_ROOT ?? join(project, '.docker'));
const namespace = flag('--namespace') ?? 'content-studio-k8s';
const directory = join(root, 'config', 'kubernetes', namespace);
const settingFile = join(directory, 'settings.json');
function reject(message) { throw new Error(message); }
export function validateNamespace(value) { if (!/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(value) || value === 'default' || value.startsWith('kube-')) reject('Use a dedicated bounded lowercase Kubernetes namespace.'); return value; }
function uuid(value) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value ?? '')) reject('A workspace UUID is required.'); return value; }
export function parsePrivateEnvironment(content) { return Object.fromEntries(content.split(/\r?\n/u).filter(line => line && !line.startsWith('#')).map(line => { const index = line.indexOf('='); const key = line.slice(0, index); if (index < 1 || !/^[A-Z][A-Z0-9_]*$/u.test(key)) reject('Invalid private configuration.'); try { return [key, JSON.parse(line.slice(index + 1))]; } catch { reject('Invalid private configuration value.'); } })); }
export function settingsFingerprint(settings) { return createHash('sha256').update(JSON.stringify(settings)).digest('hex'); }
async function privateJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600); }
async function configuration() { validateNamespace(namespace); return JSON.parse(await readFile(settingFile, 'utf8')); }
export async function adoptedRuntime(settings) {
  const marker = await readRuntimeOrchestrator(settings.mountRoot);
  if (!marker || marker.namespace !== settings.namespace || marker.context !== settings.context || marker.workspaceId !== settings.workspaceId) reject('The adopted runtime does not match this workspace, namespace and context. Inspect its private ownership marker before rollback.');
  return marker;
}
async function recordRuntime() {
  const settings = await configuration(); const phase = flag('--phase'); const orchestrator = flag('--orchestrator') ?? 'kubernetes';
  if (!['active', 'stopped'].includes(phase) || !['kubernetes', 'compose'].includes(orchestrator)) reject('Provide a valid runtime owner and phase.');
  const targetDirectory = join(settings.mountRoot, 'config'); await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const marker = await readRuntimeOrchestrator(settings.mountRoot);
  // Stopping or changing orchestrators must retain the adopted bundle, even if
  // configure has prepared another release whose preflight later failed.
  const retained = phase === 'stopped' || orchestrator === 'compose' ? marker : null;
  if (retained) await adoptedRuntime(settings);
  const images = retained?.images ?? settings.images;
  const path = join(targetDirectory, 'runtime-orchestrator.json'); const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ version: 1, orchestrator, phase, namespace: settings.namespace, context: settings.context, workspaceId: settings.workspaceId, images, updatedAt: new Date().toISOString() }, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
  console.log(JSON.stringify({ runtimeRecorded: true, orchestrator, phase, namespace: settings.namespace }));
}
async function digest(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
async function fileSamples(dataRoot) {
  const samples = [];
  async function inspect(path, depth, limit) {
    if (depth > 7 || samples.length >= limit) return;
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'runtime.env' || /auth|journal|secrets/iu.test(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await inspect(child, depth + 1, limit);
      else if (entry.isFile()) samples.push({ path: child.slice(dataRoot.length + 1), hash: await digest(child) });
      if (samples.length >= limit) return;
    }
  }
  for (const name of ['media', 'content', 'videos', 'renderers']) await inspect(join(dataRoot, name), 0, samples.length + 2).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return samples;
}

async function configure() {
  validateNamespace(namespace);
  const env = parsePrivateEnvironment(await readFile(join(root, 'config', 'application.env'), 'utf8'));
  const compose = parsePrivateEnvironment(await readFile(join(root, 'config', 'compose.env'), 'utf8'));
  const mode = flag('--mode') ?? 'fixture'; if (!['fixture', 'owner'].includes(mode)) reject('Mode must be fixture or owner.');
  const mountRoot = resolve(flag('--mount-root') ?? (mode === 'owner' ? root : join(root, 'kubernetes-fixtures', namespace)));
  if (mode === 'fixture' && mountRoot === root) reject('Fixture runtime must use an isolated root.');
  if (mode === 'owner' && mountRoot !== root) reject('Owner adoption uses the existing authoritative root; copying is not supported.');
  const node = flag('--node'); const nodeRoot = flag('--node-root');
  if (!node || !nodeRoot || !isAbsolute(nodeRoot) || /[\r\n]/u.test(nodeRoot)) reject('Provide the verified Kubernetes node hostname and absolute node-visible root.');
  const supabaseUrl = flag('--supabase-url'); const url = new URL(supabaseUrl ?? 'invalid:');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || ['127.0.0.1', 'localhost'].includes(url.hostname)) reject('Provide an explicit Pod-reachable Supabase origin; Pod loopback is not the Mac.');
  const names = ['data/media/localfs', 'data/videos', 'data/renderers', 'delivery-private/youtube', 'delivery-private/google', 'delivery-private/draft-bridge', 'delivery-private/browser-publisher', 'model-auth', 'model-cache', 'tts-cache', 'knowledge-inbox', 'browser-staging'];
  for (const name of names) {
    const path = join(mountRoot, name);
    if (mode === 'fixture') await mkdir(path, { recursive: true, mode: 0o700 });
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) reject('A required mount is missing or indirect; no empty owner directories are created.');
  }
  const uid = Number(compose.STUDIO_UID); const gid = Number(compose.STUDIO_GID); if (![uid, gid].every(value => Number.isInteger(value) && value > 0)) reject('A non-root UID and GID are required.');
  const workspaceId = uuid(mode === 'fixture' ? flag('--workspace-id') : env.STUDIO_WORKSPACE_ID);
  if (mode === 'fixture' && workspaceId === env.STUDIO_WORKSPACE_ID) reject('Fixture workspace must differ from the owner workspace.');
  const imageTag = flag('--image-tag') ?? 'kubernetes';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(imageTag) || imageTag === 'latest') reject('Use an immutable build tag, never latest.');
  const publicOrigin = flag('--public-origin') ?? `http://127.0.0.1:${mode === 'owner' ? compose.STUDIO_WEB_PORT : 14410}`;
  const publicUrl = new URL(publicOrigin); if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) reject('Invalid public origin.');
  const ttsFingerprint = /STUDIO_TTS_FINGERPRINT:\s*([a-f0-9]{64}:[a-f0-9]{64})/u.exec(await readFile(join(project, 'infra', 'compose.yml'), 'utf8'))?.[1];
  if (!ttsFingerprint) reject('The existing Compose CPU TTS fingerprint is missing.');
  const knowledgeImage = flag('--knowledge-image');
  if (knowledgeImage && (!/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]{1,240}$/u.test(knowledgeImage) || knowledgeImage.endsWith(':latest'))) reject('Use a pinned knowledge image.');
  const settings = { version: 1, namespace, context: flag('--context') ?? 'orbstack', sourceDockerContext: flag('--docker-context') ?? 'orbstack', mode, root, mountRoot, node, nodeRoot, uid, gid, supabaseUrl: url.origin, workspaceId, publicOrigin: publicUrl.origin, ttsFingerprint, bridgePort: Number(flag('--bridge-port') ?? (mode === 'owner' ? compose.STUDIO_DRAFT_BRIDGE_PORT ?? 19527 : 19529)), images: { ...(knowledgeImage ? { knowledge: knowledgeImage } : {}), application: `content-studio:${imageTag}`, model: `content-studio-model:${imageTag}`, renderer: `content-studio-renderer:${imageTag}`, tts: `content-studio-tts:${imageTag}` } };
  await mkdir(directory, { recursive: true, mode: 0o700 }); await privateJson(settingFile, settings);
  await privateJson(join(directory, 'secret.json'), { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'studio-database', namespace }, type: 'Opaque', stringData: { SUPABASE_URL: settings.supabaseUrl, SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY ?? reject('Supabase key is missing.'), STUDIO_WORKSPACE_ID: workspaceId } });
  console.log(JSON.stringify({ configured: true, namespace, mode, secretsPrinted: false }));
}

async function render() {
  const settings = await configuration();
  const resources = kubernetesResources({ ...settings, exposePublic: args.includes('--expose') });
  await privateJson(join(directory, 'resources.json'), { apiVersion: 'v1', kind: 'List', items: resources });
  await writeFile(join(directory, 'kustomization.yaml'), 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - resources.json\n', { mode: 0o600 });
  console.log(JSON.stringify({ rendered: true, namespace, resources: resources.length, replicas: 0, secretsPrinted: false }));
}

async function preparePreflight() {
  const settings = await configuration();
  const token = randomUUID(); const path = join(settings.mountRoot, 'data', '.kubernetes-probe', token);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const samples = await fileSamples(join(settings.mountRoot, 'data'));
  await privateJson(join(path, 'request.json'), { token, samples, fingerprint: settingsFingerprint(settings) });
  const script = `const fs=require('node:fs/promises'),crypto=require('node:crypto'),stream=require('node:fs');(async()=>{const p='/source/data/.kubernetes-probe/${token}',request=JSON.parse(await fs.readFile(p+'/request.json','utf8'));for(const sample of request.samples){const h=crypto.createHash('sha256');for await(const b of stream.createReadStream('/source/data/'+sample.path))h.update(b);if(h.digest('hex')!==sample.hash)throw Error('file_hash')}if(process.env.SUPABASE_URL!==${JSON.stringify(settings.supabaseUrl)}||process.env.STUDIO_WORKSPACE_ID!==${JSON.stringify(settings.workspaceId)})throw Error('configuration_identity');const u=process.env.SUPABASE_URL+'/rest/v1/',headers={apikey:process.env.SUPABASE_SECRET_KEY,'Content-Type':'application/json'};if(process.env.SUPABASE_SECRET_KEY.startsWith('eyJ'))headers.Authorization='Bearer '+process.env.SUPABASE_SECRET_KEY;const h=await fetch(u+'rpc/studio_runtime_health',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(10000)});if(!h.ok)throw Error('database_route');const v=await h.json();if(v.database!==true||v.pgmq!==true||v.pg_cron!==true)throw Error('database_health');const w=await fetch(u+'content_studio_workspaces?id=eq.'+process.env.STUDIO_WORKSPACE_ID+'&select=id',{headers,signal:AbortSignal.timeout(10000)});if(!w.ok)throw Error('workspace_route');const a=await w.json();if(${JSON.stringify(settings.mode)}==='owner'&&!a.some(x=>x.id===process.env.STUDIO_WORKSPACE_ID))throw Error('workspace_identity');const f=await fs.open(p+'/result.tmp','wx',384);await f.writeFile(JSON.stringify({token:request.token,fingerprint:request.fingerprint,database:true,files:true}));await f.sync();await f.close();await fs.rename(p+'/result.tmp',p+'/result.json');console.log('Runtime network, workspace and shared-file probe passed.')})().catch(()=>{console.error('Runtime preflight failed; no credentials or response bodies are logged.');process.exit(1)})`;
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'studio-preflight', namespace }, spec: { restartPolicy: 'Never', nodeSelector: { 'kubernetes.io/hostname': settings.node }, automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: settings.uid, runAsGroup: settings.gid, seccompProfile: { type: 'RuntimeDefault' } }, containers: [{ name: 'probe', image: settings.images.application, imagePullPolicy: 'IfNotPresent', command: ['node', '-e', script], envFrom: [{ secretRef: { name: 'studio-database' } }], volumeMounts: [{ name: 'source', mountPath: '/source/data' }], securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } }, resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } } }], volumes: [{ name: 'source', persistentVolumeClaim: { claimName: 'studio-data' } }] } };
  await privateJson(join(directory, 'probe.json'), pod); await privateJson(join(directory, 'probe-state.json'), { token, path });
  console.log(JSON.stringify({ prepared: true, namespace, sourceMutations: 'temporary isolated probe only' }));
}

async function recordPreflight() {
  const settings = await configuration(); const probe = JSON.parse(await readFile(join(directory, 'probe-state.json'), 'utf8'));
  const expected = join(settings.mountRoot, 'data', '.kubernetes-probe', probe.token);
  if (probe.path !== expected || !/^[a-f0-9-]{36}$/u.test(probe.token)) reject('Invalid preflight marker.');
  const result = JSON.parse(await readFile(join(expected, 'result.json'), 'utf8'));
  if (result.token !== probe.token || result.fingerprint !== settingsFingerprint(settings) || result.database !== true || result.files !== true) reject('Pod preflight did not prove the configured database and exact shared directory.');
  await privateJson(join(directory, 'preflight.json'), { ...result, checkedAt: new Date().toISOString() });
  await rm(expected, { recursive: true });
  console.log(JSON.stringify({ preflight: true, namespace, database: true, samePhysicalFiles: true }));
}

function freshTimestamp(value, maximumAge, at) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= at && at - timestamp <= maximumAge;
}
export function validateCutoverEvidence(settings, preflight, evidence, at = Date.now(), backupDirectory = evidence.backupDirectory) {
  if (settings.mode !== 'owner') reject('Only owner configuration can adopt the owner workspace.');
  const fingerprint = settingsFingerprint(settings);
  if (preflight.fingerprint !== fingerprint || !freshTimestamp(preflight.checkedAt, 3600000, at)) reject('Run a fresh owner preflight before cutover.');
  if (evidence.sourceRoot !== settings.root || evidence.context !== settings.context || evidence.workspaceId !== settings.workspaceId || !freshTimestamp(evidence.checkedAt, 86400000, at)) reject('Acceptance evidence does not match this owner configuration or is stale.');
  if (evidence.settingsFingerprint !== fingerprint) reject('Acceptance evidence must identify this exact candidate configuration and image bundle.');
  const imageEntries = images => images && typeof images === 'object' && !Array.isArray(images) ? Object.entries(images).sort(([left], [right]) => left.localeCompare(right)) : [];
  if (JSON.stringify(imageEntries(evidence.images)) !== JSON.stringify(imageEntries(settings.images))) reject('Acceptance image bundle differs from the candidate release.');
  for (const key of ['typecheck', 'tests', 'fixtureFlow', 'videoDecode', 'restartRecovery', 'noDuplicateDelivery']) if (evidence.checks?.[key] !== true) reject(`Acceptance evidence is missing ${key}.`);
  if (!isAbsolute(evidence.backupDirectory ?? '')) reject('A verified external backup is required.');
  if (evidence.backupDirectory === settings.root || evidence.backupDirectory.startsWith(`${settings.root}/`)) reject('Backup must stay outside the authoritative root.');
  if (!isAbsolute(backupDirectory ?? '') || resolve(backupDirectory) !== resolve(evidence.backupDirectory)) reject('The requested backup must match the acceptance evidence backup directory.');
}

async function gate() {
  const settings = await configuration(); const preflight = JSON.parse(await readFile(join(directory, 'preflight.json'), 'utf8'));
  if (preflight.fingerprint !== settingsFingerprint(settings) || !freshTimestamp(preflight.checkedAt, 3600000, Date.now())) reject('A fresh matching Pod preflight is required.');
  if (args[0] === 'gate-cutover') {
    const evidence = JSON.parse(await readFile(flag('--evidence') ?? reject('Provide --evidence acceptance.json.'), 'utf8'));
    validateCutoverEvidence(settings, preflight, evidence, Date.now(), flag('--backup') ?? reject('Provide --backup with the verified acceptance backup directory.')); await verifyPortableBackup(evidence.backupDirectory);
    await privateJson(join(directory, 'cutover-gate.json'), { checkedAt: new Date().toISOString(), fingerprint: settingsFingerprint(settings), backupDirectory: evidence.backupDirectory });
  } else if (settings.mode !== 'fixture') reject('Owner services start only through the cutover gate.');
  console.log(JSON.stringify({ gate: true, namespace, mode: settings.mode }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (args[0] === 'configure') await configure();
    else if (args[0] === 'render') await render();
    else if (args[0] === 'prepare-preflight') await preparePreflight();
    else if (args[0] === 'record-preflight') await recordPreflight();
    else if (args[0] === 'record-runtime') await recordRuntime();
    else if (args[0] === 'assert-scope') { const settings = await configuration(); if (settings.context !== flag('--context') || settings.sourceDockerContext !== flag('--docker-context')) reject('Runtime contexts differ from the saved configuration. Pass its exact Kubernetes and source Docker contexts.'); }
    else if (['gate-start', 'gate-cutover'].includes(args[0])) await gate();
    else if (args[0] === 'settings') { const settings = await configuration(); const key = flag('--key'); const imageKeys = { applicationImage: 'application', modelImage: 'model', rendererImage: 'renderer', ttsImage: 'tts', knowledgeImage: 'knowledge' }; if (Object.hasOwn(imageKeys, key)) console.log(settings.images[imageKeys[key]]); else { if (!['context', 'sourceDockerContext', 'mode', 'root', 'mountRoot', 'node', 'namespace', 'workspaceId'].includes(key)) reject('Unsupported public setting.'); console.log(settings[key]); } }
    else if (args[0] === 'adopted-image') { const component = flag('--component'); if (!['application', 'model', 'renderer', 'tts', 'knowledge'].includes(component)) reject('Unsupported image component.'); console.log((await adoptedRuntime(await configuration())).images[component]); }
    else if (args[0] === 'verify-backup') { await verifyPortableBackup(flag('--source') ?? reject('Provide --source backup-folder.')); console.log('Portable backup hashes verified.'); }
    else reject('Use configure, render, prepare-preflight, record-preflight, gate-start or gate-cutover.');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Kubernetes runtime operation failed.'); process.exitCode = 1; }
}
