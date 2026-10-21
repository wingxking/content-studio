import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { observationStatusAt, observationWindowMs, observationIntervalMs, runRuntimeObservation, type ObservationReport, type ObservationOptions } from '../../scripts/runtime-observation.mjs';
import { runtimeReleaseSchema, type RuntimeRelease } from '../contracts/runtime-release.ts';
import { readRuntimeRelease } from './runtime-release.ts';
import { dataDirectory } from './store.ts';

const reportSchema = z.object({
  version: z.literal(1), scope: z.literal('runtime_readiness_only'), executionId: z.uuid(), workspaceId: z.uuid(),
  release: runtimeReleaseSchema.extend({ builtAt: z.iso.datetime().nullable() }),
  status: z.enum(['running', 'passed', 'smoke_only', 'failed', 'interrupted']),
  startedAt: z.iso.datetime(), checkedAt: z.iso.datetime().nullable(), targetHours: z.literal(48),
  intervalSeconds: z.literal(60), maximumGapSeconds: z.literal(180), samples: z.number().int().nonnegative(),
  elapsedHours: z.number().nonnegative(), monotonicElapsedHours: z.number().nonnegative(),
  accepted: z.boolean(), qualityAccepted: z.literal(false), productionAccepted: z.literal(false),
  checks: z.object({ apiHealth: z.literal(true), apiReadiness: z.literal(true), releaseMatched: z.literal(true), requiredSetupReady: z.literal(true) }).nullable(),
  error: z.string().nullable(),
});

type ManagedObservation = { directory: string; controller: AbortController; completion: Promise<void> };
let managed: ManagedObservation | null = null;
let starting: Promise<{ started: boolean }> | null = null;

/** Explicit operation owned by the current API process, never a detached child. */
export function startRuntimeObservation(): Promise<{ started: boolean }> {
  if (starting) return starting;
  if (managed) return Promise.resolve({ started: false });
  starting = (async () => {
    if (process.env.STUDIO_CONTAINER !== 'true') throw new Error('连续运行观察只能在现有容器环境内启动。');
    const release = await readRuntimeRelease();
    const workspaceId = z.uuid().safeParse(process.env.STUDIO_WORKSPACE_ID);
    if (!release || !workspaceId.success) throw new Error('请先核验当前工作区和固定发布版本。');
    const options: ObservationOptions = { workspaceId: workspaceId.data, release, directory: join(dataDirectory(), 'runtime-observation', `managed-${randomUUID()}`), port: z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT ?? '4310'), once: false, reset: false };
    await startManagedObservation(options);
    return { started: true };
  })().finally(() => { starting = null; });
  return starting;
}

/** The supplied runner exists for bounded lifecycle tests; HTTP callers cannot choose paths or timing. */
export async function startManagedObservation(options: ObservationOptions, runner: typeof runRuntimeObservation = runRuntimeObservation): Promise<void> {
  if (managed) throw new Error('已有运行观察正在进行，请先停止当前观察。');
  const entry: ManagedObservation = { directory: options.directory, controller: new AbortController(), completion: Promise.resolve() };
  managed = entry;
  await new Promise<void>((resolve, reject) => {
    let began = false;
    entry.completion = runner(options, { signal: entry.controller.signal, log: () => undefined, onStarted: () => { began = true; resolve(); } }).then(() => { if (!began) reject(new Error('无法启动运行观察，请检查现有运行环境。')); }, () => { reject(new Error('无法启动运行观察，请检查现有运行环境。')); }).finally(() => {
      if (managed === entry) managed = null;
    });
  });
}

export async function stopRuntimeObservation(): Promise<{ stopped: boolean }> {
  if (starting) await starting.catch(() => undefined);
  const entry = managed;
  if (!entry) return { stopped: false };
  entry.controller.abort();
  await entry.completion;
  return { stopped: true };
}

const messages = {
  not_started: '当前版本尚未开始连续 48 小时运行观察。',
  unavailable: '运行观察记录暂不可读取，请检查运行状态。',
  running: '正在记录连续运行状态，尚未完成 48 小时验收。',
  interrupted: '运行观察已中断，旧窗口不能累计，需要重新开始连续 48 小时观察。',
  failed: '运行观察未通过，请检查服务后重新开始连续观察。',
  smoke_only: '仅完成一次运行检查，不能计为 48 小时验收。',
  passed: '当前版本已完成连续 48 小时运行观察；内容质量和真实发布仍单独验收。',
} as const;
export type RuntimeObservationStatus = keyof typeof messages;

function summary(status: RuntimeObservationStatus, release: RuntimeRelease | null, report?: ObservationReport) {
  return {
    status, release, scope: 'runtime_readiness_only' as const,
    accepted: status === 'passed', qualityAccepted: false, productionAccepted: false,
    startedAt: report?.startedAt ?? null, checkedAt: report?.checkedAt ?? null,
    targetHours: 48, elapsedHours: report?.elapsedHours ?? 0, samples: report?.samples ?? 0,
    message: messages[status],
    nextAction: status === 'passed' ? '继续核验内容质量与真实发布' : status === 'running' ? '保持现有运行环境，等待观察完成' : '检查服务并重新开始连续观察',
  };
}

/** Read only bounded local reports. Never start/resume/reset an acceptance window from a GET. */
export async function runtimeObservation(options: { directory?: string; workspaceId?: string; release?: RuntimeRelease | null; now?: number } = {}) {
  const release = options.release === undefined ? await readRuntimeRelease() : options.release;
  const workspace = options.workspaceId ?? process.env.STUDIO_WORKSPACE_ID;
  if (!release || !z.uuid().safeParse(workspace).success) return summary('unavailable', release);
  const directory = options.directory ?? join(dataDirectory(), 'runtime-observation');
  try {
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return summary('not_started', release);
    if (!info.isDirectory() || info.isSymbolicLink()) return summary('unavailable', release);
    const children = await readdir(directory, { withFileTypes: true });
    // Every configured observation uses its own directory; reject an unbounded inventory.
    if (children.length > 200) return summary('unavailable', release);
    const candidates = [join(directory, 'status.json'), ...children.filter(item => item.isDirectory() && !item.isSymbolicLink()).map(item => join(directory, item.name, 'status.json'))];
    const reports: { report: ObservationReport; path: string }[] = [];
    let invalid = false;
    for (const path of candidates) {
      const file = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!file) continue;
      if (!file.isFile() || file.isSymbolicLink() || file.size > 32768) { invalid = true; continue; }
      try {
        const report = reportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (report.workspaceId === workspace && report.release.version === release.version && report.release.sourceDigest === release.sourceDigest && (!report.release.builtAt || report.release.builtAt === release.builtAt)) reports.push({ report, path });
      } catch { invalid = true; }
    }
    const latest = reports.sort((a, b) => Date.parse(b.report.startedAt) - Date.parse(a.report.startedAt))[0];
    if (!latest) return summary(invalid ? 'unavailable' : 'not_started', release);
    let current = observationStatusAt(latest.report, options.now ?? Date.now());
    if (current.status === 'running' && basename(dirname(latest.path)).startsWith('managed-') && managed?.directory !== dirname(latest.path)) current = { ...current, status: 'interrupted', accepted: false };
    const passed = current.status === 'passed' && current.accepted && current.elapsedHours >= 48 && current.monotonicElapsedHours >= 48 && current.samples >= observationWindowMs / observationIntervalMs + 1 && Boolean(current.checks);
    const status = current.status === 'passed' && !passed ? 'failed' : current.status;
    return summary(status, release, current);
  } catch { return summary('unavailable', release); }
}
