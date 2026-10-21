import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contentItemSchema, workspaceSummarySchema, type ContentItem } from '../contracts/workspace.ts';
import { dbRequest, dbRpc } from '../core/database.ts';
import { publicArticle, publicArticleJob } from '../core/article-media.ts';
import { getEditor } from '../core/editor.ts';
import { taskInputSchema, type TaskInput } from '../core/task-model.ts';
import { createTask, enqueueTaskRun, getTaskRun, taskWorkspaceId, runFromRow, taskFromRow } from '../core/tasks.ts';
import { taskFromQuestion } from '../core/task-selection.ts';
import { listModels } from '../core/models.ts';
import { draftSchema, jobSchema, platformSchema } from '../core/model.ts';
import { safeRuntimeError, safeRuntimePhase } from '../core/runtime-overview.ts';

export const pageInputSchema = z.object({
  cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  kind: z.enum(['article', 'video', 'content', 'discovery']).optional(), platform: platformSchema.optional(),
  taskId: z.uuid().optional(), runId: z.uuid().optional(), status: z.string().regex(/^[a-z_]{1,40}$/u).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
});
type PageInput = z.infer<typeof pageInputSchema>;
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
function cursor(value?: string) { return value ? cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))) : null; }
function page<T extends { id: string; createdAt: string }>(items: T[], limit: number) {
  const selected = items.slice(0, limit); const last = selected.at(-1);
  return { items: selected, nextCursor: items.length > limit && last ? Buffer.from(JSON.stringify({ at: new Date(last.createdAt).toISOString(), id: last.id })).toString('base64url') : null };
}
function beforeFilter(input: PageInput): string {
  const after = cursor(input.cursor);
  return after ? `&or=(created_at.lt.${encodeURIComponent(after.at)},and(created_at.eq.${encodeURIComponent(after.at)},id.lt.${after.id}))` : '';
}
export async function workspaceSummary() {
  const workspace = await taskWorkspaceId();
  const [summary, scheduler, health, models] = await Promise.all([
    dbRpc('studio_workspace_summary', { p_workspace: workspace }), dbRpc('studio_scheduler_status'), dbRpc('studio_runtime_health'), listModels().catch(() => []),
  ]);
  const value = workspaceSummarySchema.pick({ paused: true, accounts: true }).parse(summary ?? { paused: true, accounts: [] });
  const modelOrigin = process.env.STUDIO_MODEL_EXECUTOR_URL;
  let modelReady = false;
  if (modelOrigin) try { modelReady = (await fetch(`${modelOrigin}/readyz`, { signal: AbortSignal.timeout(3000), redirect: 'error' })).ok; } catch { /* Status only; no model task or authorization is created. */ }
  return { ...value, schedulerEnabled: z.object({ ready: z.boolean() }).parse(scheduler).ready, readiness: { modelReady, modelCount: models.length, localServices: health, orchestrator: process.env.STUDIO_ORCHESTRATOR ?? 'compose' } };
}
export async function contentPage(value: unknown) {
  const input = pageInputSchema.parse(value); const after = cursor(input.cursor);
  const items = z.array(contentItemSchema).parse(await dbRpc('studio_list_content', { p_workspace: await taskWorkspaceId(), p_kind: ['article', 'video'].includes(input.kind ?? '') ? input.kind : null,
    p_platform: input.platform ?? null, p_task: input.taskId ?? null, p_run: input.runId ?? null, p_status: input.status ?? null,
    p_before: after?.at ?? null, p_before_id: after?.id ?? null, p_limit: input.limit + 1, p_from: input.from ?? null, p_to: input.to ?? null }));
  return page<ContentItem>(items, input.limit);
}
export async function tasksPage(value: unknown) {
  const input = pageInputSchema.parse(value); const kind = ['content', 'discovery'].includes(input.kind ?? '') ? `&config->>kind=eq.${input.kind}` : '';
  const rows = z.array(z.unknown()).parse(await dbRequest(`studio_tasks?workspace_id=eq.${await taskWorkspaceId()}${kind}${beforeFilter(input)}&order=created_at.desc,id.desc&limit=${input.limit + 1}`));
  return page(rows.map(taskFromRow), input.limit);
}
export async function runsPage(value: unknown) {
  const input = pageInputSchema.parse(value);
  const filters = `${input.taskId ? `&task_id=eq.${input.taskId}` : ''}${input.runId ? `&id=eq.${input.runId}` : ''}${input.status ? `&status=eq.${input.status}` : ''}${['content', 'discovery'].includes(input.kind ?? '') ? `&task_snapshot->>kind=eq.${input.kind}` : ''}`;
  const rows = z.array(z.record(z.string(), z.unknown())).parse(await dbRequest(`studio_task_runs?workspace_id=eq.${await taskWorkspaceId()}${filters}${beforeFilter(input)}&select=id,task_id,slot,task_snapshot,status,phase,progress,attempt,error,warnings,questions,draft_id,started_at,finished_at,created_at,updated_at,guidance_version&order=created_at.desc,id.desc&limit=${input.limit + 1}`));
  return page(rows.map(row => publicTaskRun(runFromRow({ ...row, task_snapshot: { ...z.record(z.string(), z.unknown()).parse(row.task_snapshot), sources: [] }, sources: [], master: null, variants: [], output_paths: null }))), input.limit);
}
export function publicTaskRun(run: Awaited<ReturnType<typeof getTaskRun>>) {
  return { ...run, variants: run.variants.map(variant => ({ ...variant, mediaPaths: [] })),
    outputPaths: run.outputPaths ? { master: 'master.md', package: 'package.json', platforms: Object.fromEntries(run.variants.map(variant => [variant.platform, `${variant.platform}.md`])) } : null,
    phase: safeRuntimePhase(run.phase, run.status), error: safeRuntimeError(run.error), warnings: run.warnings.map(warning => safeRuntimeError(warning) ?? 'Execution requires review.') };
}
export async function articleDetail(id: string, revision?: number) {
  const result = z.object({draft:draftSchema,jobs:z.array(jobSchema)}).nullable().parse(await dbRpc('studio_article_detail',{p_workspace:await taskWorkspaceId(),p_id:z.uuid().parse(id)}));
  if (!result) throw new Error('Article not found.');
  const draft = revision ? await (await import('../core/artifacts.ts')).readDraftRevision(id, revision) : result.draft;
  return { draft: publicArticle(draft), jobs: result.jobs.map(publicArticleJob) };
}
export async function articleEditor(id: string) {
  const editor = await getEditor(id);
  return { ...editor, draft: publicArticle(editor.draft), history: editor.history.map(publicArticle), videos: [], operations: editor.operations.map(operation => publicArticleOperation(operation, editor.draft)) };
}
export function publicArticleOperation(operation: Awaited<ReturnType<typeof getEditor>>['operations'][number], draft?: Parameters<typeof publicArticle>[0]) {
  const expectedRevision = z.number().int().positive().safeParse(operation.input.expectedRevision);
  return { ...operation, input: expectedRevision.success ? { expectedRevision: expectedRevision.data } : {}, phase: safeRuntimePhase(operation.phase, operation.status), error: safeRuntimeError(operation.error), output: draft ? publicOperationOutput(operation.output, draft) : null };
}
function publicOperationOutput(value: unknown, draft: Parameters<typeof publicArticle>[0]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = z.record(z.string(), z.unknown()).parse(value);
  const metadata = z.object({ applied: z.boolean().optional(), conflicts: z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.(?:title|text|tags|format|launch))?$/u)).optional(), applying: z.boolean().optional() }).parse(record);
  if (record.proposal && typeof record.proposal === 'object') return { ...metadata, proposal: publicArticle({ ...draft, ...z.record(z.string(), z.unknown()).parse(record.proposal) }) };
  return metadata;
}
const taskCopySchema = z.object({ overrides: z.object(taskInputSchema.shape).partial().optional(), runNow: z.boolean().default(false), commandId: z.uuid().optional() });
export async function cloneRun(id: string, value: unknown) {
  const input = taskCopySchema.parse(value); const run = await getTaskRun(z.uuid().parse(id));
  const config = taskInputSchema.parse({ ...run.taskSnapshot, frequency: { type: 'once', time: '09:00', timezone: run.taskSnapshot.frequency.timezone }, enabled: false, delivery: undefined, ...input.overrides, sourceRunId: run.id });
  const task = await createTask(config, input.commandId);
  await dbRequest('studio_task_links?on_conflict=workspace_id,child_task_id',{method:'POST',prefer:'resolution=ignore-duplicates',body:{workspace_id:await taskWorkspaceId(),parent_task_id:run.taskId,parent_run_id:run.id,child_task_id:task.id,relation:'cloned_from'}});
  return { task, run: input.runNow ? await enqueueTaskRun(task.id, { requestId: input.commandId }) : null };
}
export async function createFromQuestion(value: unknown) {
  const input = taskCopySchema.extend({ runId: z.uuid(), questionIndex: z.number().int().min(0).max(19) }).parse(value);
  const run = await getTaskRun(input.runId); const question = run.questions[input.questionIndex];
  if (run.status !== 'succeeded' || run.taskSnapshot.kind !== 'discovery' || !question) throw new Error('Choose a question from a completed discovery.');
  const config: TaskInput = taskInputSchema.parse({ ...taskFromQuestion(question, run.taskSnapshot, run.sources, run.taskSnapshot.frequency.timezone), ...input.overrides, sourceRunId: run.id, topicOrigin: 'trend', kind: 'content' });
  const existing = z.array(z.object({child_task_id:z.uuid()})).parse(await dbRequest(`studio_task_links?workspace_id=eq.${await taskWorkspaceId()}&parent_run_id=eq.${run.id}&question_index=eq.${input.questionIndex}&relation=eq.question_derived&limit=1`))[0];
  const task = existing ? await (await import('../core/tasks.ts')).getTask(existing.child_task_id) : await createTask(config, input.commandId);
  await dbRequest('studio_task_links?on_conflict=workspace_id,child_task_id',{method:'POST',prefer:'resolution=ignore-duplicates',body:{workspace_id:await taskWorkspaceId(),parent_task_id:run.taskId,parent_run_id:run.id,child_task_id:task.id,relation:'question_derived',question_index:input.questionIndex}});
  return { task, run: input.runNow ? await enqueueTaskRun(task.id, { requestId: input.commandId }) : null };
}
export async function submitDeliveryBatch(value: unknown) {
  const input = z.object({ commandId: z.uuid().optional(), action: z.enum(['save_draft', 'publish']), items: z.array(z.object({ articleId: z.uuid(), expectedRevision: z.number().int().positive(), accountIds: z.array(z.uuid()).min(1).max(20) })).min(1).max(50) }).parse(value);
  const items: { articleId: string; accountId: string; status: 'accepted' | 'blocked' | 'failed'; jobId: string | null; error: string | null }[] = [];
  const { saveRemoteDrafts } = await import('../core/remote-drafts.ts'); const { publishDraft } = await import('../core/delivery.ts');
  for (const article of input.items) for (const accountId of new Set(article.accountIds)) {
    try {
      const jobs = input.action === 'save_draft' ? await saveRemoteDrafts(article.articleId, { expectedRevision: article.expectedRevision, accountIds: [accountId] }) : await publishDraft(article.articleId, { expectedRevision: article.expectedRevision, accountIds: [accountId] });
      items.push({ articleId: article.articleId, accountId, status: 'accepted', jobId: jobs[0]?.id ?? null, error: null });
    } catch (error) { items.push({ articleId: article.articleId, accountId, status: 'blocked', jobId: null, error: safeRuntimeError(error instanceof Error ? error.message : null) ?? 'This target needs attention.' }); }
  }
  return { batchId: input.commandId ?? randomUUID(), items };
}
