import { spawn } from 'node:child_process';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, chmod, cp, rm, open, rename } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createConnection } from 'node:net';
import { request, createServer as createHttpServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(root, '.studio');
const network = 'content-studio-loopback';
const labelPrefix = 'com.radarxai.content-studio';
const uid = process.getuid();
const domain = `gui/${uid}`;
const bucket = 'studio-assets';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = path => stat(path).then(() => true).catch(() => false);

async function run(command, args, { cwd = root, input, outputFile, timeout = 1200000, env = {} } = {}) {
  const handle = outputFile ? await open(outputFile, 'wx', 0o600) : null;
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', handle?.fd ?? 'pipe', 'pipe'], env: { ...process.env, ...env, SUPABASE_INTERNAL_IMAGE_REGISTRY: process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY ?? 'ghcr.io' } });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', async () => { clearTimeout(timer); await handle?.close(); reject(new Error(`${command} could not start.`)); });
    child.on('close', async code => {
      clearTimeout(timer); await handle?.close();
      if (code !== 0) {
        const details = stderr.split('\n').filter(line => /error|failed|unhealthy|migration|permission denied/i.test(line) && !/key|secret|token|password|credential|jwt/i.test(line)).slice(-5).join('\n');
        reject(new Error(`${command} failed (${code}). ${details}`));
      } else accept(stdout);
    });
    child.stdin.end(input);
  });
}

async function config(workdir = root) {
  const text = await readFile(join(workdir, 'supabase/config.toml'), 'utf8');
  const projectId = /^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m.exec(text)?.[1];
  if (!projectId?.startsWith('content-studio-')) throw new Error('Refusing an unrelated Supabase project.');
  return { projectId, container: `supabase_db_${projectId}`, text };
}

async function ensureDocker(networkName) {
  try { await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }); }
  catch {
    await run('open', ['-a', 'Docker']);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }); ready = true; break; }
      catch { await sleep(2000); }
    }
    if (!ready) throw new Error('Docker Desktop is not ready; complete its system startup requirements.');
  }
  try { await run('docker', ['network', 'inspect', networkName]); }
  catch { await run('docker', ['network', 'create', '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', networkName]); }
  const networks = JSON.parse(await run('docker', ['network', 'inspect', networkName]));
  if (networks[0]?.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1') throw new Error('The local Docker network does not enforce loopback bindings.');
}

async function dockerRequest(socketPath, path, method = 'GET', body) {
  return new Promise((accept, reject) => {
    const outgoing = body === undefined ? undefined : JSON.stringify(body);
    const call = request({ socketPath, path: `/v1.51${path}`, method, headers: outgoing ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(outgoing) } : {} }, response => {
      let result = ''; response.setEncoding('utf8'); response.on('data', chunk => { result += chunk; });
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) { reject(new Error(`Local container operation failed (HTTP ${response.statusCode}).`)); return; }
        try { accept(result ? JSON.parse(result) : null); } catch { reject(new Error('Invalid local container response.')); }
      });
    });
    call.setTimeout(120000, () => call.destroy());
    call.on('error', () => reject(new Error('Local Docker socket request failed.')));
    call.end(outgoing);
  });
}

