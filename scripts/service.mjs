import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kind = process.argv[2];
if (!['api', 'worker'].includes(kind)) throw new Error('Unknown local service.');
const entry = join(root, kind === 'api' ? 'src/server/index.ts' : 'src/server/worker.ts');
let child;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; child?.kill(signal); if (!child) process.exit(0); });

async function localEnvironment() {
  const content = await readFile(join(root, '.studio/runtime.env'), 'utf8');
  const values = {};
  const names = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STUDIO_WORKSPACE_ID', 'STUDIO_DATA_DIR', 'STUDIO_LOCAL_RUNTIME'];
  for (const line of content.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split < 0 || !names.includes(line.slice(0, split))) continue;
    let value;
    try { value = JSON.parse(line.slice(split + 1)); }
    catch { throw new Error('Invalid private runtime configuration.'); }
    if (typeof value !== 'string') throw new Error('Invalid private runtime configuration.');
    values[line.slice(0, split)] = value;
  }
  let local = false;
  try { local = new URL(values.SUPABASE_URL).hostname === '127.0.0.1'; } catch { /* Report a generic private configuration failure. */ }
  if (names.some(name => !values[name]) || !local || values.STUDIO_DATA_DIR !== join(root, '.studio')) {
    throw new Error('Managed local services require this project\'s loopback configuration.');
  }
  return values;
}

async function ready() {
  return new Promise(accept => {
    const check = spawn('supabase', ['status', '--output', 'json'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; check.stdout.on('data', chunk => { output += chunk; });
    check.on('error', () => accept(false)); check.on('close', async code => {
      try {
        const status = JSON.parse(output);
        if (code !== 0 || !status.API_URL || !status.SERVICE_ROLE_KEY) { accept(false); return; }
        const headers = { apikey: status.SERVICE_ROLE_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` };
        const results = await Promise.all([
          fetch(`${status.API_URL}/auth/v1/health`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${status.API_URL}/storage/v1/bucket`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${status.API_URL}/rest/v1/rpc/studio_runtime_health`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) }),
        ]);
        accept(results.every(response => response.ok));
      } catch { accept(false); }
    });
  });
}

if (kind === 'api') {
  await new Promise(accept => {
    child = spawn(process.execPath, [join(root, 'scripts/local.mjs'), 'ensure'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
    child.on('error', () => accept()); child.on('close', () => accept());
  });
}
while (!stopping && !await ready()) await sleep(3000);
if (!stopping) {
  const runtime = await localEnvironment();
  child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: root, stdio: 'inherit', env: { ...process.env, ...runtime, NODE_ENV: 'production' } });
  child.on('error', () => { console.error('Local application service could not start.'); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}
