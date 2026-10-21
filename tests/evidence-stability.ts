/** Read-only isolated v2 burn-in. Does not generate, schedule, deliver or publish. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import { loadRuntimeEnvironment } from '../src/core/runtime-env.ts';
import { dbRpc } from '../src/core/database.ts';
import { readState } from '../src/core/store.ts';
import { draftQuality } from '../src/core/quality.ts';
import { EvidenceFiles } from '../src/core/evidence.ts';
import { modelExecutorOrigin } from '../src/core/model-executor.ts';

await loadRuntimeEnvironment();
const directory = process.env.STUDIO_EVAL_ROOT;
if (!directory || !isAbsolute(directory)) throw new Error('Set an explicit isolated STUDIO_EVAL_ROOT.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = join(directory, 'evidence-stability.json');
const prior = await readFile(path, 'utf8').catch(() => null);
if (prior) await writeFile(join(directory, `evidence-stability-prior-${randomUUID()}.json`), prior, { mode: 0o600 });
const started = Date.now(); const once = process.argv.includes('--once');
const report = { version: 1, executionId: randomUUID(), status: 'running', startedAt: new Date(started).toISOString(), checkedAt: '', elapsedHours: 0, targetHours: 48, checks: 0, checkedDrafts: 0, checkedSourceArtifacts: 0, accepted: false, publicSubmissions: 0, error: null as string | null };
async function save(): Promise<void> {
  const temporary = `${path}.${report.executionId}.tmp`; await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path);
}
async function ready(origin: string, host?: string): Promise<void> {
  if (host) {
    const url = new URL(`${origin}/readyz`);
    const value = await new Promise<unknown>((accept, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers: { Host: host }, timeout: 15000 }, response => {
        let body = ''; response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); if (body.length > 10000) request.destroy(new Error('Health response exceeded its limit.')); });
        response.once('error', reject); response.once('end', () => { try { if (response.statusCode !== 200) throw new Error('API health failed.'); accept(JSON.parse(body)); } catch { reject(new Error('API health failed.')); } });
      });
      request.once('timeout', () => request.destroy(new Error('API health timed out.'))); request.once('error', reject); request.end();
    });
    z.object({ ready: z.literal(true) }).parse(value); return;
  }
  const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok || !z.object({ ready: z.literal(true) }).safeParse(await response.json()).success) throw new Error('An isolated processing service is not ready.');
}
let stage = 'isolation';
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
try {
  for (;;) {
    stage = 'continuity';
    if (report.checks && Date.now() - Date.parse(report.checkedAt) > 180000) throw new Error('Observation continuity was interrupted.');
    stage = 'isolation';
    const state = await readState();
    if (state.accounts.length || state.jobs.length || !state.paused) throw new Error('Burn-in requires a paused isolated workspace without publishing accounts or jobs.');
    stage = 'database'; const health = await dbRpc('studio_runtime_health');
    z.object({ database: z.literal(true), pgmq: z.literal(true), pg_cron: z.literal(true) }).parse(health);
    stage = 'api'; await ready(z.url().parse(process.env.STUDIO_STABILITY_API_ORIGIN), new URL(z.url().parse(process.env.STUDIO_PUBLIC_ORIGIN)).host);
    stage = 'knowledge'; await ready('http://knowledge-tools:8920'); stage = 'model'; await ready(modelExecutorOrigin());
    stage = 'integrity';
    const drafts = state.drafts.filter(draft => draft.generationEvidenceRunId);
    if (!drafts.length) throw new Error('Complete one real v2 article before starting the stability window.');
    const checked = new Set<string>();
    for (const draft of drafts) {
      const quality = await draftQuality(z.uuid().parse(process.env.STUDIO_WORKSPACE_ID), draft);
      if (!quality.current || quality.report?.status !== 'passed') throw new Error('A generated article lost its revision-bound quality report.');
      for (const source of quality.documents ?? []) for (const hash of [source.sha256, source.originalRef]) if (hash && !checked.has(hash)) { await new EvidenceFiles().read(hash); checked.add(hash); }
    }
    report.checks++; report.checkedDrafts = drafts.length; report.checkedSourceArtifacts = checked.size;
    report.checkedAt = new Date().toISOString(); report.elapsedHours = (Date.now() - started) / 3600000;
    report.accepted = !once && report.elapsedHours >= report.targetHours;
    if (report.accepted) report.status = 'passed'; else if (once) report.status = 'smoke_only';
    await save();
    if (report.checks === 1 || report.checks % 30 === 0 || report.accepted || once) console.log(JSON.stringify(report));
    if (report.accepted || once) break;
    await delay(60000, undefined, { signal: controller.signal });
  }
} catch {
  report.status = controller.signal.aborted ? 'interrupted' : 'failed'; report.accepted = false;
  report.error = controller.signal.aborted ? 'Interrupted; a fresh uninterrupted window is required.' : `The ${stage} check failed. Inspect the isolated runtime.`;
  report.checkedAt = new Date().toISOString(); await save(); console.error(JSON.stringify(report));
  process.exitCode = 1;
}
