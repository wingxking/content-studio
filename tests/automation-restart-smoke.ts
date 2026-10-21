// Isolated Supabase + actual HTTP process restart. No worker, model or platform write.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dbRequest } from '../src/core/database.ts';
import { mutateState } from '../src/core/store.ts';
import { createTask, updateTask } from '../src/core/tasks.ts';
import { taskInputSchema, taskSchema } from '../src/core/task-model.ts';
import { defaultBrandProfile } from '../src/contracts/brand.ts';

if (!process.argv.includes('--confirm-isolated-database')) throw new Error('Use --confirm-isolated-database.');
if (new URL(process.env.SUPABASE_URL ?? '').hostname !== 'kong') throw new Error('This test requires the isolated local Docker Supabase network.');
const environment = { ...process.env }; const workspace = randomUUID();
const directory = await mkdtemp(join(tmpdir(), 'studio-restart-'));
process.env.STUDIO_WORKSPACE_ID = workspace; process.env.STUDIO_DATA_DIR = directory;
process.env.STUDIO_LOCALFS_DIR = join(directory, 'media'); process.env.CODEX_HOME = join(directory, 'models');
process.env.PORT = '14311'; process.env.STUDIO_PUBLIC_ORIGIN = 'http://127.0.0.1:14311';
await mkdir(process.env.CODEX_HOME); await writeFile(join(process.env.CODEX_HOME, 'studio-models.json'), JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Fixture', description: 'No model execution' }] }));
let api: ChildProcess | undefined;
async function stop(): Promise<void> {
  if (!api || api.exitCode !== null) return;
  const exited = new Promise<void>(resolve => api!.once('exit', () => resolve()));
  api.kill('SIGTERM');
  const timer = setTimeout(() => api?.kill('SIGKILL'), 10000);
  await exited; clearTimeout(timer);
}
async function start(): Promise<void> {
  api = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env: process.env, stdio: 'ignore' });
  for (let index = 0; index < 100; index++) {
    if (api.exitCode !== null) throw new Error('Fixture API exited during startup.');
    if (await fetch('http://127.0.0.1:14311/healthz').then(response => response.ok).catch(() => false)) return;
    await delay(100);
  }
  throw new Error('Fixture API readiness timed out.');
}
async function read(id: string) {
  const response = await fetch(`http://127.0.0.1:14311/api/tasks/${id}`); assert.equal(response.status, 200);
  return taskSchema.parse(await response.json());
}
try {
  const accountId = randomUUID();
  await mutateState(state => { state.paused = true; state.accounts.push({ id: accountId, platform: 'zhihu', provider: 'native', integrationId: 'restart-fixture', label: 'Restart fixture', status: 'connected', note: 'No real authorization', verifiedAt: new Date().toISOString() }); });
  const config = taskInputSchema.parse({ title: 'Restart fixture', prompt: 'Explain software versioning from supplied evidence.', model: 'fixture-model', platforms: ['zhihu'], kind: 'content', topicOrigin: 'editorial', enabled: true, brand: defaultBrandProfile, frequency: { type: 'once', time: '09:00', timezone: 'UTC' }, delivery: { mode: 'automatic', authorized: true, accountIds: [accountId], publicationTime: '18:00', onceAt: new Date(Date.now() + 3600000).toISOString() } });
  const task = await createTask(config); assert.ok(task.authorization);
  await start(); const before = await read(task.id); const pid = api!.pid; await stop();
  await start(); assert.notEqual(api!.pid, pid); assert.deepEqual(await read(task.id), before);
  await updateTask(task.id, { ...config, enabled: false }); await stop(); await start();
  assert.equal((await read(task.id)).authorization, undefined);
  assert.equal((await dbRequest(`content_studio_workspaces?id=eq.${workspace}`) as { state: { jobs: unknown[] } }[])[0]?.state.jobs.length, 0);
  console.log(JSON.stringify({ workspace, actualApiRestarts: 2, grantAndBrandPreserved: true, revokedGrantStaysRevoked: true, platformRequests: 0 }));
} finally {
  await stop();
  for (const table of ['studio_tasks', 'content_studio_workspaces']) await dbRequest(`${table}?${table === 'studio_tasks' ? 'workspace_id' : 'id'}=eq.${workspace}`, { method: 'DELETE' });
  process.env = environment; await rm(directory, { recursive: true, force: true });
}
