const applicationNames = ['api', 'article-worker', 'video-worker', 'delivery-worker', 'model-runner', 'renderer', 'tts', 'draft-bridge'];
export { applicationNames };
const ports = { api: 4310, 'model-runner': 8910, renderer: 8900, tts: 8880, 'draft-bridge': 8915, 'knowledge-tools': 8920 };
const claims = { data: 'data', private: 'delivery-private', auth: 'model-auth', cache: 'model-cache', tts: 'tts-cache', knowledge: 'knowledge-inbox', staging: 'browser-staging' };
const volume = (name, mountPath, readOnly = false, subPath) => ({ name, mountPath, readOnly, ...(subPath ? { subPath } : {}) });
const probe = (port, path) => ({ exec: { command: ['node', '-e', `fetch('http://127.0.0.1:${port}${path}',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`] }, timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 6 });

/** Deployment concerns stay outside application/domain contracts. No secrets enter this document. */
export function kubernetesResources(settings) {
  const { namespace, node, nodeRoot, uid, gid, images, publicOrigin, bridgePort = 19527 } = settings;
  const metadata = name => ({ name, namespace, labels: { 'app.kubernetes.io/part-of': 'content-studio', 'app.kubernetes.io/name': name, ...(settings.workspaceId ? { 'studio.content/workspace': settings.workspaceId } : {}) } });
  const resources = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } }];
  for (const [name, directory] of Object.entries(claims)) {
    const pv = `${namespace}-${name}`;
    resources.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pv, labels: { 'app.kubernetes.io/part-of': 'content-studio' } }, spec: { capacity: { storage: name === 'data' ? '100Gi' : '10Gi' }, volumeMode: 'Filesystem', accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: '', local: { path: `${nodeRoot}/${directory}` }, nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [node] }] }] } } } });
    resources.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: metadata(`studio-${name}`), spec: { accessModes: ['ReadWriteOnce'], storageClassName: '', volumeName: pv, resources: { requests: { storage: name === 'data' ? '100Gi' : '10Gi' } } } });
  }
  resources.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('studio-runtime'), data: { NODE_ENV: 'production', STUDIO_CONTAINER: 'true', STUDIO_ORCHESTRATOR: 'kubernetes', STUDIO_DATA_DIR: '/data', STUDIO_LOCALFS_DIR: '/data/media/localfs', STUDIO_MODEL_EXECUTOR_URL: 'http://model-runner:8910', STUDIO_RENDERER_URL: 'http://renderer:8900', STUDIO_TTS_URL: 'http://tts:8880', STUDIO_TTS_FINGERPRINT: settings.ttsFingerprint ?? 'CONFIGURE_PINNED_TTS_FINGERPRINT', STUDIO_DRAFT_BRIDGE_URL: 'http://draft-bridge:8915', STUDIO_COMPANION_API_URL: 'http://api:4310', STUDIO_PUBLIC_ORIGIN: publicOrigin, STUDIO_INTERNAL_ORIGINS: [new URL(settings.supabaseUrl).origin, 'http://model-runner:8910', 'http://renderer:8900', 'http://tts:8880', 'http://draft-bridge:8915'].join(','), STUDIO_LISTEN_HOST: '0.0.0.0', PORT: '4310', STUDIO_WORKER_HEALTH_PORT: '8911', STUDIO_DRAFT_BRIDGE_PORT: String(bridgePort), STUDIO_KNOWLEDGE_IMPORT_DIR: '/knowledge-import' } });
  for (const name of [...applicationNames, ...(images.knowledge ? ['knowledge-tools'] : [])]) {
    const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/part-of': 'content-studio' };
    const isWorker = name.endsWith('-worker');
    const image = name === 'knowledge-tools' ? images.knowledge : name === 'model-runner' ? images.model : name === 'renderer' ? images.renderer : name === 'tts' ? images.tts : images.application;
    const mounts = name === 'knowledge-tools' ? [] : name === 'model-runner' ? [volume('auth', '/auth'), volume('cache', '/home/node/.cache')] : name === 'tts' ? [volume('tts', '/tts-cache')] : name === 'renderer' ? [volume('data', '/data/videos', true, 'videos'), volume('data', '/data/renderers', false, 'renderers')] : name === 'draft-bridge' ? [volume('private', '/data/draft-bridge', true, 'draft-bridge')] : [volume('data', '/data')];
    if (name === 'api') mounts.push(volume('knowledge', '/knowledge-import', true), volume('private', '/data/draft-bridge', false, 'draft-bridge'), volume('private', '/data/browser-publisher', false, 'browser-publisher'), volume('staging', '/data/browser-staging'));
    if (name === 'delivery-worker') mounts.push(volume('private', '/data/youtube', false, 'youtube'), volume('private', '/data/google', false, 'google'), volume('private', '/data/draft-bridge', true, 'draft-bridge'), volume('private', '/data/browser-publisher', true, 'browser-publisher'), volume('staging', '/data/browser-staging'));
    if (name === 'video-worker') mounts.push(volume('data', '/data/renderers', true, 'renderers'));
    mounts.push(volume('tmp', '/tmp'));
    const env = name === 'model-runner' ? [{ name: 'CODEX_HOME', value: '/auth' }] : name === 'tts' ? [{ name: 'PORT', value: '8880' }, { name: 'USE_GPU', value: 'false' }, { name: 'DEVICE', value: 'cpu' }, { name: 'STUDIO_TTS_CACHE_DIR', value: '/tts-cache' }] : name === 'draft-bridge' ? [{ name: 'STUDIO_DRAFT_BRIDGE_CONFIG', value: '/data/draft-bridge/config.json' }] : isWorker ? [{ name: 'STUDIO_WORKER_ROLE', value: name.replace('-worker', '') }] : [];
    const envFrom = [{ configMapRef: { name: 'studio-runtime' } }];
    if (name === 'api' || isWorker) envFrom.push({ secretRef: { name: 'studio-database' } });
    const port = isWorker ? 8911 : ports[name];
    let live = probe(port, name === 'renderer' || name === 'tts' ? '/health' : '/healthz');
    if (name === 'knowledge-tools') live = { ...live, exec: { command: ['python', '-c', `import urllib.request; urllib.request.urlopen('http://127.0.0.1:8920/healthz',timeout=4)`] } };
    if (name === 'renderer' || name === 'tts') live = { ...live, exec: { command: ['python', '-c', `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/health',timeout=4)`] } };
    const ready = name === 'knowledge-tools' ? { ...live, exec: { command: ['python', '-c', `import urllib.request; urllib.request.urlopen('http://127.0.0.1:8920/readyz',timeout=4)`] } } : name === 'model-runner' || isWorker || name === 'api' ? probe(port, '/readyz') : live;
    const container = { name, image, imagePullPolicy: 'IfNotPresent', env, envFrom, volumeMounts: mounts, securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: name !== 'tts', capabilities: { drop: ['ALL'] } }, resources: { requests: { cpu: name === 'tts' || name === 'knowledge-tools' ? '500m' : '100m', memory: name === 'tts' || name === 'knowledge-tools' ? '1Gi' : '256Mi' }, limits: { cpu: name === 'knowledge-tools' || name === 'renderer' || name === 'tts' ? '2' : '1', memory: name === 'knowledge-tools' ? '4Gi' : name === 'renderer' || name === 'tts' || name === 'model-runner' ? '2Gi' : '1Gi' } }, livenessProbe: live, readinessProbe: ready, startupProbe: { ...live, failureThreshold: name === 'tts' ? 36 : 18 } };
    if (isWorker) container.command = ['node', '--import', 'tsx', 'src/server/worker.ts'];
    if (name === 'draft-bridge') container.command = ['node', '--import', 'tsx', 'src/server/draft-bridge.ts'];
    const mounted = [...new Set(mounts.map(item => item.name))];
    resources.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(name), spec: { replicas: 0, strategy: { type: 'Recreate' }, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: { automountServiceAccountToken: false, terminationGracePeriodSeconds: 75, securityContext: { runAsNonRoot: true, runAsUser: uid, runAsGroup: gid, seccompProfile: { type: 'RuntimeDefault' } }, containers: [container], volumes: mounted.map(key => key === 'tmp' ? { name: key, emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } } : { name: key, persistentVolumeClaim: { claimName: `studio-${key}` } }) } } } });
    if (ports[name]) resources.push({ apiVersion: 'v1', kind: 'Service', metadata: metadata(name), spec: { type: name === 'api' && settings.exposePublic ? 'LoadBalancer' : 'ClusterIP', selector: labels, ports: [{ name: 'http', port: name === 'api' ? new URL(publicOrigin).port ? Number(new URL(publicOrigin).port) : 80 : ports[name], targetPort: ports[name] }] } });
    if (name === 'draft-bridge') resources.push({ apiVersion: 'v1', kind: 'Service', metadata: metadata('draft-companion'), spec: { type: settings.exposePublic ? 'LoadBalancer' : 'ClusterIP', selector: labels, ports: [{ name: 'companion', port: bridgePort, targetPort: 9527 }] } });
  }
  return resources;
}
