import { platformIds, type Job } from './model.ts';
import type { PublishingCapability } from './publishing-capabilities.ts';
import type { RuntimeRelease } from '../contracts/runtime-release.ts';

export type RuntimeAction = { label: string; view?: string; endpoint?: string; body?: Record<string, unknown>; href?: string };
export type SetupStep = { id: string; title: string; status: 'ready' | 'action_required' | 'blocked'; detail: string; actions: RuntimeAction[]; optional?: boolean };
export type RuntimeSetup = { checkedAt: string; scope: 'existing_instance'; runtime: 'docker' | 'migration-native' | 'unknown'; publishingPaused: boolean | null; schedulerEnabled: boolean | null; acceptance: 'requires_evidence'; steps: SetupStep[]; release?: RuntimeRelease | null };
export type KnowledgeSummary = { configured: boolean; available: boolean; importedSources: number; mountFiles: number };
type SetupInput = { readiness: Record<string, unknown> | null; state: { paused: boolean; accounts: { status: string }[] } | null; bridge: { configured: boolean; connected: boolean } | null; knowledge: KnowledgeSummary | null; capabilities: PublishingCapability[] };
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const docs = (id: string, label: string): RuntimeAction => ({ label, href: `/api/docs/${id}` });
export function summarizeRuntimeSetup(input: SetupInput, checkedAt = new Date().toISOString()): RuntimeSetup {
  const ready = input.readiness ?? {}; const health = record(ready.localServices); const runner = record(ready.modelRunner);
  const runtime = ready.runtime === 'docker' ? 'docker' : ready.runtime === 'migration-native' ? 'migration-native' : 'unknown';
  const databaseReady = ready.database === 'supabase' && ready.stateReadable === true && health.database === true && health.pgmq === true && health.pg_cron === true;
  const modelReady = ready.codexAvailable === true && runner.ready === true;
  const modelCount = typeof ready.modelCount === 'number' ? ready.modelCount : 0;
  const scheduler = record(ready.scheduler);
  const schedulerJobs = Array.isArray(scheduler.jobs) ? scheduler.jobs.map(record) : [];
  const requiredSchedulerJobs = ['content-studio-task-dispatcher', 'content-studio-adaptation-repair'].map(name => schedulerJobs.filter(job => job.name === name));
  const schedulerFlags = requiredSchedulerJobs.map(jobs => jobs.length === 1 && typeof jobs[0]?.enabled === 'boolean' ? jobs[0].enabled : null);
  const schedulerEnabled = schedulerFlags.every(flag => flag === true) ? true : schedulerFlags.every(flag => flag === false) ? false : null;
  const automatic = input.capabilities.filter(item => item.automatic).length;
  const connectedAccounts = input.state?.accounts.filter(item => item.status === 'connected').length ?? 0;
  return { checkedAt, scope: 'existing_instance', runtime, acceptance: 'requires_evidence', publishingPaused: input.state?.paused ?? null, schedulerEnabled, steps: [
    { id: 'docker', title: 'Docker 本地运行', status: runtime === 'docker' ? 'ready' : 'blocked', detail: runtime === 'docker' ? '当前 API 在 Docker 中运行；完整服务与迁移验收请查运行记录。' : '需要使用已有的 Docker 实例启动应用。此向导不执行全新安装。', actions: [docs('docker-runtime', 'Docker 启动与恢复说明')] },
    { id: 'database', title: 'Supabase 与持久队列', status: databaseReady ? 'ready' : 'blocked', detail: databaseReady ? '工作区可读取，Supabase、pgmq 与 pg_cron 检查通过。' : '无法确认持久工作区和队列健康；先检查 Docker 服务与迁移。', actions: [docs('docker-runtime', '检查服务与迁移')] },
    { id: 'localfs', title: '本地素材目录', status: ready.localfsWritable === true && ready.storage === 'localfs' ? 'ready' : 'blocked', detail: ready.localfsWritable === true && ready.storage === 'localfs' ? 'LocalFS 素材目录可写；备份恢复与素材哈希验收单独记录。' : 'LocalFS 素材目录不可写或诊断不可用，请检查私有 bind 目录。', actions: [docs('docker-runtime', '数据目录与备份说明')] },
    { id: 'model', title: '模型授权与目录', status: modelReady && modelCount > 0 ? 'ready' : 'action_required', detail: `${modelReady ? '模型执行器登录检查通过' : '模型执行器需要登录或恢复连接'}；目录显示 ${modelCount} 个模型。目录缓存不证明当前授权或模型任务成功。`, actions: [{ label: '刷新已授权模型目录', endpoint: 'models/refresh', body: {} }, docs('docker-runtime', 'Docker 模型登录说明'), { label: '创建实际模型验证任务', view: 'tasks' }] },
    { id: 'knowledge', title: '知识资料与只读挂载', optional: true, status: input.knowledge && (input.knowledge.importedSources > 0 || input.knowledge.available) ? 'ready' : 'action_required', detail: input.knowledge ? `已导入 ${input.knowledge.importedSources} 份资料${input.knowledge.importedSources ? '，已有资料可继续用于创作' : ''}；${input.knowledge.available ? `只读挂载可访问，发现 ${input.knowledge.mountFiles} 个候选文件` : input.knowledge.configured ? '只读挂载当前不可访问，可检查目录或直接上传资料' : '可直接上传资料，只读挂载为可选配置'}。导入前请移除敏感数据。` : '知识资料诊断不可用；可先使用公开来源创作，稍后检查资料库。', actions: [{ label: '上传或管理知识资料', view: 'knowledge' }, docs('docker-runtime', '配置可选知识目录')] },
    { id: 'accounts', title: '账号与草稿连接', optional: true, status: connectedAccounts > 0 ? 'ready' : 'action_required', detail: `已登记 ${connectedAccounts} 个 connected 账号；草稿扩展${input.bridge?.connected ? '当前可连接' : input.bridge?.configured ? '已配置，等待连接' : '尚未配置'}。账号登录、草稿权限和真实发布验收分别核对；生成和导出内容无需先绑定账号。`, actions: [{ label: '配置并核对账号', view: 'accounts' }, docs('accounts', '账号阻塞与操作说明')] },
    { id: 'delivery', title: '发布接入与运行开关', optional: true, status: 'action_required', detail: `能力配置记录有 ${automatic} 条自动提交路径；使用前还需核验目标平台授权，账号记录不能代替当前 API 检查。Postiz ${ready.postizConfigured === true ? '已配置' : '尚未配置'}。定时创作${schedulerEnabled === null ? '状态未知，请检查调度服务' : schedulerEnabled ? '已启用' : '已暂停'}，自动发布${input.state ? input.state.paused ? '已暂停' : '运行中' : '状态未知'}。开关保持现状。`, actions: [{ label: '查看队列与核验记录', view: 'queue' }, { label: '查看账号能力', view: 'accounts' }] },
    { id: 'acceptance', title: '本地验收与阶段门槛', optional: true, status: 'action_required', detail: '连接检查不能替代真实生成、备份恢复、错误恢复与逐平台发布验收。48 小时稳定运行等剩余门槛以验收记录为准；阶段二仍受本地验收约束。', actions: [docs('acceptance', '查看已执行验收与剩余门槛')] },
  ] };
}

