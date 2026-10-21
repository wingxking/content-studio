import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { dbRequest, dbRpc } from './database.ts';
import { loadRuntimeEnvironment } from './runtime-env.ts';
import { dataDirectory, readState } from './store.ts';
import { atomicFile } from './artifacts.ts';
import { createDraft } from './pipeline.ts';
import { briefSchema, type Brief } from './model.ts';
import { buildDiscoveryPrompt, CONTENT_GUIDANCE_VERSION } from './content-prompts.ts';
import { assertAvailableModel } from './models.ts';
import { adaptMaster, generateMaster, runStructuredGeneration, type GenerationOptions } from './generation-engine.ts';
import { researchSources } from './research.ts';
import { hotQuestionSchema, taskInputSchema, taskRunSchema, taskSchema, type Task, type TaskInput, type TaskRun } from './task-model.ts';
import { knowledgeStore } from './knowledge.ts';
import { repairDiscoveryPromotions } from './discovery-automation.ts';
import { authorizeTask, deliverGeneratedArticle } from './task-automation.ts';
import { buildBrandPrompt } from './content-prompts.ts';
import { produceEvidenceArticle, discoverProductionQuestions } from './production.ts';
import { registerTaskSources } from './source-registry.ts';

export async function taskWorkspaceId(): Promise<string> {
  await loadRuntimeEnvironment();
  return z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
}
const date = (value: unknown): string => new Date(z.string().parse(value)).toISOString();
const nullableDate = (value: unknown): string | null => value == null ? null : date(value);
const rowSchema = z.record(z.string(), z.unknown());
export function taskFromRow(input: unknown): Task {
  const row = rowSchema.parse(input);
  return taskSchema.parse({ ...rowSchema.parse(row.config), id: row.id, createdAt: date(row.created_at), updatedAt: date(row.updated_at), nextRunAt: nullableDate(row.next_run_at) });
}
export function runFromRow(input: unknown): TaskRun {
  const row = rowSchema.parse(input); const snapshot = rowSchema.parse(row.task_snapshot);
  return taskRunSchema.parse({
    id: row.id, taskId: row.task_id, slot: row.slot,
    taskSnapshot: { ...snapshot, createdAt: date(snapshot.createdAt), updatedAt: date(snapshot.updatedAt), nextRunAt: nullableDate(snapshot.nextRunAt) },
    status: row.status, phase: row.phase, progress: row.progress, attempt: row.attempt, error: row.error, ...(row.guidance_version ? { guidanceVersion: row.guidance_version } : {}),
    questions: row.questions, sources: row.sources, warnings: row.warnings ?? [], master: row.master, variants: row.variants,
    draftId: row.draft_id, outputPaths: row.output_paths, startedAt: nullableDate(row.started_at), finishedAt: nullableDate(row.finished_at),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    ...(row.refresh_draft_id ? { refreshTarget: { draftId: row.refresh_draft_id, expectedRevision: row.refresh_revision, reason: row.refresh_reason } } : {}),
  });
}
function firstRow(input: unknown, message: string): unknown {
  const rows = z.array(z.unknown()).parse(input); if (!rows[0]) throw new Error(message); return rows[0];
}
function productionProgress(stage: string): number | null {
  if (stage === 'research_plan') return 5;
  if (/^(?:research_|discovery_|evidence_bundle)/u.test(stage)) return 20;
  if (stage === 'evidence_ledger') return 35;
  if (/^(?:supplement_|ledger_)/u.test(stage)) return /_1(?:_|$)/u.test(stage) ? 45 : 40;
  if (stage === 'write_master') return 50;
  if (/^(?:check_master_|revise_|quality_master_)/u.test(stage)) return 60 + Number(/_(\d+)$/u.exec(stage)?.[1] ?? 0) * 8;
  if (stage.startsWith('variant_')) return stage.endsWith('_check') ? 88 : 82;
  if (stage === 'quality_final') return 93;
  if (stage === 'cluster_topics' || stage === 'topic_clusters_saved') return 35;
  if (stage === 'select_topics') return 60;
  return null;
}
export async function listTasks(): Promise<Task[]> {
  return z.array(z.unknown()).parse(await dbRequest(`studio_tasks?workspace_id=eq.${await taskWorkspaceId()}&order=created_at.desc&limit=500`)).map(taskFromRow);
}
export async function getTask(id: string): Promise<Task> {
  return taskFromRow(firstRow(await dbRequest(`studio_tasks?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${z.uuid().parse(id)}&limit=1`), 'Task not found.'));
}
async function saveTask(id: string, value: TaskInput, previous?: Task): Promise<Task> {
  const input = taskInputSchema.parse(value);
  if (!previous || previous.model !== input.model || !previous.enabled && input.enabled) await assertAvailableModel(input.model);
  const accounts = (await readState()).accounts;
  if (input.pipelineVersion === 2) await registerTaskSources(await taskWorkspaceId(), input.sourcePreferences ?? []);
  for (const sourceId of input.knowledgeIds) await knowledgeStore().get(sourceId);
  input.sources = input.sources.filter(source => source.url.trim() || source.title.trim() || source.excerpt.trim());
  const authorization = authorizeTask(input, accounts, previous);
  return taskFromRow(await dbRpc('studio_save_task', { p_workspace: await taskWorkspaceId(), p_id: id, p_config: { ...input, ...(authorization ? { authorization } : {}) } }));
}
export async function createTask(input: TaskInput, commandId?: string): Promise<Task> {
  if (!commandId) return saveTask(randomUUID(), input);
  const config = taskInputSchema.parse(input); await assertAvailableModel(config.model);
  const accounts = (await readState()).accounts;
  if (config.pipelineVersion === 2) await registerTaskSources(await taskWorkspaceId(), config.sourcePreferences ?? []);
  for (const sourceId of config.knowledgeIds) await knowledgeStore().get(sourceId);
  const authorization = authorizeTask(config, accounts);
  return taskFromRow(await dbRpc('studio_create_task', { p_workspace: await taskWorkspaceId(), p_command: z.uuid().parse(commandId), p_config: { ...config, ...(authorization ? { authorization } : {}) } }));
}
export async function updateTask(id: string, input: TaskInput): Promise<Task> { const previous = await getTask(id); return saveTask(z.uuid().parse(id), input, previous); }
export async function enqueueWork(type: string, id: string): Promise<void> {
  await dbRpc('studio_enqueue_work', { p_workspace: await taskWorkspaceId(), p_type: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/u).parse(type), p_id: z.uuid().parse(id) });
}
export async function enqueueTaskRun(taskId: string, options: { manual?: boolean; requestId?: string } = {}): Promise<TaskRun> {
  const slot = options.manual === false ? `requested:${z.uuid().parse(options.requestId ?? randomUUID())}` : `manual:${z.uuid().parse(options.requestId ?? randomUUID())}`;
  return runFromRow(await dbRpc('studio_enqueue_task_run', { p_workspace: await taskWorkspaceId(), p_task: z.uuid().parse(taskId), p_slot: slot }));
}
export async function listTaskRuns(taskId?: string): Promise<TaskRun[]> {
  const filter = taskId ? `&task_id=eq.${z.uuid().parse(taskId)}` : '';
  return z.array(z.unknown()).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}${filter}&order=created_at.desc&limit=500`)).map(runFromRow);
}
export async function getTaskRun(id: string): Promise<TaskRun> {
  const run = runFromRow(firstRow(await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${z.uuid().parse(id)}&limit=1`), 'Task run not found.'));
  return run;
}
export async function taskRunOwnership(id: string, token: string): Promise<{ status: TaskRun['status']; owned: boolean }> {
  const input = firstRow(await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${z.uuid().parse(id)}&select=status,lease_token&limit=1`), 'Task run not found.');
  const row = z.object({ status: taskRunSchema.shape.status, lease_token: z.uuid().nullable() }).parse(input);
  return { status: row.status, owned: row.lease_token === token };
}
export async function cancelTaskRun(id: string): Promise<TaskRun> {
  const run = runFromRow(await dbRpc('studio_cancel_task_run', { p_workspace: await taskWorkspaceId(), p_run: z.uuid().parse(id) }));
  return run;
}
export async function retryTaskRun(id: string): Promise<TaskRun> {
  return runFromRow(await dbRpc('studio_retry_task_run', { p_workspace: await taskWorkspaceId(), p_run: z.uuid().parse(id) }));
}
type TaskRuntime = {
  resolveImagePaths: (ids: string[]) => Promise<string[]>;
  research: typeof researchSources; generateMaster: typeof generateMaster; adaptMaster: typeof adaptMaster;
  structured: typeof runStructuredGeneration;
};
let runtime: TaskRuntime = {
  resolveImagePaths: async ids => { if (ids.length) throw new Error('The worker asset resolver is not configured.'); return []; },
  research: researchSources, generateMaster, adaptMaster, structured: runStructuredGeneration,
};
export function configureTaskRuntime(input: Partial<TaskRuntime>): void { runtime = { ...runtime, ...input }; }
const questionEnvelope = z.object({ questions: z.array(hotQuestionSchema).max(20), skipped: z.array(z.object({ topic: z.string(), assessment: z.object({ status: z.enum(['excluded', 'uncertain']), reasons: z.array(z.string()).min(1) }) })).max(100) });
async function exportsFor(run: TaskRun): Promise<TaskRun['outputPaths']> {
  const directory = join(dataDirectory(), 'runs', run.id); await mkdir(directory, { recursive: true, mode: 0o700 });
  const paths = { master: 'master.md', package: 'package.json', platforms: Object.fromEntries(run.variants.map(variant => [variant.platform, `${variant.platform}.md`])) };
  try {
    const prior: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (z.object({ id: z.literal(run.id), status: z.literal('succeeded') }).safeParse(prior).success) return paths;
  } catch { /* Missing or interrupted exports are repaired by an explicit worker operation. */ }
  const master = run.master ? `# ${run.master.title}\n\n${run.master.body}\n` : `# ${run.taskSnapshot.title}\n\n${run.questions.map((item, index) => `${index + 1}. ${item.question}\n   ${item.sourceUrls.join(' ')}`).join('\n\n')}\n`;
  await atomicFile(join(directory, 'master.md'), master);
  const knowledge = run.taskSnapshot.knowledgeIds.length ? { ref: run.id, sources: (await knowledgeStore().readSnapshot(run.id, run.taskSnapshot.knowledgeIds)).map(({ excerpt: _excerpt, start, end, ...source }) => ({ ...source, start, end })) } : null;
  const platforms: Record<string, string> = {};
  for (const variant of run.variants) {
    const filename = `${variant.platform}.md`; platforms[variant.platform] = filename;
    await atomicFile(join(directory, filename), `# ${variant.title}\n\n${variant.text}\n\n${variant.tags.map(tag => `#${tag.replace(/^#/u, '')}`).join(' ')}\n`);
  }
  // Commit marker is written last, after every projection is durable.
  await atomicFile(join(directory, 'package.json'), JSON.stringify({ ...run, knowledge, guidanceVersion: run.guidanceVersion ?? 'legacy-unknown' }, null, 2));
  return { master: 'master.md', package: 'package.json', platforms };
}
export async function repairRunArtifacts(run: TaskRun): Promise<TaskRun> {
  const outputPaths = await exportsFor(run);
  await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${run.id}&status=eq.succeeded`, { method: 'PATCH', body: { output_paths: outputPaths } });
  const repaired = { ...run, outputPaths }; await exportsFor(repaired); return repaired;
}
export async function readRunArtifact(id: string, name: string): Promise<{ path: string; content: Buffer }> {
  const run = await getTaskRun(id); const outputs = run.outputPaths;
  if (!outputs || ![outputs.master, outputs.package, ...Object.values(outputs.platforms)].includes(name) || !/^[a-z][a-z0-9_-]*\.(?:md|json)$/u.test(name)) throw new Error('Run artifact not found.');
  const root = await realpath(join(dataDirectory(), 'runs', run.id)); const path = await realpath(join(root, name));
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid artifact path.');
  return { path, content: await readFile(path) };
}
export async function processTaskRun(id: string, token: string, signal: AbortSignal): Promise<void | 'deferred'> {
  const workspace = await taskWorkspaceId();
  const claimed = await dbRpc('studio_claim_task_run', { p_workspace: workspace, p_run: z.uuid().parse(id), p_token: z.uuid().parse(token) });
  if (!claimed || !rowSchema.parse(claimed).id) {
    const current = await getTaskRun(id);
    if (['researching', 'generating', 'queued'].includes(current.status)) throw new Error('Task run has an active lease; queue delivery will retry.');
    if (current.status === 'succeeded') { await exportsFor(current); await repairDiscoveryPromotions(current, workspace); await syncGeneratedDraft(current); }
    return;
  }
  let run = runFromRow(claimed);
  const patch = async (value: Record<string, unknown>): Promise<void> => {
    signal.throwIfAborted();
    const result = await dbRpc('studio_patch_task_run', { p_workspace: workspace, p_run: id, p_token: token, p_patch: value });
    if (!result || !rowSchema.parse(result).id) throw new Error('Task lease changed or the run was cancelled.');
    run = runFromRow(result);
  };
  try {
    if (run.refreshTarget) {
      const target = (await readState()).drafts.find(draft => draft.id === run.refreshTarget?.draftId);
      const committedByThisRun = target?.revision === run.refreshTarget.expectedRevision + 1 && target.generationEvidenceRunId === run.id;
      if (!target || target.revision !== run.refreshTarget.expectedRevision && !committedByThisRun) throw new Error('Draft revision changed after this research request. Open the current revision and request research again; your saved edit is preserved.');
    }
    const task = run.taskSnapshot; const instruction = `${task.prompt}${buildBrandPrompt(task.brand)}`; const imagePaths = await runtime.resolveImagePaths(task.assetIds);
    if (!run.guidanceVersion && run.attempt === 1 && !run.master && !run.sources.length) await patch({ guidanceVersion: CONTENT_GUIDANCE_VERSION });
    if (imagePaths.length !== task.assetIds.length) throw new Error('Every selected reference image must resolve successfully.');
    const knowledge = task.knowledgeIds.length ? await knowledgeStore().snapshot(run.id, task.knowledgeIds, `${task.prompt}\n${task.angle}`) : [];
    const options: GenerationOptions = { model: task.model, imagePaths, knowledge, signal };
    if (task.pipelineVersion === 2) {
      const productionOptions = { ...options, onProgress: async (event: { phase: string }) => { const progress = productionProgress(event.phase); if (progress !== null) await patch({ phase: event.phase, progress: Math.max(run.progress, progress) }); } };
      if (task.kind === 'discovery') {
        const result = await discoverProductionQuestions(run, workspace, token, runtime, productionOptions);
        await patch({ ...result, phase: 'questions_saved', progress: 95 });
        const outputPaths = await exportsFor(run); await patch({ status: 'succeeded', phase: 'completed', progress: 100, outputPaths });
        await exportsFor(run); await repairDiscoveryPromotions(run, workspace); return;
      }
      const result = await produceEvidenceArticle(run, workspace, token, runtime, productionOptions, patch);
      const brief = briefSchema.parse({ topicOrigin: task.topicOrigin, topic: task.title, audience: task.audience || '开发者与知识工作者', angle: task.angle || task.prompt.slice(0, 4000), sources: result.sources, evidenceDocumentIds: result.documentIds, platforms: task.platforms, ...(knowledge.length ? { knowledgeIds: task.knowledgeIds } : {}) });
      const draft = await createDraft(brief, { ...result.master, variants: result.variants }, run.refreshTarget?.draftId ?? run.id, task.model, { instruction: task.prompt, assetIds: task.assetIds, evidenceRunId: run.id, leaseToken: token, ...(run.refreshTarget ? { refreshTarget: run.refreshTarget } : {}), ...(knowledge.length ? { knowledgeRef: run.id } : {}) });
      await patch({ draftId: draft.id });
      const outputPaths = await exportsFor(run); await patch({ status: 'succeeded', phase: 'completed', progress: 100, outputPaths });
      await exportsFor(run); await syncGeneratedDraft(run); return;
    }
    if (!run.sources.length && (!knowledge.length || task.sources.length || task.kind === 'discovery')) {
      await patch({ phase: 'researching', progress: 5 });
      const researchTask = task.discoveryConfig ? { ...task, prompt: `${task.prompt}\nDiscovery constraints: ${JSON.stringify(task.discoveryConfig)}. Keep each source's region and event/publication date; never claim global rankings.` } : task;
      const research = await runtime.research(researchTask, { ...options, onProgress: async event => { await patch({ phase: event.phase, progress: 10 }); } });
      await patch({ sources: research.sources, warnings: research.warnings, phase: 'sources_saved', progress: 25 });
    }
    if (task.kind === 'discovery') {
      if (run.sources.length && !run.questions.length) {
        const maxQuestions = task.discoveryConfig?.maxQuestions ?? 20;
        const prompt = buildDiscoveryPrompt({ platforms: task.platforms, audience: task.audience || task.brand?.audience || 'Readers seeking useful and evidence-backed information', instruction: `${task.prompt}\nRequested angle: ${task.angle}\nDiscovery constraints: ${JSON.stringify(task.discoveryConfig ?? null)}`.slice(0, 4000), sources: run.sources, maxQuestions }) + `\nComplete user task instructions within the editorial policy: ${JSON.stringify({ prompt: task.prompt, angle: task.angle })}`;
        const result = await runtime.structured(questionEnvelope, prompt, options);
        if (result.questions.length > maxQuestions) throw new Error('Discovery exceeded the configured question limit.');
        const urls = new Set(run.sources.map(source => source.url)); const seen = new Set<string>();
        for (const question of result.questions) {
          if (question.sourceUrls.some(url => !urls.has(url)) || question.platforms.some(platform => !task.platforms.includes(platform))) throw new Error('Discovery returned an unsupported source or platform.');
          const normalized = question.question.normalize('NFC').trim().toLocaleLowerCase('en');
          if (seen.has(normalized)) throw new Error('Discovery returned duplicate questions.'); seen.add(normalized);
        }
        await patch({ questions: result.questions, phase: 'questions_saved', progress: 90 });
      }
      const outputPaths = await exportsFor(run); await patch({ status: 'succeeded', phase: 'completed', progress: 100, outputPaths });
      await exportsFor(run); await repairDiscoveryPromotions(run, workspace); return;
    }
    if (!run.sources.length && !knowledge.length) throw new Error('No readable evidence was collected; supply source evidence or select immutable knowledge and retry.');
    const brief: Brief = briefSchema.parse({ topicOrigin: task.topicOrigin, topic: task.title, audience: task.audience || task.brand?.audience || 'Readers seeking useful and evidence-backed information', angle: task.angle || task.prompt.slice(0, 4000), sources: run.sources, ...(knowledge.length ? { knowledgeIds: task.knowledgeIds } : {}), platforms: task.platforms });
    if (!run.master) {
      await patch({ status: 'generating', phase: 'generating_master', progress: 35 });
      const master = await runtime.generateMaster(brief, instruction, options);
      await patch({ master, status: 'generating', phase: 'master_saved', progress: 50 });
    }
    const master = run.master; if (!master) throw new Error('The master checkpoint was not saved.');
    // Repair exports after a crash between saving the durable master and writing its files.
    await patch({ outputPaths: await exportsFor(run) });
    for (const [index, platform] of task.platforms.entries()) {
      if (run.variants.some(variant => variant.platform === platform)) continue;
      await patch({ status: 'generating', phase: `adapting_${platform}`, progress: 50 + Math.floor(index / task.platforms.length * 40) });
      const variant = await runtime.adaptMaster(brief, master, platform, instruction, options);
      await patch({ variants: [...run.variants, variant], phase: `${platform}_saved`, progress: 50 + Math.floor((index + 1) / task.platforms.length * 40) });
      await patch({ outputPaths: await exportsFor(run) });
    }
    signal.throwIfAborted(); await patch({ phase: 'saving_draft', progress: 95 });
    const draft = await createDraft(brief, { ...master, variants: run.variants }, run.id, task.model, { instruction: task.prompt, assetIds: task.assetIds, ...(knowledge.length ? { knowledgeRef: run.id } : {}) });
    await patch({ draftId: draft.id }); const outputPaths = await exportsFor(run);
    await patch({ status: 'succeeded', phase: 'completed', progress: 100, outputPaths });
    await exportsFor(run);
    await syncGeneratedDraft(run);
  } catch (error) {
    if (signal.aborted) throw error;
    const current = await getTaskRun(id);
    if (current.status === 'cancelled') return;
    if (current.status === 'succeeded') throw error;
    if (run.taskSnapshot.pipelineVersion === 2 && error instanceof Error) {
      const quota = /usage limit|rate.?limit|quota|\b429\b/iu.test(error.message);
      const transient = /could not reach|Source request failed|Supabase request failed;|Supabase request failed \(HTTP 5|fetch failed|timed out|timeout|Knowledge processing is unavailable/iu.test(error.message);
      if ((quota || transient) && run.attempt <= 8) {
        const deferred = await dbRpc('studio_defer_research', { p_workspace: workspace, p_run: id, p_token: token, p_delay: quota ? 1800 : Math.min(300, 30 * Math.max(1, run.attempt)), p_reason: quota ? 'quota' : 'service' });
        if (deferred === true) return 'deferred';
        throw error;
      }
    }
    await patch({ status: 'failed', phase: 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : 'Task execution failed.' });
  }
}

/** New delivery policies require explicit grants; legacy draft synchronization retains draft-only authority. */
async function syncGeneratedDraft(run: TaskRun): Promise<void> {
  if (run.taskSnapshot.delivery) {
    const warnings = await deliverGeneratedArticle(run);
    if (warnings.length) await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${run.id}`, { method: 'PATCH', body: { warnings: [...new Set([...run.warnings, ...warnings])] } });
    return;
  }
  if (!run.draftId || !run.taskSnapshot.draftSync?.enabled) return;
  const { saveRemoteDrafts } = await import('./remote-drafts.ts');
  const { readState } = await import('./store.ts');
  const draft = (await readState()).drafts.find(item => item.id === run.draftId);
  if (!draft) return;
  const warnings: string[] = [];
  // A task creates revision one. Recovery must never authorize a later manual edit.
  if (draft.revision !== 1) warnings.push('Automatic draft synchronization was skipped because this article changed after the task generated it. Review the current platform versions in Distribution.');
  else for (const accountId of run.taskSnapshot.draftSync.accountIds) {
    try { await saveRemoteDrafts(draft.id, { expectedRevision: 1, accountIds: [accountId] }); }
    catch { warnings.push(`Draft synchronization needs attention for account ${accountId}. Review this platform version in Distribution.`); }
  }
  if (warnings.length) await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${run.id}`, { method: 'PATCH', body: { warnings: [...new Set([...run.warnings, ...warnings])] } });
}