async function withLoopbackCreation(projectId, execute) {
  const endpoint = JSON.parse((await run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])).trim());
  if (!endpoint.startsWith('unix://')) throw new Error('Local runtime requires a local Docker Unix socket.');
  const actualSocket = endpoint.slice('unix://'.length);
  const folder = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), `content-studio-docker-${randomUUID()}`);
  await mkdir(folder, { mode: 0o700 });
  const proxySocket = join(folder, 'engine.sock');
  const connections = new Set();
  const proxy = createHttpServer(async (incoming, outgoing) => {
    try {
      let body;
      const create = incoming.method === 'POST' && /\/(?:containers)\/create(?:\?|$)/.test(incoming.url ?? '');
      const forwardedHeaders = { ...incoming.headers };
      if (create) {
        const chunks = []; let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          if (size > 8388608) throw new Error('Container configuration exceeds the local limit.');
          chunks.push(chunk);
        }
        const configuration = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const bindings = configuration.HostConfig?.PortBindings;
        if (bindings && Object.keys(bindings).length) {
          if (configuration.Labels?.['com.supabase.cli.project'] !== projectId) throw new Error('Container ownership mismatch.');
          configuration.HostConfig.PortBindings = Object.fromEntries(Object.entries(bindings).map(([port, values]) => [port, values?.map(value => ({ ...value, HostIp: '127.0.0.1' }))]));
        }
        body = JSON.stringify(configuration); forwardedHeaders['content-length'] = String(Buffer.byteLength(body));
        delete forwardedHeaders['transfer-encoding'];
      }
      const upstream = request({ socketPath: actualSocket, method: incoming.method, path: incoming.url, headers: forwardedHeaders }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
      });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end('Local Docker request failed.'); });
      outgoing.on('close', () => upstream.destroy());
      if (create) upstream.end(body); else incoming.pipe(upstream);
    } catch { if (!outgoing.headersSent) outgoing.writeHead(400); outgoing.end('Local container ownership or configuration check failed.'); }
  });
  proxy.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  proxy.on('upgrade', (incoming, client, head) => {
    const upstream = createConnection(actualSocket);
    upstream.once('connect', () => {
      const fields = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) fields.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${fields.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
  });
  try {
    await new Promise((accept, reject) => { proxy.once('error', reject); proxy.listen(proxySocket, accept); });
    await chmod(proxySocket, 0o600);
    return await execute({ DOCKER_HOST: `unix://${proxySocket}`, DOCKER_CONTEXT: undefined });
  } finally {
    for (const socket of connections) socket.destroy();
    proxy.closeAllConnections(); await new Promise(accept => proxy.close(accept));
    await rm(folder, { recursive: true, force: true });
  }
}

async function bindLoopback(workdir) {
  const { projectId } = await config(workdir);
  const ids = (await run('docker', ['ps', '-a', '--filter', `label=com.supabase.cli.project=${projectId}`, '-q'])).trim().split('\n').filter(Boolean);
  const replacements = [];
  for (const id of ids) {
    const original = JSON.parse(await run('docker', ['inspect', id]))[0];
    const bindings = original.HostConfig.PortBindings ?? {};
    if (!Object.values(bindings).some(values => values?.some(value => value.HostIp !== '127.0.0.1'))) continue;
    if (original.Config.Labels?.['com.supabase.cli.project'] !== projectId) throw new Error('Container ownership check failed.');
    const ports = Object.fromEntries(Object.entries(bindings).map(([port, values]) => [port, values?.map(value => ({ ...value, HostIp: '127.0.0.1' }))]));
    const endpoints = Object.fromEntries(Object.entries(original.NetworkSettings.Networks).map(([name, settings]) => [name, { Aliases: settings.Aliases?.filter(alias => alias !== id && alias !== id.slice(0, 12)) }]));
    replacements.push({ name: original.Name.slice(1), body: { ...original.Config, HostConfig: { ...original.HostConfig, PortBindings: ports }, NetworkingConfig: { EndpointsConfig: endpoints } } });
  }
  if (!replacements.length) return;
  const endpoint = JSON.parse((await run('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])).trim());
  if (!endpoint.startsWith('unix://')) throw new Error('Local loopback binding requires the local Docker Unix socket.');
  const socketPath = endpoint.slice('unix://'.length);
  const journal = join(workdir, '.studio/container-rebind'); await mkdir(journal, { recursive: true, mode: 0o700 });
  // Preserve a private recovery description before replacing containers; named data volumes stay intact.
  await writeFile(join(journal, `${projectId}.json`), JSON.stringify(replacements), { mode: 0o600 });
  await run('docker', ['stop', '--time', '10', ...replacements.map(item => item.name)]);
  await run('docker', ['rm', ...replacements.map(item => item.name)]);
  for (const item of replacements) await dockerRequest(socketPath, `/containers/create?name=${encodeURIComponent(item.name)}`, 'POST', item.body);
  replacements.sort((a, b) => Number(!a.name.startsWith('supabase_db_')) - Number(!b.name.startsWith('supabase_db_')));
  for (const item of replacements) await dockerRequest(socketPath, `/containers/${encodeURIComponent(item.name)}/start`, 'POST');
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const current = (await run('docker', ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean);
    if (current.length === ids.length) {
      const states = await Promise.all(current.map(name => run('docker', ['inspect', name]).then(value => JSON.parse(value)[0].State)));
      if (states.every(state => state.Running && (!state.Health || state.Health.Status === 'healthy'))) return;
    }
    await sleep(2000);
  }
  throw new Error('Local containers did not recover after loopback binding. Named data volumes were preserved.');
}

async function stack(workdir = root, applyMigrations = false) {
  const networkName = workdir === root ? network : `${network}-${(await config(workdir)).projectId}`;
  await ensureDocker(networkName);
  await withLoopbackCreation((await config(workdir)).projectId, env => run('supabase', ['start', '--network-id', networkName, '--exclude', 'imgproxy'], { cwd: workdir, timeout: 3600000, env }));
  await bindLoopback(workdir);
  if (applyMigrations) await run('supabase', ['migration', 'up', '--local'], { cwd: workdir });
  const status = JSON.parse(await run('supabase', ['status', '--output', 'json'], { cwd: workdir }));
  const url = new URL(status.API_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !status.SERVICE_ROLE_KEY) throw new Error('Local Supabase did not return a valid loopback configuration.');
  return status;
}

function headers(runtime) {
  return { apikey: runtime.SUPABASE_SECRET_KEY, Authorization: `Bearer ${runtime.SUPABASE_SECRET_KEY}` };
}

async function api(runtime, path, { method = 'GET', body, extraHeaders = {}, raw = false } = {}) {
  const response = await fetch(`${runtime.SUPABASE_URL}${path}`, {
    method, headers: { ...headers(runtime), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Local service request failed (HTTP ${response.status}, ${path.split('?')[0]}).`);
  if (raw) return Buffer.from(await response.arrayBuffer());
  const text = await response.text(); return text ? JSON.parse(text) : null;
}

async function runtimeFile(directory = data) {
  const text = await readFile(join(directory, 'runtime.env'), 'utf8');
  let runtime;
  try {
    runtime = Object.fromEntries(text.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
      const split = line.indexOf('='); const name = line.slice(0, split); const value = JSON.parse(line.slice(split + 1));
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') throw new Error('Invalid private value.');
      return [name, value];
    }));
    if (new URL(runtime.SUPABASE_URL).hostname !== '127.0.0.1') throw new Error('Invalid local endpoint.');
  } catch { throw new Error('Invalid private local runtime configuration; original files were preserved.'); }
  return runtime;
}

async function saveRuntime(status, directory = data, workspaceId) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const previous = await exists(join(directory, 'runtime.env')) ? await runtimeFile(directory) : null;
  const runtime = {
    SUPABASE_URL: status.API_URL, SUPABASE_SECRET_KEY: status.SERVICE_ROLE_KEY,
    STUDIO_WORKSPACE_ID: workspaceId ?? previous?.STUDIO_WORKSPACE_ID ?? randomUUID(),
    STUDIO_DATA_DIR: directory, STUDIO_LOCAL_RUNTIME: 'true',
  };
  const temporary = join(directory, `.runtime-${randomUUID()}.tmp`);
  await writeFile(temporary, Object.entries(runtime).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, 'runtime.env'));
  await chmod(join(directory, 'runtime.env'), 0o600); return runtime;
}

async function sql(statement, workdir = root, outputFile) {
  const { container } = await config(workdir);
  return run('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, outputFile });
}

async function pause(runtime) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const rows = await api(runtime, `/rest/v1/content_studio_workspaces?id=eq.${runtime.STUDIO_WORKSPACE_ID}&select=id,state,revision`);
    const row = rows[0];
    if (!row) throw new Error('The local workspace is missing; preserve and inspect its backup before continuing.');
    const result = await api(runtime, `/rest/v1/content_studio_workspaces?id=eq.${row.id}&revision=eq.${row.revision}`, {
      method: 'PATCH', body: { state: { ...row.state, paused: true }, revision: row.revision + 1 }, extraHeaders: { Prefer: 'return=representation' },
    });
    if (result.length === 1 && result[0].state.paused === true) return;
  }
  throw new Error('The local workspace kept changing; backup was stopped without overwriting another writer.');
}

async function applicationCounts(workdir = root) {
  const names = (await sql("select tablename from pg_tables where schemaname='public' and tablename<>'studio_queue_leases' order by tablename;", workdir)).trim().split('\n').filter(Boolean);
  const counts = {};
  for (const name of names) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Unexpected application table name.');
    counts[name] = Number((await sql(`select count(*) from public.${name};`, workdir)).trim());
  }
  return counts;
}

async function fileInventory(directory, prefix = '') {
  const result = [];
  if (!await exists(directory)) return result;
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await fileInventory(join(directory, entry.name), key));
    else if (entry.isFile()) {
      const bytes = await readFile(join(directory, entry.name)); result.push({ key, hash: hash(bytes), size: bytes.length });
    } else throw new Error('Media backup does not follow symbolic links.');
  }
  return result;
}

async function verify(runtime, workdir = root) {
  const health = await api(runtime, '/rest/v1/rpc/studio_runtime_health', { method: 'POST', body: {} });
  if (!health.database || !health.pgmq || !health.pg_cron) throw new Error('Database/Queues/Cron extensions are not healthy.');
  await api(runtime, '/auth/v1/health');
  let buckets = await api(runtime, '/storage/v1/bucket');
  if (!buckets.some(item => item.id === bucket)) {
    await api(runtime, '/storage/v1/bucket', { method: 'POST', body: { id: bucket, name: bucket, public: false, file_size_limit: 536870912 } });
    buckets = await api(runtime, '/storage/v1/bucket');
  }
  if (buckets.find(item => item.id === bucket)?.public !== false) throw new Error('The asset bucket is not private.');
  const key = `.health/${randomUUID()}.txt`; const bytes = Buffer.from('Content Studio local Storage health');
  await api(runtime, `/storage/v1/object/${bucket}/${key}`, { method: 'POST', body: bytes, extraHeaders: { 'Content-Type': 'text/plain' } });
  if (!bytes.equals(await api(runtime, `/storage/v1/object/${bucket}/${key}`, { raw: true }))) throw new Error('Storage did not return the uploaded bytes.');
  const anonymous = await fetch(`${runtime.SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`);
  if (anonymous.ok) throw new Error('Private storage is anonymously readable.');
  await api(runtime, `/storage/v1/object/${bucket}`, { method: 'DELETE', body: { prefixes: [key] } });
  const probe = `studio_probe_${randomUUID().replaceAll('-', '')}`;
  const queueResult = await sql(`begin; select pgmq.create('${probe}'); select pgmq.send('${probe}', '{"probe":true}'::jsonb); select message->>'probe' from pgmq.read('${probe}', 30, 1); rollback;`, workdir);
  if (!queueResult.includes('true')) throw new Error('Queue send/read did not return the message.');
  const cronId = (await sql(`select cron.schedule('${probe}', '* * * * *', 'select 1');`, workdir)).trim();
  const deadline = Date.now() + 80000; let executed = false;
  try {
    while (Date.now() < deadline) {
      const result = await sql(`select count(*) from cron.job_run_details where jobid = ${Number(cronId)} and status='succeeded';`, workdir);
      if (Number(result.trim()) > 0) { executed = true; break; } await sleep(1000);
    }
  } finally { await sql(`select cron.unschedule(${Number(cronId)}); delete from cron.job_run_details where jobid=${Number(cronId)};`, workdir); }
  if (!executed) throw new Error('Cron did not complete a real scheduled execution.');
  const { projectId } = await config(workdir);
  const containers = JSON.parse(await run('docker', ['ps', '--filter', `label=com.supabase.cli.project=${projectId}`, '--format', '{{json .}}']).then(text => `[${text.trim().split('\n').filter(Boolean).join(',')}]`));
  if (!containers.length) throw new Error('No Supabase containers found for this project.');
  for (const container of containers) {
    const inspected = JSON.parse(await run('docker', ['inspect', container.ID]));
    for (const bindings of Object.values(inspected[0]?.NetworkSettings?.Ports ?? {})) {
      if (bindings?.some(binding => binding.HostIp !== '127.0.0.1')) throw new Error('A local service port is exposed beyond loopback.');
    }
  }
  return { database: true, auth: true, storage: true, privateBucket: true, queueSendRead: true, cronExecuted: true, loopbackOnly: true, projectId };
}

async function setup() {
  const status = await stack(root, true); const runtime = await saveRuntime(status);
  const existing = await api(runtime, `/rest/v1/content_studio_workspaces?id=eq.${runtime.STUDIO_WORKSPACE_ID}&select=id`);
  if (!existing.length) {
    const legacy = await exists(join(data, 'state.json')) ? JSON.parse(await readFile(join(data, 'state.json'), 'utf8')) : { version: 1, drafts: [], accounts: [], jobs: [] };
    if (legacy.version !== 1 || !Array.isArray(legacy.drafts) || !Array.isArray(legacy.jobs)) throw new Error('Legacy workspace is invalid; original files were preserved.');
    await api(runtime, '/rest/v1/content_studio_workspaces', { method: 'POST', body: { id: runtime.STUDIO_WORKSPACE_ID, state: { ...legacy, paused: true }, revision: 0 } });
  }
  await pause(runtime); const checks = await verify(runtime);
  const versions = { node: process.version, nodeArchitecture: process.arch, supabaseCli: (await run('supabase', ['--version'])).trim(), docker: (await run('docker', ['version', '--format', '{{.Server.Version}}'])).trim() };
  await writeFile(join(data, 'local-runtime.json'), JSON.stringify({ checkedAt: new Date().toISOString(), versions, checks }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ setup: 'verified', publishingPaused: true, ...checks, versions }, null, 2));
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
async function processService(kind, action) {
  const label = `${labelPrefix}.${kind}`; const file = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
  if (action === 'stop') {
    await run('launchctl', ['disable', `${domain}/${label}`]).catch(() => undefined);
    await run('launchctl', ['bootout', `${domain}/${label}`]).catch(() => undefined);
    for (let attempt = 0; attempt < 20; attempt++) {
      const loaded = await run('launchctl', ['print', `${domain}/${label}`]).then(() => true).catch(() => false);
      if (!loaded) return;
      await sleep(250);
    }
    throw new Error(`Managed ${kind} service did not unload within five seconds.`);
  }
  const entry = kind === 'api' ? 'src/server/index.ts' : 'src/server/worker.ts';
  if (!await exists(join(root, entry))) throw new Error(`${entry} is not installed.`);
  const logs = join(data, 'logs'); await mkdir(logs, { recursive: true, mode: 0o700 });
  await mkdir(dirname(file), { recursive: true });
  const document = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(root, 'scripts/service.mjs'))}</string><string>${kind}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(join(logs, `${kind}.log`))}</string><key>StandardErrorPath</key><string>${xml(join(logs, `${kind}.error.log`))}</string></dict></plist>\n`;
  await writeFile(file, document, { mode: 0o600 });
  await run('launchctl', ['enable', `${domain}/${label}`]);
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await run('launchctl', ['bootstrap', domain, file]); return; }
    catch (error) {
      const loaded = await run('launchctl', ['print', `${domain}/${label}`]).then(() => true).catch(() => false);
      if (loaded) return;
      if (attempt === 19 || !error.message.includes('launchctl failed (5)')) throw error;
      await sleep(500);
    }
  }
}

async function stopProcesses() { await processService('api', 'stop'); await processService('worker', 'stop'); }

async function waitApplicationReady(runtime, startedAt) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const worker = JSON.parse(await readFile(join(data, 'worker-ready.json'), 'utf8'));
      const readyAt = Date.parse(worker.readyAt);
      if (!Number.isSafeInteger(worker.pid) || worker.pid < 1 || worker.workspaceId !== runtime.STUDIO_WORKSPACE_ID || !Number.isFinite(readyAt) || readyAt < startedAt) throw new Error('Worker is not initialized.');
      process.kill(worker.pid, 0);
      const managed = await Promise.all(['api', 'worker'].map(kind => run('launchctl', ['print', `${domain}/${labelPrefix}.${kind}`]).then(output => /state = running/.test(output))));
      if (!managed.every(Boolean)) throw new Error('Managed services are not running.');
      const responses = await Promise.all(['/api/status', '/'].map(path => fetch(`http://127.0.0.1:4310${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error' })));
      if (!responses.every(response => response.ok) || !responses[1].headers.get('content-type')?.includes('text/html')) throw new Error('Web service is not ready.');
      const status = await responses[0].json();
      if (status.state?.version !== 1 || !Array.isArray(status.state.drafts)) throw new Error('Application database is not ready.');
      return;
    } catch { await sleep(500); }
  }
  throw new Error('Managed API/Worker did not become ready within 60 seconds; inspect the private service logs.');
}

async function start() {
  if (!await availablePort(4310)) {
    const ours = await run('launchctl', ['print', `${domain}/${labelPrefix}.api`]).then(text => /state = running/.test(text)).catch(() => false);
    if (!ours) throw new Error('Port 4310 is occupied by another server; stop that instance explicitly before starting launchd.');
  }
  await stack(); const runtime = await runtimeFile();
  await sql("select cron.alter_job(jobid, active := true) from cron.job where jobname like 'content-studio-%';");
  await stopProcesses(); await rm(join(data, 'worker-ready.json'), { force: true });
  const startedAt = Date.now();
  await processService('worker', 'start'); await processService('api', 'start');
  await waitApplicationReady(runtime, startedAt);
  console.log('Content Studio API and Worker are managed by launchd at http://127.0.0.1:4310.');
}

async function inventory(runtime, prefix = '') {
  const result = [];
  for (let offset = 0; ; offset += 100) {
    const rows = await api(runtime, `/storage/v1/object/list/${bucket}`, { method: 'POST', body: { prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } } });
    for (const row of rows) {
      const key = prefix ? `${prefix}/${row.name}` : row.name;
      if (!row.id) result.push(...await inventory(runtime, key)); else result.push({ key, mime: row.metadata?.mimetype ?? 'application/octet-stream' });
    }
    if (rows.length < 100) return result;
  }
}

async function backup(destination) {
  const folder = resolve(destination ?? join(data, 'backups', new Date().toISOString().replaceAll(':', '-')));
  if (await exists(folder)) throw new Error('Backup destination already exists.');
  if (!await availablePort(4310)) {
    const managed = await run('launchctl', ['print', `${domain}/${labelPrefix}.api`]).then(text => /state = running/.test(text)).catch(() => false);
    if (!managed) throw new Error('Backup requires stopping the unmanaged API on port 4310 explicitly before taking a consistent snapshot.');
  }
  const runtime = await runtimeFile(); await stopProcesses(); await pause(runtime);
  await sql("select cron.alter_job(jobid, active := false) from cron.job where jobname like 'content-studio-%';");
  await mkdir(join(folder, 'objects'), { recursive: true, mode: 0o700 }); await chmod(folder, 0o700);
  const { container } = await config();
  await run('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--format=custom', '--no-owner', '--no-acl'], { outputFile: join(folder, 'database.dump') });
  await run('docker', ['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--data-only', '--schema=public', '--exclude-table-data=public.studio_queue_leases', '--column-inserts', '--no-owner', '--no-acl'], { outputFile: join(folder, 'application-data.sql') });
  const objects = [];
  for (const item of await inventory(runtime)) {
    const bytes = await api(runtime, `/storage/v1/object/${bucket}/${item.key.split('/').map(encodeURIComponent).join('/')}`, { raw: true });
    const digest = hash(bytes); await writeFile(join(folder, 'objects', digest), bytes, { mode: 0o600 });
    objects.push({ ...item, hash: digest, size: bytes.length });
  }
  if (await exists(join(data, 'media'))) await cp(join(data, 'media'), join(folder, 'legacy-media'), { recursive: true });
  const legacyMedia = await fileInventory(join(folder, 'legacy-media'));
  const artifacts = [];
  for (const directory of ['content', 'runs']) {
    if (!await exists(join(data, directory))) continue;
    await cp(join(data, directory), join(folder, 'artifacts', directory), { recursive: true });
    for (const file of await fileInventory(join(folder, 'artifacts', directory))) artifacts.push({ directory, ...file });
  }
  const privateDirs = [];
  for (const name of ['youtube', 'ops']) if (await exists(join(data, name))) privateDirs.push(name);
  const youtubeJournalIds = await exists(join(data, 'youtube/uploads'))
    ? (await readdir(join(data, 'youtube/uploads'))).filter(name => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i.test(name)).map(name => name.slice(0, -5)).sort()
    : [];
  if (privateDirs.length) {
    const tar = join(data, `backup-private-${randomUUID()}.tmp`);
    try {
      await run('/usr/bin/tar', ['-cf', tar, '-C', data, ...privateDirs]); await chmod(tar, 0o600);
      const keyFile = join(data, 'backup.key');
      if (!await exists(keyFile)) await writeFile(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await readFile(keyFile), iv);
      const bytes = Buffer.concat([cipher.update(await readFile(tar)), cipher.final()]);
      await writeFile(join(folder, 'private-state.enc'), Buffer.concat([iv, cipher.getAuthTag(), bytes]), { mode: 0o600 });
    } finally { await rm(tar, { force: true }); }
  }
  const migrations = [];
  const applied = new Set((await sql('select version from supabase_migrations.schema_migrations order by version;')).trim().split('\n').filter(Boolean));
  for (const name of (await readdir(join(root, 'supabase/migrations'))).sort()) {
    if (!name.endsWith('.sql') || !applied.has(name.split('_')[0])) continue;
    migrations.push({ name, hash: hash(await readFile(join(root, 'supabase/migrations', name))) });
  }
  if (migrations.length !== applied.size) throw new Error('An applied migration source is missing; backup cannot establish a restorable schema.');
  const manifest = { format: 1, createdAt: new Date().toISOString(), originalDataRoot: data, workspaceId: runtime.STUDIO_WORKSPACE_ID, objects, legacyMedia, artifacts, applicationCounts: await applicationCounts(), migrations, publishingPaused: true, databaseHash: hash(await readFile(join(folder, 'database.dump'))), dataHash: hash(await readFile(join(folder, 'application-data.sql'))), privateStateEncrypted: privateDirs.length > 0, youtubeJournalIds };
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ backup: folder, objects: objects.length, publishingPaused: true, servicesStopped: true, privateKeyOutsideBackup: privateDirs.length > 0 }, null, 2));
}

async function availablePort(port) {
  return new Promise(accept => { const server = createServer(); server.once('error', () => accept(false)); server.listen(port, '127.0.0.1', () => server.close(() => accept(true))); });
}

async function restore(source, target, restorePrivate) {
  if (!source || !target) throw new Error('Usage: restore <backup-folder> --target <new-isolated-folder> [--restore-private]');
  const folder = resolve(source); const destination = resolve(target);
  if (destination === root || destination === data || await exists(destination)) throw new Error('Restore requires a new, isolated directory; existing data is never reset.');
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || hash(await readFile(join(folder, 'database.dump'))) !== manifest.databaseHash || hash(await readFile(join(folder, 'application-data.sql'))) !== manifest.dataHash) throw new Error('Backup database integrity failed.');
  if (manifest.privateStateEncrypted && !Array.isArray(manifest.youtubeJournalIds) && !restorePrivate) throw new Error('This older backup has no redacted upload-journal inventory; explicit private restoration and reconciliation are required.');
  const youtubeJournalIds = manifest.youtubeJournalIds ?? [];
  if (!Array.isArray(youtubeJournalIds) || youtubeJournalIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) throw new Error('Invalid redacted upload-journal inventory.');
  for (const migration of manifest.migrations) {
    if (!/^\d{12,14}_[a-zA-Z0-9_-]+\.sql$/.test(migration.name) || hash(await readFile(join(root, 'supabase/migrations', migration.name))) !== migration.hash) throw new Error('Restore requires the recorded migration version.');
  }
  for (const object of manifest.objects) if (hash(await readFile(join(folder, 'objects', object.hash))) !== object.hash) throw new Error('Backup media integrity failed.');
  for (const file of manifest.legacyMedia ?? []) {
    const path = resolve(folder, 'legacy-media', file.key);
    if (!path.startsWith(`${join(folder, 'legacy-media')}${sep}`) || hash(await readFile(path)) !== file.hash) throw new Error('Legacy media integrity failed.');
  }
  for (const file of manifest.artifacts ?? []) {
    if (!['content', 'runs'].includes(file.directory)) throw new Error('Unexpected artifact directory in backup.');
    const prefix = join(folder, 'artifacts', file.directory); const path = resolve(prefix, file.key);
    if (!path.startsWith(`${prefix}${sep}`) || hash(await readFile(path)) !== file.hash) throw new Error('Backup artifact integrity failed.');
  }
  let offset = 1000;
  while (!(await Promise.all([55420, 55421, 55422, 55423, 55424, 55427, 55428, 55429].map(port => availablePort(port + offset)))).every(Boolean)) offset += 100;
  if (55429 + offset > 65535) throw new Error('No isolated restore port range available.');
  const base = await config(); const projectId = `content-studio-restore-${randomUUID().slice(0, 8)}`;
  const text = base.text.replace(/^project_id\s*=.*$/m, `project_id = "${projectId}"`).replace(/\b554(2[0-9])\b/g, value => String(Number(value) + offset));
  await mkdir(join(destination, 'supabase/migrations'), { recursive: true, mode: 0o700 });
  await writeFile(join(destination, 'supabase/config.toml'), text);
  for (const migration of manifest.migrations) await cp(join(root, 'supabase/migrations', migration.name), join(destination, 'supabase/migrations', migration.name));
  const status = await stack(destination, true); const directory = join(destination, '.studio');
  const runtime = await saveRuntime(status, directory, manifest.workspaceId);
  await sql("select cron.alter_job(jobid, active := false) from cron.job where jobname like 'content-studio-%';", destination);
  // The new stack supplies schema, Auth and Storage. Replay only application rows, never active pgmq deliveries.
  await sql(await readFile(join(folder, 'application-data.sql'), 'utf8'), destination);
  await pause(runtime);
  await sql("update public.studio_task_runs set status='failed',phase='restore_interrupted',error='Restored from backup; retry explicitly after inspecting recovery evidence.',lease_token=null,lease_expires_at=null,updated_at=now() where status in ('queued','researching','generating'); update public.studio_operations set status='failed',phase='Restore requires review',error='Restored from backup; inspect external side effects before retrying.',owner_token=null,lease_until=null,updated_at=now() where status in ('queued','running');", destination);
  await verify(runtime, destination);
  for (const object of manifest.objects) {
    const bytes = await readFile(join(folder, 'objects', object.hash));
    await api(runtime, `/storage/v1/object/${bucket}/${object.key.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', body: bytes, extraHeaders: { 'Content-Type': object.mime, 'x-upsert': 'true' } });
    if (hash(await api(runtime, `/storage/v1/object/${bucket}/${object.key.split('/').map(encodeURIComponent).join('/')}`, { raw: true })) !== object.hash) throw new Error('Restored object verification failed.');
  }
  if (await exists(join(folder, 'legacy-media'))) await cp(join(folder, 'legacy-media'), join(directory, 'media'), { recursive: true });
  for (const name of ['content', 'runs']) {
    if (await exists(join(folder, 'artifacts', name))) await cp(join(folder, 'artifacts', name), join(directory, name), { recursive: true });
  }
  await writeFile(join(directory, 'relocation.json'), JSON.stringify({ originalDataRoot: manifest.originalDataRoot }, null, 2), { mode: 0o600 });
  const counts = await applicationCounts(destination);
  for (const [name, count] of Object.entries(manifest.applicationCounts ?? {})) if (counts[name] !== count) throw new Error('Restored application row counts differ.');
  const queueDeliveries = Number((await sql('select count(*) from pgmq.q_studio_jobs;', destination)).trim());
  const activeLeases = Number((await sql('select count(*) from public.studio_queue_leases;', destination)).trim());
  const ownedCronActive = Number((await sql("select count(*) from cron.job where jobname like 'content-studio-%' and active;", destination)).trim());
  if (queueDeliveries !== 0 || activeLeases !== 0 || ownedCronActive !== 0) throw new Error('The restored instance is not isolated from active scheduling or delivery.');
  const media = await fileInventory(join(directory, 'media'));
  if (JSON.stringify(media) !== JSON.stringify(manifest.legacyMedia ?? [])) throw new Error('Restored legacy media hashes differ.');
  const artifacts = [];
  for (const name of ['content', 'runs']) for (const file of await fileInventory(join(directory, name))) artifacts.push({ directory: name, ...file });
  if (JSON.stringify(artifacts) !== JSON.stringify(manifest.artifacts ?? [])) throw new Error('Restored content/run artifact hashes differ.');
  if (youtubeJournalIds.length) {
    const journals = join(directory, 'youtube/uploads'); await mkdir(journals, { recursive: true, mode: 0o700 });
    for (const jobId of youtubeJournalIds) await writeFile(join(journals, `${jobId}.json`), JSON.stringify({ jobId, restoredJournalMarker: true }, null, 2), { mode: 0o600, flag: 'wx' });
  }
  if (restorePrivate && manifest.privateStateEncrypted) {
    const bytes = await readFile(join(folder, 'private-state.enc')); const decipher = createDecipheriv('aes-256-gcm', await readFile(join(data, 'backup.key')), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28)); const tar = join(directory, '.private-state.tmp');
    await writeFile(tar, Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]), { mode: 0o600 });
    await run('/usr/bin/tar', ['-xf', tar, '-C', directory]); await rm(tar);
  }
  await writeFile(join(directory, 'restore-report.json'), JSON.stringify({ restoredAt: new Date().toISOString(), projectId, objectsVerified: manifest.objects.length, legacyMediaVerified: media.length, artifactsVerified: artifacts.length, applicationCounts: counts, publishingPaused: true, cronPaused: true, servicesStarted: false, activeQueueCopied: false, queueDeliveries, activeLeases, ownedCronActive, uploadJournalsProtected: youtubeJournalIds.length, privateStateRestored: Boolean(restorePrivate && manifest.privateStateEncrypted) }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ restoredTo: destination, projectId, objectsVerified: manifest.objects.length, publishingPaused: true, cronPaused: true, applicationServicesStarted: false, uploadJournalsProtected: youtubeJournalIds.length, privateStateRestored: Boolean(restorePrivate && manifest.privateStateEncrypted) }, null, 2));
}

async function status() {
  const runtime = await runtimeFile(); const health = await api(runtime, '/rest/v1/rpc/studio_runtime_health', { method: 'POST', body: {} });
  const services = {};
  for (const kind of ['api', 'worker']) services[kind] = await run('launchctl', ['print', `${domain}/${labelPrefix}.${kind}`]).then(text => /state = running/.test(text)).catch(() => false);
  console.log(JSON.stringify({ local: true, apiUrl: runtime.SUPABASE_URL, health, services, publishingPaused: (await api(runtime, `/rest/v1/content_studio_workspaces?id=eq.${runtime.STUDIO_WORKSPACE_ID}&select=state`))[0]?.state?.paused }, null, 2));
}

const [action, first, ...args] = process.argv.slice(2);
try {
  if (action === 'setup') await setup();
  else if (action === 'ensure') await stack();
  else if (action === 'start') await start();
  else if (action === 'stop') { await stopProcesses(); await run('supabase', ['stop']); console.log('Only this project stopped; local data volumes retained.'); }
  else if (action === 'status') await status();
  else if (action === 'backup') await backup(first);
  else if (action === 'restore') await restore(first, args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined, args.includes('--restore-private'));
  else if (action === 'upgrade') {
    await backup(); await stack(root, true);
    console.log('A verified-version backup was saved and pending local migrations applied without resetting data. Run start after verification.');
  }
  else throw new Error('Usage: node scripts/local.mjs setup|start|stop|status|backup [folder]|restore <folder> --target <new-folder>|upgrade');
} catch (error) { console.error(error instanceof Error ? error.message : 'Local operation failed.'); process.exitCode = 1; }
