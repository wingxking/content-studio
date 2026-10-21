export function isTrustedDatabaseOrigin(url: URL): boolean {
  const allowed = (process.env.STUDIO_INTERNAL_ORIGINS ?? '').split(',').filter(Boolean);
  return !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && (['localhost', '127.0.0.1'].includes(url.hostname) || allowed.includes(url.origin)));
}
import { loadRuntimeEnvironment } from './runtime-env.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestDeadline = new AsyncLocalStorage<AbortSignal>();
export function databaseRequestSignal(): AbortSignal | undefined { return requestDeadline.getStore(); }
export function withDatabaseRequestSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> { return requestDeadline.run(signal, run); }

type DatabaseOptions = { method?: string; body?: unknown; prefer?: string };

export async function dbRequest(path: string, options: DatabaseOptions = {}): Promise<unknown> {
  await loadRuntimeEnvironment();
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) throw new Error('Local Supabase is not configured; run local setup first.');
  const url = new URL(base);
  if (!isTrustedDatabaseOrigin(url)) {
    throw new Error('Supabase must use HTTPS or a loopback HTTP endpoint.');
  }
  if (!path || path.startsWith('/') || path.includes('://') || /[\r\n#]/.test(path) || path.split('?')[0]?.split('/').includes('..')) {
    throw new Error('Invalid database request path.');
  }
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  if (options.prefer) headers.Prefer = options.prefer;
  let response: Response;
  try {
    response = await fetch(`${url.origin}/rest/v1/${path}`, {
      method: options.method ?? 'GET', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.any([AbortSignal.timeout(30000), ...databaseRequestSignal() ? [databaseRequestSignal()!] : []]), redirect: 'error',
    });
  } catch { throw new Error('Supabase request failed; check local service health.'); }
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    if (failure && typeof failure === 'object' && 'message' in failure && failure.message === 'Research model budget exhausted') throw new Error('Quality withheld: model call budget exhausted; completed checkpoints are preserved.');
    const conflict = response.status === 409 || failure && typeof failure === 'object' && 'code' in failure && failure.code === 'P0001' && 'message' in failure && typeof failure.message === 'string' && /changed|ownership|lease|active.*submission|reconcile.*before/iu.test(failure.message);
    if (conflict) throw new Error('Content revision or execution ownership changed. Refresh and review before retrying.');
    throw new Error(`Supabase request failed (HTTP ${response.status}).`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : null;
}

export async function dbRpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid database function name.');
  return dbRequest(`rpc/${name}`, { method: 'POST', body: args });
}
