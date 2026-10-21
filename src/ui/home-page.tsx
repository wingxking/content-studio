import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { contentPageSchema, runPageSchema, type ContentItem, type WorkspaceSummary } from '../contracts/workspace.ts';
import type { PublishingCapability } from '../core/publishing-capabilities.ts';
import { readWorkspace } from '../client/workspace.ts';
import { labels, request, statusLabel } from './api.ts';
import { useWorkspaceSummary } from './workspace-hooks.tsx';
import { EmptyState, QueryError } from './workspace-layout.tsx';
import { createTaskHref } from './task-navigation.ts';

type StartStep = { title: string; description: string; to: string; action: string; complete: boolean };

/** Readiness comes from the current service and account capabilities, never a dismissed checklist. */
export function GettingStarted({ summary, hasContent }: { summary?: WorkspaceSummary; hasContent?: boolean }) {
  const modelReady = summary?.readiness.modelReady === true;
  const hasAccounts = Boolean(summary?.accounts.length);
  const steps: StartStep[] = [
    { title: '准备创作模型', description: modelReady ? '模型已就绪，可以开始生产内容。' : summary ? '完成模型连接后，即可研究来源并生成文稿。' : '正在检查创作环境…', to: '/settings/setup', action: modelReady ? '查看配置' : '完成配置', complete: modelReady },
    { title: '生产第一篇内容', description: hasContent ? '已有内容，继续查看平台稿或开始新的主题。' : '填写主题、选择平台，先立即运行一次。无需先连接发布账号。', to: hasContent ? '/tasks' : '/tasks/new', action: hasContent ? '查看内容' : '新建内容', complete: hasContent === true },
    { title: '选择发布方式', description: hasAccounts ? '已登记账号，请按各账号的实际能力保存草稿或发布。' : '连接目标平台可同步草稿；也可以先复制文稿，在平台手动发布。', to: '/settings/accounts', action: hasAccounts ? '检查平台能力' : '连接平台', complete: hasAccounts },
  ];
  return <section className="panel start-panel" aria-labelledby="start-heading"><div className="panel-heading"><h2 id="start-heading">开始使用</h2><span className="hint">配置 → 创作 → 检查与发布</span></div><ol className="start-steps">{steps.map((step, index) => <li key={step.title}><span className={`step-number ${step.complete ? 'done' : ''}`} aria-label={step.complete ? '已具备' : `第 ${index + 1} 步`}>{step.complete ? '✓' : index + 1}</span><div><h3>{step.title}</h3><p>{step.description}</p><Link to={step.to}>{step.action} →</Link></div></li>)}</ol></section>;
}

export function DeliveryOverview({ summary, capabilities, loading = false, error }: { summary?: WorkspaceSummary; capabilities?: PublishingCapability[]; loading?: boolean; error?: unknown }) {
  return <section className="panel" aria-labelledby="delivery-heading"><div className="panel-heading"><h2 id="delivery-heading">发布方式</h2><Link to="/settings/accounts">管理平台 →</Link></div><p className="home-copy">生成完成后，在任务的「发布」标签检查内容，再按目标账号的能力交付。</p>{error ? <p role="status" className="inline-error">暂时无法读取平台能力，请到平台设置重试。</p> : loading || !summary || !capabilities ? <p role="status">正在读取已连接平台…</p> : !summary.accounts.length ? <EmptyState title="可以先创作，再连接平台" description="尚未登记账号。生成内容仍可复制或导出。" to="/settings/accounts" action="连接第一个平台"/> : <ul className="home-channels">{summary.accounts.map(account => {
    const article = capabilities.find(item => item.accountId === account.id && item.kind === 'article');
    const video = capabilities.find(item => item.accountId === account.id && item.kind === 'video');
    const capability = account.platform === 'youtube' ? video : article;
    const automatic = capability?.automatic === true;
    const remoteDraft = capability?.remoteDraft || capability?.providerDraft;
    const route = automatic ? '系统提交' : remoteDraft ? '同步草稿，平台手动发布' : '复制内容，平台手动发布';
    return <li key={account.id}><div><strong>{labels[account.platform]} · {account.label}</strong><small>{account.platform === 'youtube' ? '视频' : '文章 / 文稿'} · {statusLabel(account.status)}</small></div><span className={`badge ${automatic ? 'green' : remoteDraft ? '' : 'amber'}`}>{route}</span></li>;
  })}</ul>}<p className="hint">「系统提交」表示交付通道可用；是否按时自动执行，还取决于任务授权、内容审阅与发布开关。保存平台草稿后仍需在平台确认发布。</p></section>;
}

