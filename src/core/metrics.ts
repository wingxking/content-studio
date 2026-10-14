import { z } from 'zod';
import { dbRequest, dbRpc } from './database.ts';
import { readState } from './store.ts';
import { accountExecutionKey, withJobExecution } from './account-execution.ts';

export const metricValuesSchema = z.object({ views: z.number().int().nonnegative().nullable(), likes: z.number().int().nonnegative().nullable(), comments: z.number().int().nonnegative().nullable(), shares: z.number().int().nonnegative().nullable(), favorites: z.number().int().nonnegative().nullable(), clicks: z.number().int().nonnegative().nullable() }).strict().refine(value => Object.values(value).some(item => item !== null), 'No metrics were supplied; this is not an all-zero observation.');
export const metricObservationInputSchema = z.object({ ...metricValuesSchema.shape, definition: z.string().min(1).max(300), adapterVersion: z.string().min(1).max(80), source: z.enum(['official_api', 'browser_readback', 'fixture']) }).strict();
export type MetricValues = z.infer<typeof metricValuesSchema>;
const workspace = (): string => z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
export function metricRetryDelay(value: string | null, now = Date.now()): number {
  if (!value) return 600_000;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.max(60_000, Math.min(seconds, 16 * 3600_000)) : 600_000;
}
export async function getJobMetrics(id: string) {
  const job = (await readState()).jobs.find(item => item.id === z.uuid().parse(id)); if (!job) throw new Error('Publication not found.');
  const base = `workspace_id=eq.${workspace()}&job_id=eq.${id}`;
  const [polls, attempts, observations] = await Promise.all([dbRequest(`studio_metric_polls?${base}`), dbRequest(`studio_metric_attempts?${base}&order=created_at.desc&limit=30`), dbRequest(`studio_metric_observations?${base}&order=collected_at.desc&limit=200`)]);
  const automatic = z.array(z.object({ id: z.uuid(), collected_at: z.string(), values: metricValuesSchema, source: z.string(), definition: z.string(), adapter_version: z.string(), anomaly: z.string().nullable() })).parse(observations);
  return { jobId: id, poll: z.array(z.unknown()).parse(polls)[0] ?? null, attempts: z.array(z.unknown()).parse(attempts), observations: [...job.metrics.map((value, index) => ({ id: `manual-${index}`, collected_at: value.at, values: { ...value, shares: null, favorites: null }, source: 'historical_manual', definition: value.notes, adapter_version: null, anomaly: null })), ...automatic].sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at)) };
}
export async function configureMetricPolling(id: string, value: unknown) {
  const input = z.object({ enabled: z.boolean(), newWindow: z.boolean().default(false) }).strict().parse(value);
  const state = await readState(); const job = state.jobs.find(item => item.id === z.uuid().parse(id));
  if (!job?.snapshot || job.deliveryAction || !['published', 'delivered'].includes(job.status) || !job.remoteId) throw new Error('Metrics polling requires a confirmed work and remote identifier.');
  if (input.enabled && !(job.platform === 'youtube' && job.provider === 'native' || job.snapshot.executorKind === 'browser-fixture')) throw new Error('No verified metrics adapter is available for this work. Keep manual observations.');
  return dbRpc('studio_configure_metric_poll', { p_workspace: workspace(), p_job: id, p_enabled: input.enabled, p_new_window: input.newWindow });
}
export async function queueMetricCollection(id: string): Promise<{ operationId: string }> {
  const job = (await readState()).jobs.find(item => item.id === z.uuid().parse(id));
  if (!job?.snapshot || job.deliveryAction || !job.remoteId || !['published', 'delivered'].includes(job.status)) throw new Error('Metrics collection requires a confirmed work and remote identifier.');
  if (!(job.platform === 'youtube' && job.provider === 'native' || job.snapshot.executorKind === 'browser-fixture')) throw new Error('No verified metrics adapter is available for this work. Keep manual observations.');
  const operationId = z.uuid().parse(await dbRpc('studio_queue_metric_collection', { p_workspace: workspace(), p_job: z.uuid().parse(id), p_manual: true })); return { operationId };
}
export async function handleMetricCollection(operationId: string, owner: string, input: Record<string, unknown>, signal: AbortSignal) {
  const jobId = z.uuid().parse(input.jobId); const attemptId = z.uuid().parse(input.attemptId);
  const previous = z.array(z.object({ status: z.enum(['queued', 'succeeded', 'failed', 'cancelled']), error: z.string().nullable() })).parse(await dbRequest(`studio_metric_attempts?id=eq.${attemptId}&workspace_id=eq.${workspace()}&operation_id=eq.${operationId}`))[0];
  if (!previous) throw new Error('Metric attempt is missing.');
  if (previous.status === 'succeeded') return { collected: true as const, attemptId };
  if (previous.status !== 'queued') return { collected: false as const, attemptId, error: previous.error ?? 'METRICS_UNAVAILABLE' };
  try {
    return await withJobExecution(jobId, 'metrics', async () => {
      signal.throwIfAborted();
      const polls = z.array(z.object({ deadline: z.string() })).parse(await dbRequest(`studio_metric_polls?workspace_id=eq.${workspace()}&job_id=eq.${jobId}`));
      if (!polls[0] || Date.parse(polls[0].deadline) <= Date.now()) { const error = new Error('Metric window expired.'); Object.assign(error, { metricCode: 'WINDOW_EXPIRED' }); throw error; }
      const state = await readState(); const job = state.jobs.find(item => item.id === jobId); const account = state.accounts.find(item => item.id === job?.accountId);
      if (!job?.snapshot || !account || account.status !== 'connected' || accountExecutionKey(account) !== accountExecutionKey(job.snapshot.account) || !job.remoteId || job.deliveryAction || !['published', 'delivered'].includes(job.status)) throw new Error('The frozen work or target account is unavailable.');
      const result = job.platform === 'youtube' && job.provider === 'native' ? await (await import('./youtube.ts')).collectYouTubeJobMetrics(jobId) : await (await import('./browser-publisher.ts')).collectBrowserJobMetrics(job);
      signal.throwIfAborted(); const observation = metricObservationInputSchema.parse(result); metricValuesSchema.parse({ views: observation.views, likes: observation.likes, comments: observation.comments, shares: observation.shares, favorites: observation.favorites, clicks: observation.clicks });
      if (await dbRpc('studio_finish_metric_attempt', { p_workspace: workspace(), p_attempt: attemptId, p_operation: operationId, p_owner: owner, p_observation: observation, p_error: null, p_delay_seconds: 600 }) !== true) throw new Error('Metric operation ownership changed before its result was saved.');
      return { collected: true as const, attemptId };
    });
  } catch (error) {
    const code = error instanceof Error && 'metricCode' in error && typeof error.metricCode === 'string' ? error.metricCode : error instanceof Error && /authorization|login|connected/.test(error.message) ? 'AUTH_REQUIRED' : error instanceof Error && /busy|unresolved/.test(error.message) ? 'ACCOUNT_BUSY' : 'METRICS_UNAVAILABLE';
    const delay = code === 'RATE_LIMIT' && error instanceof Error && 'retryAfter' in error ? metricRetryDelay(typeof error.retryAfter === 'string' ? error.retryAfter : null) : code === 'ACCOUNT_BUSY' ? 60_000 : 600_000;
    const saved = await dbRpc('studio_finish_metric_attempt', { p_workspace: workspace(), p_attempt: attemptId, p_operation: operationId, p_owner: owner, p_observation: null, p_error: code, p_delay_seconds: Math.ceil(delay / 1000) });
    if (saved !== true) throw new Error('Metric collection ownership changed; its result was not saved.');
    return { collected: false as const, attemptId, error: code };
  }
}
