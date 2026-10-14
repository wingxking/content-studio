import { accountExecutionFence } from './account-execution.ts';
import { dbRpc } from './database.ts';
import { isTrustedDatabaseOrigin } from './database.ts';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { emptyState, stateSchema, type StudioState } from './model.ts';

export const dataDirectory = (): string => resolve(process.env.STUDIO_DATA_DIR ?? '.studio');
export function storageMode(): 'local' | 'supabase' {
  const values = [process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, process.env.STUDIO_WORKSPACE_ID];
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error('Supabase requires SUPABASE_URL, SUPABASE_SECRET_KEY, and STUDIO_WORKSPACE_ID together.');
  return values.every(Boolean) ? 'supabase' : 'local';
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function reapDeadLock(lockPath: string): Promise<void> {
  const reaperPath = `${lockPath}.reaper`;
  let reaper;
  try { reaper = await open(reaperPath, 'wx', 0o600); }
  catch (error) { if (hasCode(error, 'EEXIST')) return; throw error; }
  try {
    const lock = z.object({ pid: z.number().int().positive(), host: z.string() }).parse(JSON.parse(await readFile(lockPath, 'utf8')));
    if (lock.host !== hostname()) return;
    try { process.kill(lock.pid, 0); }
    catch (error) { if (hasCode(error, 'ESRCH')) await unlink(lockPath); }
  } finally { await reaper.close(); await unlink(reaperPath); }
}

async function lockLocal<T>(fn: () => Promise<T>): Promise<T> {
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'state.lock');
  const token = randomUUID();
  const deadline = Date.now() + 15000;
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token })); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      try {
        await reapDeadLock(lockPath);
      } catch (lockError) {
        if (!hasCode(lockError, 'ENOENT')) {
          const info = await stat(lockPath).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 30000) throw new Error('Invalid state lock; inspect state.lock before removing it.');
        }
      }
      if (Date.now() > deadline) throw new Error('State is locked by another worker; retry after it completes.');
      await sleep(25);
    }
  }
  try { return await fn(); }
  finally {
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown };
    if (lock.token === token) await unlink(lockPath);
  }
}

async function readLocal(): Promise<StudioState> {
  let content: string;
  try { content = await readFile(join(dataDirectory(), 'state.json'), 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT')) return emptyState(); throw error; }
  try { return stateSchema.parse(JSON.parse(content)); }
  catch { throw new Error('State file is invalid. It has been preserved; restore a verified backup before continuing.'); }
}

async function writeLocal(state: StudioState): Promise<void> {
  const file = join(dataDirectory(), `state.${randomUUID()}.tmp`);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(file, join(dataDirectory(), 'state.json')); }
  catch (error) { await unlink(file).catch(() => undefined); throw error; }
}

const rowSchema = z.object({ id: z.uuid(), revision: z.number().int().nonnegative(), state: stateSchema });
type Row = z.infer<typeof rowSchema>;
function databaseConfig(): { url: string; key: string; id: string } {
  storageMode();
  const url = new URL(process.env.SUPABASE_URL ?? '');
  if (!isTrustedDatabaseOrigin(url)) throw new Error('Supabase must use HTTPS.');
  return { url: `${url.origin}/rest/v1/content_studio_workspaces`, key: process.env.SUPABASE_SECRET_KEY ?? '', id: z.uuid().parse(process.env.STUDIO_WORKSPACE_ID) };
}
async function databaseRequest(method: string, query: string, body?: unknown): Promise<Response> {
  const config = databaseConfig();
  const headers: Record<string, string> = { apikey: config.key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (config.key.startsWith('eyJ')) headers.Authorization = `Bearer ${config.key}`;
  try { return await fetch(`${config.url}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' }); }
  catch { throw new Error('Supabase request failed; verify network and workspace configuration.'); }
}
async function readDatabase(): Promise<Row> {
  const { id } = databaseConfig();
  const response = await databaseRequest('GET', `?id=eq.${id}&select=id,state,revision`);
  if (!response.ok) throw new Error(`Supabase read failed (HTTP ${response.status}); apply the workspace migration and verify service credentials.`);
  const rows = z.array(rowSchema).parse(await response.json());
  if (rows[0]) return rows[0];
  const initial = { id, state: emptyState(), revision: 0 };
  const created = await databaseRequest('POST', '', initial);
  if (created.status === 409) return readDatabase();
  if (!created.ok) throw new Error(`Supabase initialization failed (HTTP ${created.status}).`);
  return rowSchema.parse(z.array(rowSchema).parse(await created.json())[0]);
}

export async function readState(): Promise<StudioState> {
  if (storageMode() === 'supabase') return (await readDatabase()).state;
  return lockLocal(readLocal);
}

// Database conflict retries may invoke the callback again; keep external side effects outside it.
export async function mutateState<T>(fn: (state: StudioState) => T | Promise<T>): Promise<T> {
  if (storageMode() === 'local') return lockLocal(async () => {
    const state = await readLocal();
    const result = await fn(state);
    await writeLocal(stateSchema.parse(state));
    return structuredClone(result);
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await readDatabase();
    const result = await fn(row.state);
    const state = stateSchema.parse(row.state);
    const fence = accountExecutionFence();
    const response = fence ? new Response(JSON.stringify(await dbRpc('studio_commit_account_workspace', { p_workspace: row.id, p_key: fence.key, p_token: fence.token, p_revision: row.revision, p_state: state })), { status: 200 }) : await databaseRequest('PATCH', `?id=eq.${row.id}&revision=eq.${row.revision}`, { state, revision: row.revision + 1 });
    if (!response.ok) throw new Error(`Supabase write failed (HTTP ${response.status}).`);
    const rows = z.array(rowSchema).parse(await response.json());
    if (rows.length === 1) return structuredClone(result);
  }
  throw new Error('Supabase workspace changed repeatedly; retry this operation.');
}