function RecentContent({ items }: { items: ContentItem[] }) {
  return <div className="home-recent">{items.slice(0, 4).map(item => <Link key={`${item.kind}-${item.id}`} className="home-recent-item" to={item.kind === 'article' ? `/distribution?articleId=${item.id}` : `/videos?projectId=${item.id}`}><div><span className="eyebrow">{item.kind === 'article' ? '文章' : '视频'}</span><h3>{item.title}</h3><small>{item.platforms.map(platform => labels[platform]).join(' / ')}</small></div><span className="badge">{statusLabel(item.status)}</span></Link>)}</div>;
}

export function HomePage() {
  const summary = useWorkspaceSummary();
  const content = useQuery({ queryKey: ['workspace', 'content', ''], queryFn: ({ signal }) => readWorkspace('content', contentPageSchema, signal) });
  const runs = useQuery({ queryKey: ['workspace', 'runs', ''], queryFn: ({ signal }) => readWorkspace('runs', runPageSchema, signal), refetchInterval: query => query.state.data?.items.some(run => ['queued', 'researching', 'generating'].includes(run.status)) ? 4_000 : false });
  const capabilities = useQuery({ queryKey: ['workspace', 'capabilities'], queryFn: () => request<PublishingCapability[]>('publishing/capabilities') });
  const modelReady = summary.data?.readiness.modelReady === true;
  const hasContent = content.data ? content.data.items.length > 0 : undefined;
  return <><section className="home-hero"><div><span className="eyebrow">CONTENT STUDIO</span><h1>从一个主题，开始下一篇内容。</h1><p>研究可靠来源，生成各平台文稿，检查后保存草稿或发布。</p><div className="job-actions"><Link className="button primary" to={summary.data && !modelReady ? '/settings/setup' : createTaskHref('content')}>{summary.data && !modelReady ? '完成创作配置' : '新建内容'}</Link><Link className="button" to={createTaskHref('discovery')}>帮我找选题</Link><Link className="text-button" to={createTaskHref('video')}>制作视频 →</Link></div></div><div className="home-status" aria-label="当前运行状态"><div><span>定时生产</span><strong>{summary.data ? summary.data.schedulerEnabled ? '已启用' : '已暂停' : '读取中…'}</strong></div><div><span>公开发布</span><strong>{summary.data ? summary.data.paused ? '已暂停' : '已启用' : '读取中…'}</strong></div><p>{summary.data?.schedulerEnabled ? '仅已启用且到期的任务会运行。' : '暂停时仍可手动运行一次任务。'}生产与发布分别控制。</p><Link to="/settings/setup">管理运行开关 →</Link></div></section><GettingStarted summary={summary.data} hasContent={hasContent}/><div className="home-columns"><section className="panel"><div className="panel-heading"><h2>继续处理内容</h2><Link to="/tasks">全部内容 →</Link></div><QueryError error={content.error}/>{content.isPending ? <p role="status">加载最近内容…</p> : content.data?.items.length ? <RecentContent items={content.data.items}/> : content.isSuccess ? <EmptyState title="第一篇内容从这里开始" description="新建主题后，系统会研究来源、生成主稿与平台版本。" to={createTaskHref('content')} action="新建内容"/> : null}</section><DeliveryOverview summary={summary.data} capabilities={capabilities.data} loading={capabilities.isPending} error={capabilities.error}/></div><section className="panel home-runs"><div className="panel-heading"><h2>最近执行</h2><Link to="/tasks">全部执行记录 →</Link></div><QueryError error={runs.error}/>{runs.isPending ? <p role="status">加载执行记录…</p> : runs.data?.items.length ? <div className="home-recent">{runs.data.items.slice(0, 3).map(run => <Link className="home-recent-item" key={run.id} to={`/history?runId=${run.id}&taskId=${run.taskId}`}><div><h3>{run.taskSnapshot.title}</h3><small>{new Date(run.createdAt).toLocaleString('zh-CN')} · {run.progress}%</small></div><span className={`badge ${run.status === 'failed' ? 'red' : run.status === 'succeeded' ? 'green' : ''}`}>{statusLabel(run.status)}</span></Link>)}</div> : runs.isSuccess ? <p className="home-copy">运行第一篇内容或选题任务后，可在这里查看进度和结果。</p> : null}</section></>;
}