export type ActivityItem = { id: string; kind: 'task_run' | 'operation' | 'video_render' | 'article_delivery' | 'video_delivery'; label: string; status: string; phase: string; progress: number | null; attempt: number | null; updatedAt: string; error: string | null; parentId: string | null; subjectId: string | null; actions: RuntimeAction[]; verificationCheck?: NonNullable<Job['verificationCheck']> };
export type RuntimeActivity = { checkedAt: string; publishingPaused: boolean | null; items: ActivityItem[]; warnings: string[]; limit: number };
export type RunSummary = { id: string; task_id: string; draft_id: string | null; status: string; phase: string; progress: number; attempt: number; updated_at: string; error: string | null };
export type OperationSummary = { id: string; draft_id: string | null; subject_kind: 'article' | 'video'; subject_id: string | null; kind: string; status: string; phase: string; updated_at: string; error: string | null; job_id: string | null; recovery_action?: string | null };
export type RenderSummary = { id: string; projectId: string; operationId?: string; status: string; phase: string; attempt: number; heartbeatAt: string; finishedAt: string | null; error: string | null };
const operationLabels: Record<string, string> = { article_export: '文章导出', sync: '适配稿同步', refine: '内容调优', video_script: '脚本生成', video_render: '渲染', publish: '发布处理', delivery_recovery: '交付恢复与核验', collect_metrics: '指标采集' };
export function safeRuntimeError(error: unknown): string | null {
  if (!error) return null;
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (/reconcil|unknown|uncertain|ambiguous/iu.test(message)) return '外部结果尚未确认，请核验原任务。';
  if (/auth|login|permission|credential|token|grant|sign.in|授权|权限/iu.test(message)) return '授权或权限需要核对，请查看配置与账号说明。';
  if (/revision|approval|changed|stale/iu.test(message)) return '内容版本或批准状态已变化，请在原工作区复核。';
  if (/supabase|database|connect|timeout|unavailable|network|远端状态查询/iu.test(message)) return '服务连接或执行暂不可用，请检查 Docker 运行状态。';
  return '此项需要处理；在原工作区查看安全诊断与恢复步骤。';
}
export function safeRuntimePhase(phase: string, status: string): string {
  if (/^(queued|researching|sources_saved|questions_saved|generating_master|master_saved|saving_draft|completed|failed|cancelled)$/u.test(phase) || platformIds.some(platform => phase === `adapting_${platform}` || phase === `${platform}_saved`)) return phase;
  if (/render|caption|tts|audio|narrat/iu.test(phase)) return '视频渲染与音画处理';
  if (/draft|saving/iu.test(phase)) return '保存资料或远端草稿';
  if (/adapt|sync/iu.test(phase)) return '平台版本同步';
  if (/publish|submit/iu.test(phase)) return '平台提交';
  if (/recover|reconcil|verify|checked/iu.test(phase)) return '检查或恢复原任务';
  return status;
}
export function summarizeRuntimeActivity(input: { runs: RunSummary[]; operations: OperationSummary[]; renders: RenderSummary[]; jobs: Job[]; paused: boolean | null; warnings?: string[]; promotions?: { childRunId: string; parentRunId: string }[] }, checkedAt = new Date().toISOString()): RuntimeActivity {
  const latestRunsByDraft = new Map<string, RunSummary>();
  for (const run of input.runs) if (run.draft_id) {
    const previous = latestRunsByDraft.get(run.draft_id);
    if (!previous || Date.parse(run.updated_at) > Date.parse(previous.updated_at)) latestRunsByDraft.set(run.draft_id, run);
  }
  const runForDraft = (draftId: string | null): string | undefined => draftId ? latestRunsByDraft.get(draftId)?.id : undefined;
  const parents = new Map(input.promotions?.map(item => [item.childRunId, item.parentRunId]));
  const items: ActivityItem[] = input.runs.map(run => ({ id: run.id, kind: 'task_run', label: '研究与创作任务', status: run.status, phase: safeRuntimePhase(run.phase, run.status), progress: run.progress, attempt: run.attempt, updatedAt: run.updated_at, error: safeRuntimeError(run.error), parentId: parents.get(run.id) ?? run.task_id, subjectId: run.draft_id, actions: [{ label: '查看任务与已有成果', view: 'tasks' }, ...(['failed', 'cancelled'].includes(run.status) ? [{ label: '继续原任务', endpoint: `runs/${run.id}/retry`, body: {} }] : [])] }));
  for (const operation of input.operations) items.push({ id: operation.id, kind: 'operation', label: operation.recovery_action === 'verify_channel' ? 'YouTube · 账号授权核验' : `${operation.subject_kind === 'video' ? '视频' : '文章'} · ${operationLabels[operation.kind] ?? '操作'}`, status: operation.status, phase: safeRuntimePhase(operation.phase, operation.status), progress: null, attempt: null, updatedAt: operation.updated_at, error: operation.recovery_action === 'verify_channel' && operation.error ? '官方频道核验未通过，请检查平台账号授权与服务连接。' : safeRuntimeError(operation.error), parentId: operation.job_id ?? runForDraft(operation.draft_id) ?? null, subjectId: operation.subject_id ?? operation.draft_id, actions: [{ label: '查看原工作区', view: operation.recovery_action === 'verify_channel' ? 'accounts' : ['delivery_recovery', 'collect_metrics'].includes(operation.kind) ? 'queue' : operation.subject_kind === 'video' ? 'videos' : 'library' }] });
  for (const render of input.renders) items.push({ id: render.id, kind: 'video_render', label: '独立视频渲染', status: render.status, phase: safeRuntimePhase(render.phase, render.status), progress: null, attempt: render.attempt, updatedAt: render.finishedAt ?? render.heartbeatAt, error: safeRuntimeError(render.error), parentId: render.operationId ?? render.projectId, subjectId: render.projectId, actions: [{ label: '查看渲染与版本', view: 'videos' }] });
  for (const job of input.jobs) {
    const video = job.subject?.kind === 'video'; const reconcile = ['needs_reconciliation', 'queued', 'submitting', 'delivered'].includes(job.status) || Boolean(job.remoteId || job.providerPostId || job.remoteUrl) || job.deliveryAction === 'save_draft' && job.attempts > 0;
    const actions: RuntimeAction[] = [{ label: reconcile ? '核对原提交记录' : '查看发布记录', view: 'queue' }];
    // Recovery invokes the existing same-job guard; unknown outcomes never expose a submit action.
    if (job.deliveryAction !== 'save_draft' && job.provider === 'postiz' && (['queued', 'needs_reconciliation'].includes(job.status) || job.status === 'failed' && Boolean(job.providerPostId))) actions.push({ label: '核验已有提交', endpoint: `jobs/${job.id}/reconcile`, body: {} });
    else if (reconcile && job.platform === 'youtube' && job.provider === 'native' && job.deliveryAction !== 'save_draft') actions.push({ label: '核验已有提交', endpoint: `jobs/${job.id}/continue`, body: {} });
    else if (!reconcile && job.status === 'failed') actions.push({ label: '继续原发布任务', endpoint: `jobs/${job.id}/continue`, body: {} });
    items.push({ id: job.id, kind: video ? 'video_delivery' : 'article_delivery', label: `${video ? '视频' : '文章'} · ${job.platform} · ${job.deliveryAction === 'save_draft' ? '保存远端草稿' : '发布'}`, status: job.status, phase: job.status, progress: null, attempt: job.attempts, updatedAt: job.history.at(-1)?.at ?? job.createdAt, error: safeRuntimeError(job.error), ...(job.verificationCheck ? { verificationCheck: { ...job.verificationCheck, lastError: safeRuntimeError(job.verificationCheck.lastError) } } : {}), parentId: video ? job.subject?.id ?? null : runForDraft(job.draftId) ?? job.draftId, subjectId: job.subject?.id ?? job.draftId, actions });
  }
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { checkedAt, publishingPaused: input.paused, items: items.slice(0, 300), warnings: input.warnings ?? [], limit: 300 };
}
