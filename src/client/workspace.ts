import type { z } from 'zod';

export class WorkspaceRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'WorkspaceRequestError'; }
}

export function workspaceQuery(input: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value) params.set(key, value);
  return params.size ? `?${params.toString()}` : '';
}

export function workspaceDateBoundary(value: string | null, end = false): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00+08:00`))) return undefined;
  return new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00`).toISOString();
}

/** Read contracts are checked at the HTTP boundary; cancellation never cancels durable work. */
export async function readWorkspace<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/workspace/${path}`, { signal });
  const value: unknown = await response.json();
  if (!response.ok) throw new WorkspaceRequestError(typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : '工作区读取失败', response.status);
  return schema.parse(value);
}

export async function writeWorkspace<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`/api/workspace/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value: unknown = await response.json();
  if (!response.ok) throw new WorkspaceRequestError(typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : '操作失败', response.status);
  return schema.parse(value);
}
