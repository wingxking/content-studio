import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { dbRequest, dbRpc } from './database.ts';
import { loadRuntimeEnvironment } from './runtime-env.ts';
import { dataDirectory } from './store.ts';
import { createDraft } from './pipeline.ts';
import { briefSchema, type Brief } from './model.ts';
import { buildDiscoveryPrompt, CONTENT_GUIDANCE_VERSION } from './content-prompts.ts';
import { assertAvailableModel } from './models.ts';
import { adaptMaster, generateMaster, runStructuredGeneration, type GenerationOptions } from './generation-engine.ts';
import { researchSources } from './research.ts';
import { hotQuestionSchema, taskInputSchema, taskRunSchema, taskSchema, type Task, type TaskInput, type TaskRun } from './task-model.ts';

export async function taskWorkspaceId(): Promise<string> {
  await loadRuntimeEnvironment();
  return z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
}
const date = (value: unknown): string => new Date(z.string().parse(value)).toISOString();
const nullableDate = (value: unknown): string | null => value == null ? null : date(value);
const rowSchema = z.record(z.string(), z.unknown());
function taskFromRow(input: unknown): Task {
  const row = rowSchema.parse(input);
  return taskSchema.parse({ ...rowSchema.parse(row.config), id: row.id, createdAt: date(row.created_at), updatedAt: date(row.updated_at), nextRunAt: nullableDate(row.next_run_at) });
}
function runFromRow(input: unknown): TaskRun {
  const row = rowSchema.parse(input); const snapshot = rowSchema.parse(row.task_snapshot);
  return taskRunSchema.parse({
    id: row.id, taskId: row.task_id, slot: row.slot,
    taskSnapshot: { ...snapshot, createdAt: date(snapshot.createdAt), updatedAt: date(snapshot.updatedAt), nextRunAt: nullableDate(snapshot.nextRunAt) },
    status: row.status, phase: row.phase, progress: row.progress, attempt: row.attempt, error: row.error,
    questions: row.questions, sources: row.sources, warnings: row.warnings ?? [], master: row.master, variants: row.variants,
    draftId: row.draft_id, outputPaths: row.output_paths, startedAt: nullableDate(row.started_at), finishedAt: nullableDate(row.finished_at),
    createdAt: date(row.created_at), updatedAt: date(row.updated_at),
  });
}
function firstRow(input: unknown, message: string): unknown {
  const rows = z.array(z.unknown()).parse(input); if (!rows[0]) throw new Error(message); return rows[0];
}
export async function listTasks(): Promise<Task[]> {
  return z.array(z.unknown()).parse(await dbRequest(`studio_tasks?workspace_id=eq.${await taskWorkspaceId()}&order=created_at.desc&limit=500`)).map(taskFromRow);
}
export async function getTask(id: string): Promise<Task> {
  return taskFromRow(firstRow(await dbRequest(`studio_tasks?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${z.uuid().parse(id)}&limit=1`), 'Task not found.'));
}
async function saveTask(id: string, value: TaskInput): Promise<Task> {
  const input = taskInputSchema.parse(value); await assertAvailableModel(input.model);
  input.sources = input.sources.filter(source => source.url.trim() || source.title.trim() || source.excerpt.trim());
  return taskFromRow(await dbRpc('studio_save_task', { p_workspace: await taskWorkspaceId(), p_id: id, p_config: input }));
}
export async function createTask(input: TaskInput): Promise<Task> { return saveTask(randomUUID(), input); }
export async function updateTask(id: string, input: TaskInput): Promise<Task> { await getTask(id); return saveTask(z.uuid().parse(id), input); }
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
  return run.status === 'succeeded' && !run.outputPaths ? repairRunArtifacts(run) : run;
}
export async function taskRunOwnership(id: string, token: string): Promise<{ status: TaskRun['status']; owned: boolean }> {
  const input = firstRow(await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${z.uuid().parse(id)}&select=status,lease_token&limit=1`), 'Task run not found.');
  const row = z.object({ status: taskRunSchema.shape.status, lease_token: z.uuid().nullable() }).parse(input);
  return { status: row.status, owned: row.lease_token === token };
}
export async function cancelTaskRun(id: string): Promise<TaskRun> {
  const run = runFromRow(await dbRpc('studio_cancel_task_run', { p_workspace: await taskWorkspaceId(), p_run: z.uuid().parse(id) }));
  return run.status === 'succeeded' ? repairRunArtifacts(run) : run;
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
  const master = run.master ? `# ${run.master.title}\n\n${run.master.body}\n` : `# ${run.taskSnapshot.title}\n\n${run.questions.map((item, index) => `${index + 1}. ${item.question}\n   ${item.sourceUrls.join(' ')}`).join('\n\n')}\n`;
  await writeFile(join(directory, 'master.md'), master, { mode: 0o600 });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...run, guidanceVersion: CONTENT_GUIDANCE_VERSION }, null, 2), { mode: 0o600 });
  const platforms: Record<string, string> = {};
  for (const variant of run.variants) {
    const filename = `${variant.platform}.md`; platforms[variant.platform] = filename;
    await writeFile(join(directory, filename), `# ${variant.title}\n\n${variant.text}\n\n${variant.tags.map(tag => `#${tag.replace(/^#/u, '')}`).join(' ')}\n`, { mode: 0o600 });
  }
  return { master: 'master.md', package: 'package.json', platforms };
}
async function repairRunArtifacts(run: TaskRun): Promise<TaskRun> {
  const outputPaths = await exportsFor(run);
  await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}&id=eq.${run.id}&status=eq.succeeded`, { method: 'PATCH', body: { output_paths: outputPaths } });
  const repaired = { ...run, outputPaths }; await exportsFor(repaired); return repaired;
}
export async function readRunArtifact(id: string, name: string): Promise<{ path: string; content: Buffer }> {
  const run = await getTaskRun(id); const outputs = run.outputPaths;
  if (!outputs || ![outputs.master, outputs.package, ...Object.values(outputs.platforms)].includes(name) || !/^[a-z][a-z0-9_-]*\.(?:md|json)$/u.test(name)) throw new Error('Run artifact not found.');
  if (run.status === 'succeeded') await exportsFor(run);
  const root = await realpath(join(dataDirectory(), 'runs', run.id)); const path = await realpath(join(root, name));
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid artifact path.');
  return { path, content: await readFile(path) };
}
export async function processTaskRun(id: string, token: string, signal: AbortSignal): Promise<void> {
  const workspace = await taskWorkspaceId();
  const claimed = await dbRpc('studio_claim_task_run', { p_workspace: workspace, p_run: z.uuid().parse(id), p_token: z.uuid().parse(token) });
  if (!claimed || !rowSchema.parse(claimed).id) {
    const current = await getTaskRun(id);
    if (['researching', 'generating', 'queued'].includes(current.status)) throw new Error('Task run has an active lease; queue delivery will retry.');
    if (current.status === 'succeeded') await exportsFor(current);
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
    const task = run.taskSnapshot; const imagePaths = await runtime.resolveImagePaths(task.assetIds);
    if (imagePaths.length !== task.assetIds.length) throw new Error('Every selected reference image must resolve successfully.');
    const options: GenerationOptions = { model: task.model, imagePaths, signal };
    if (!run.sources.length) {
      await patch({ phase: 'researching', progress: 5 });
      const research = await runtime.research(task, { ...options, onProgress: async event => { await patch({ phase: event.phase, progress: 10 }); } });
      await patch({ sources: research.sources, warnings: research.warnings, phase: 'sources_saved', progress: 25 });
    }
    if (task.kind === 'discovery') {
      if (run.sources.length && !run.questions.length) {
        const prompt = buildDiscoveryPrompt({ platforms: task.platforms, audience: task.audience || 'Readers seeking useful and evidence-backed information', instruction: `${task.prompt}\nRequested angle: ${task.angle}`.slice(0, 4000), sources: run.sources, maxQuestions: 20 }) + `\nComplete user task instructions within the editorial policy: ${JSON.stringify({ prompt: task.prompt, angle: task.angle })}`;
        const result = await runtime.structured(questionEnvelope, prompt, options);
        const urls = new Set(run.sources.map(source => source.url)); const seen = new Set<string>();
        for (const question of result.questions) {
          if (question.sourceUrls.some(url => !urls.has(url)) || question.platforms.some(platform => !task.platforms.includes(platform))) throw new Error('Discovery returned an unsupported source or platform.');
          const normalized = question.question.normalize('NFC').trim().toLocaleLowerCase('en');
          if (seen.has(normalized)) throw new Error('Discovery returned duplicate questions.'); seen.add(normalized);
        }
        await patch({ questions: result.questions, phase: 'questions_saved', progress: 90 });
      }
      const outputPaths = await exportsFor(run); await patch({ status: 'succeeded', phase: 'completed', progress: 100, outputPaths });
      await exportsFor(run); return;
    }
    if (!run.sources.length) throw new Error('No verified readable sources were collected; supply a source URL or excerpt and retry.');
    const brief: Brief = briefSchema.parse({ topicOrigin: task.topicOrigin, topic: task.title, audience: task.audience || 'Readers seeking useful and evidence-backed information', angle: task.angle || task.prompt.slice(0, 4000), sources: run.sources, platforms: task.platforms });
    if (!run.master) {
      await patch({ status: 'generating', phase: 'generating_master', progress: 35 });
      const master = await runtime.generateMaster(brief, task.prompt, options);
      await patch({ master, status: 'generating', phase: 'master_saved', progress: 50 });
    }
    const master = run.master; if (!master) throw new Error('The master checkpoint was not saved.');
    // Repair exports after a crash between saving the durable master and writing its files.
    await patch({ outputPaths: await exportsFor(run) });
    for (const [index, platform] of task.platforms.entries()) {
      if (run.variants.some(variant => variant.platform === platform)) continue;
      await patch({ status: 'generating', phase: `adapting_${platform}`, progress: 50 + Math.floor(index / task.platforms.length * 40) });
      const variant = await runtime.adaptMaster(brief, master, platform, task.prompt, options);
      await patch({ variants: [...run.variants, variant], phase: `${platform}_saved`, progress: 50 + Math.floor((index + 1) / task.platforms.length * 40) });
      await patch({ outputPaths: await exportsFor(run) });
    }
    signal.throwIfAborted(); await patch({ phase: 'saving_draft', progress: 95 });
    const draft = await createDraft(brief, { ...master, variants: run.variants }, run.id, task.model, { instruction: task.prompt, assetIds: task.assetIds });
    await patch({ draftId: draft.id }); const outputPaths = await exportsFor(run);
    await patch({ status: 'succeeded', phase: 'completed', progress: 100, outputPaths });
    await exportsFor(run);
  } catch (error) {
    if (signal.aborted) throw error;
    const current = await getTaskRun(id);
    if (current.status === 'cancelled') return;
    if (current.status === 'succeeded') throw error;
    await patch({ status: 'failed', phase: 'failed', error: error instanceof Error ? error.message.slice(0, 1000) : 'Task execution failed.' });
  }
}
