import { CapabilitiesPanel } from './capabilities-panel.tsx';
import { DraftConnections } from './draft-connections.tsx';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Link, Navigate, NavLink, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router';
import { type Account, type Platform, nativeUrls, platformIds } from '../core/model.ts';
import { type RunAction, labels, request, statusLabel } from './api.ts';
import { PageIntro } from './workspace-layout.tsx';
import { ActionNotice, useWorkspaceAction, useWorkspaceSummary, UnsavedChangesProvider } from './workspace-hooks.tsx';
import './style.css';

const TaskIndexPage = lazy(() => import('./task-workbench.tsx').then(module => ({default:module.TaskIndexPage})));
const TaskDetailPage = lazy(() => import('./task-workbench.tsx').then(module => ({default:module.TaskDetailPage})));
const TaskCreatePage = lazy(() => import('./task-wizard.tsx').then(module => ({default:module.TaskCreatePage})));
const PublishingPage = lazy(() => import('./publishing-page.tsx').then(module => ({default:module.PublishingPage})));
const LibraryPage = lazy(() => import('./library-page.tsx').then(module => ({default:module.LibraryPage})));
const LegacyTaskLink = lazy(() => import('./task-workbench.tsx').then(module => ({default:module.LegacyTaskLink})));
const HomePage = lazy(() => import('./home-page.tsx').then(module => ({ default: module.HomePage })));
const DiagnosticsPanel = lazy(() => import('./diagnostics-panel.tsx').then(module => ({ default: module.DiagnosticsPanel })));
const SetupPanel = lazy(() => import('./setup-panel.tsx').then(module => ({ default: module.SetupPanel })));
const ActivityPanel = lazy(() => import('./activity-panel.tsx').then(module => ({ default: module.ActivityPanel })));
const views = [['', '工作台', '⌂'], ['tasks', '任务中心', '▤'], ['publishing', '发布管理', '↗'], ['library', '资料库', '▧'], ['settings', '设置', '◇']] as const;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false }, mutations: { retry: false } } });

export function Studio() {
  const summary = useWorkspaceSummary(); const feedback = useWorkspaceAction(); const location = useLocation();
  return <div className="shell"><a className="skip-link" href="#main-content">跳到主要内容</a><aside className="sidebar"><Link className="brand" to="/" aria-label="Content Studio 首页"><img src="/content-studio.svg" alt="" width="38" height="38"/><span>Content<br/>Studio</span></Link><div className="workspace">个人内容工作台<span>从来源到文稿与发布</span></div><nav aria-label="主导航">{views.map(([path, label]) => <NavLink end={!path} className={({ isActive }) => isActive ? 'active' : ''} key={path} to={`/${path}`}><svg aria-hidden="true" viewBox="0 0 24 24"><path d={path === 'tasks' ? 'M4 5h16v15H4zM8 2v6M16 2v6M4 10h16M8 14h2M14 14h2' : path === 'publishing' ? 'M3 11 21 3l-7 18-3-8-8-2zM11 13l10-10' : path === 'library' ? 'M3 6h7l2 2h9v12H3zM3 6V4h7l2 2' : path === 'settings' ? 'M4 7h16M4 17h16M8 4v6M16 14v6' : 'M3 11 12 3l9 8M5 10v11h14V10M10 21v-7h4v7'}/></svg>{label}</NavLink>)}</nav><div className="phase"><span className="dot"/>本地工作区<p>所有内容、账号和任务从这里管理。</p><Link to="/settings/accounts">平台账号 →</Link><br/><Link to="/settings/setup">运行状态与配置 →</Link></div></aside><main id="main-content" tabIndex={-1}><header className="topbar"><span>创作工作台 / {views.find(([path]) => path ? location.pathname.startsWith(`/${path}`) : location.pathname === '/')?.[1] ?? '首页'}</span><div><span className="local"><i/>本地工作区</span><button className="quiet" disabled={summary.isFetching} onClick={() => void summary.refetch()}>{summary.isFetching ? '刷新中…' : '刷新状态'}</button></div></header><ActionNotice {...feedback}/>{summary.error ? <div role="alert" className="alert error">暂时无法读取工作区。<Link to="/settings/setup">检查运行配置</Link>后重试。</div> : null}<UnsavedChangesProvider><Suspense fallback={<p role="status">加载工作区…</p>}><Outlet/></Suspense></UnsavedChangesProvider><footer>Content Studio · 有来源的内容，清晰可核对的发布记录。</footer></main></div>;
}
function SettingsPage() {
  const summary = useWorkspaceSummary(); const feedback = useWorkspaceAction(); const navigate = useNavigate(); const location = useLocation(); const section = location.pathname.split('/')[2] ?? 'accounts';
  const onNavigate = (next: string) => navigate(({ tasks: '/tasks', library: '/library', queue: '/publishing', activity: '/settings/activity', accounts: '/settings/accounts', setup: '/settings/setup', research: '/settings/research', assets: '/settings/assets', knowledge: '/settings/knowledge', videos: '/videos' } as Record<string, string>)[next] ?? '/settings');
  return <><div className="settings-tabs">{[['accounts', '平台与账号'], ['setup', '运行配置'], ['diagnostics', '诊断日志'], ['activity', '高级检查'], ['research', '项目文档']].map(([id, label]) => <NavLink key={id} to={`/settings/${id}`}>{label}</NavLink>)}</div><ActionNotice {...feedback}/>{section === 'accounts' ? <AccountsPanel accounts={summary.data?.accounts ?? []} busy={feedback.busy} action={feedback.action}/> : section === 'diagnostics' ? <DiagnosticsPanel/> : section === 'setup' ? <SetupPanel busy={feedback.busy} action={feedback.action} onNavigate={onNavigate}/> : section === 'activity' ? <ActivityPanel busy={feedback.busy} action={feedback.action} onNavigate={onNavigate}/> : <ResearchPanel/>}</>;
}
function AccountsPanel({ accounts, busy, action }: { accounts: Account[]; busy: boolean; action: RunAction }) {
  const [apiAccess, setApiAccess] = useState<{ available: boolean; channelId?: string; error?: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); const [platform, setPlatform] = useState<Platform>('x'); const [label, setLabel] = useState(''); const [provider, setProvider] = useState<'native' | 'postiz'>('native'); const [integrationId, setIntegrationId] = useState(''); const [status, setStatus] = useState<Account['status']>('needs_login'); const [note, setNote] = useState(''); const [reddit, setReddit] = useState<Account['reddit']>(undefined); const [integrations, setIntegrations] = useState<{ id: string; name: string; identifier: string }[]>([]);
  const submit = (event: FormEvent) => { event.preventDefault(); void action(() => request(editingId ? `accounts/${editingId}` : 'accounts', { platform, label, provider, integrationId: provider === 'postiz' || platform === 'youtube' ? integrationId : '', status, note, ...(platform === 'reddit' && provider === 'postiz' && reddit ? { reddit } : {}), verifiedAt: status === 'connected' ? new Date().toISOString() : null }, editingId ? 'PUT' : 'POST'), '账号信息已保存。浏览器登录核验与官方 API 授权分别记录。'); };
  return <><PageIntro title="选择真正要发布的账号。" description="账号登录使用 Chrome profile radarxai@gmail.com。平台授权、身份验证和发布权限需要分别核验。"/><DraftConnections accounts={accounts} busy={busy} action={action}/><details className="panel"><summary>查看各平台支持能力与接入要求</summary><CapabilitiesPanel accounts={accounts} busy={busy} action={action}/></details><div className="accounts-layout"><div className="panel"><h2>{editingId ? '更新账号信息' : '登记平台账号'}</h2><form onSubmit={submit}><label>平台<select value={platform} onChange={event => setPlatform(event.target.value as Platform)}>{platformIds.map(id => <option key={id} value={id}>{labels[id]}</option>)}</select></label><label>账号名 / 用户名<input required value={label} onChange={event => setLabel(event.target.value)} placeholder="填写平台上实际可见的身份"/></label><label>发布路径<select value={provider} onChange={event => setProvider(event.target.value as 'native' | 'postiz')}><option value="native">平台原生流程 / 已授权的官方接口</option><option value="postiz">Postiz 接口 · X / LinkedIn / Reddit 文字</option></select></label>{(provider === 'postiz' || platform === 'youtube') && <label>{provider === 'postiz' ? 'Postiz integration ID' : 'YouTube channel ID · 已授权频道'}<input required={provider === 'postiz'} value={integrationId} onChange={event => setIntegrationId(event.target.value)} placeholder={provider === 'postiz' ? '填写连接标识' : 'UC…；可通过下方只读检查获取'}/></label>}{platform === 'youtube' && provider === 'native' && <section className="youtube-access-check"><button type="button" disabled={busy} onClick={() => void action(async () => { const result = await request<{ available: boolean; channelId?: string; error?: string }>('youtube/check', {}); setApiAccess(result); if (result.available && result.channelId) setIntegrationId(result.channelId); }, '已检查现有 YouTube API 授权状态。')}>检查现有 YouTube API 授权</button><p className="hint">浏览器已登录不等于 API 已授权。自动上传需要现有 OAuth 凭据可用，且频道 ID 与所选账号一致；此按钮不会创建新授权。</p>{apiAccess && <p className={apiAccess.available ? 'hint' : 'inline-error'} role="status">{apiAccess.available ? `官方接口核验通过 · 频道 ${apiAccess.channelId ?? '未返回 ID'}` : apiAccess.error || '当前官方 API 授权不可用，发布任务将提供人工操作步骤。'}</p>}</section>}{provider === 'postiz' && <section className="note-card"><button type="button" disabled={busy} onClick={() => void action(async () => { setIntegrations(await request<{ id: string; name: string; identifier: string }[]>('publishing/integrations')); }, '已查询 Postiz 连接列表。')}>查询已授权 Postiz 连接</button>{integrations.filter(item => item.identifier === platform || platform === 'linkedin' && item.identifier === 'linkedin-page').map(item => <button type="button" key={item.id} onClick={() => { setIntegrationId(item.id); setLabel(item.name); }}>{item.name} · {item.id}</button>)}<p className="hint">在 Docker 私有 application.env 配置 POSTIZ_API_KEY；此处不会索取或显示密钥。</p></section>}{platform === 'reddit' && provider === 'postiz' && <RedditSettings value={reddit} onChange={setReddit}/>}<label>登录与验证状态<select value={status} onChange={event => setStatus(event.target.value as Account['status'])}><option value="needs_login">需要登录</option><option value="blocked">验证 / 权限受阻</option><option value="connected">已在浏览器核对账号与发布入口</option></select></label><label>核验记录 / 阻塞项<textarea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="记录用户名、核验时间和待处理事项；不要填写密码、cookie 或 token。"/></label><button className="primary" disabled={busy}>{editingId ? '保存更新' : '登记账号'}</button>{editingId && <button type="button" className="text-button" onClick={() => { setEditingId(null); setLabel(''); setIntegrationId(''); setStatus('needs_login'); setNote(''); setReddit(undefined); setApiAccess(null); }}>登记另一个账号</button>}</form></div><div><div className="account-list">{accounts.map(account => <article className="panel account" key={account.id}><div><span className="eyebrow">{labels[account.platform]}</span><h3>{account.label}</h3></div><span className={`badge ${account.status === 'connected' ? 'green' : 'amber'}`}>{statusLabel(account.status)}</span><p>{account.note || '尚未记录核验证据。'}</p><small>{account.provider} · {account.verifiedAt ? new Date(account.verifiedAt).toLocaleString('zh-CN') : '尚未核验'}</small><a href={nativeUrls[account.platform]} target="_blank" rel="noreferrer">打开平台发布入口 ↗</a><button className="text-button" onClick={() => { setEditingId(account.id); setPlatform(account.platform); setLabel(account.label); setProvider(account.provider); setIntegrationId(account.integrationId); setStatus(account.status); setNote(account.note); setReddit(account.reddit); setApiAccess(null); }}>更新信息</button></article>)}</div><div className="note-card"><h3>在 Chrome 中完成账号验证</h3><p>手机号、二维码、验证码、身份或两步验证由你在平台内完成，再在这里记录核验结果。</p><a href="/api/docs/accounts" target="_blank" rel="noreferrer">各平台账号说明 ↗</a></div></div></div></>;
}
function RedditSettings({ value, onChange }: { value: Account['reddit']; onChange: (value: Account['reddit']) => void }) {
  const target = value ?? { subreddit: '', rulesUrl: '', approvalReference: '', rulesReviewedAt: new Date(0).toISOString(), flairRequired: false, flair: null };
  return <section className="note-card"><h3>Reddit 单一社区目标</h3><label>Subreddit 名称<input value={target.subreddit} onChange={event => onChange({ ...target, subreddit: event.target.value })} placeholder="不含 r/；必须是已核对的社区"/></label><label>该社区规则网址<input type="url" value={target.rulesUrl} onChange={event => onChange({ ...target, rulesUrl: event.target.value })}/></label><label>已获准 App 接入依据<input value={target.approvalReference} onChange={event => onChange({ ...target, approvalReference: event.target.value })} placeholder="审批记录编号 / 非敏感说明；不可填写密钥"/></label><p className="hint">此字段为操作人声明，不等于系统查询到平台审批。必须实际获准，且社区允许本次 AI / 推广内容。</p><label className="inline-check"><input type="checkbox" checked={target.flairRequired} onChange={event => onChange({ ...target, flairRequired: event.target.checked })}/>社区要求 flair</label>{target.flairRequired && <><label>Flair template ID<input value={target.flair?.id ?? ''} onChange={event => onChange({ ...target, flair: { id: event.target.value, name: target.flair?.name ?? '' } })}/></label><label>Flair 名称<input value={target.flair?.name ?? ''} onChange={event => onChange({ ...target, flair: { id: target.flair?.id ?? '', name: event.target.value } })}/></label></>}<p className="hint">规则核对时间：{new Date(target.rulesReviewedAt).toLocaleString('zh-CN')}；七天后需重新核对。</p><button type="button" onClick={() => onChange({ ...target, rulesReviewedAt: new Date().toISOString() })}>我已核对当前社区规则，更新记录</button></section>;
}
function ResearchPanel() {
  const current = [
    ['plugin-recovery-coding-spec-2026-10-21.zh-CN', '插件恢复与核对规格', '配对迁移、待核对记录、草稿回执同步和连接安全。'],
    ['workbench-coding-spec-2026-10-21.zh-CN', '工作流升级与技术规格', '任务、发布、插件更新和日志收集的实现契约与验收要求。'],
    ['competitor-architecture-ux-review-2026-10-21.zh-CN', '竞品与产品审查', '本轮竞品依据、架构审查和交互优化方案。'],
    ['accounts', '账号核验与待处理事项', '各平台当前接入状态、发布限制和下一步操作。'],
    ['acceptance', '验收记录', '区分本地验证、真实平台验收和持续运行观察。'],
  ] as const;
  const background = [
    ['local-system-delivery.zh-CN', '本地系统与使用说明', '启动方式、备份恢复和基础工作流。'],
    ['architecture', '技术架构', 'Supabase、持久任务、媒体和平台适配边界。'],
    ['publishing-capabilities-upgrade-2026-10-11.zh-CN', '平台能力历史调研', '2026-10-11 的能力与准入记录；当前状态以账号页为准。'],
    ['research-web-workflows-2026-10-10.zh-CN', '行业工作流历史调研', '2026-10-10 的来源发现、编辑和发布研究。'],
  ] as const;
  const cards = (items: ReadonlyArray<readonly [string, string, string]>) => <div className="research-grid">{items.map(([id,title,description]) => <a className="panel doc-card" key={id} href={`/api/docs/${id}`} target="_blank" rel="noreferrer"><span className="eyebrow">项目文档</span><h2>{title} ↗</h2><p>{description}</p></a>)}</div>;
  return <><PageIntro title="项目文档" description="查看当前技术规格、优化依据和验收边界。"/>{cards(current)}<details className="panel"><summary>基础说明与历史调研</summary>{cards(background)}</details><p className="hint">配置服务和调度请前往 <Link to="/settings/setup">运行配置</Link>；排查问题请查看 <Link to="/settings/diagnostics">诊断日志</Link>。</p></>;
}

const router = createBrowserRouter([{ path: '/', element: <Studio/>, children: [
  { index: true, element: <HomePage/> },
  { path: 'tasks', element: <TaskIndexPage/> },
  { path: 'tasks/new', element: <TaskCreatePage/> },
  { path: 'tasks/:kind/:id/:tab?', element: <TaskDetailPage/> },
  { path: 'publishing', element: <PublishingPage/> },
  { path: 'library', element: <LibraryPage/> },
  { path: 'discover', element: <LegacyTaskLink kind="discover"/> },
  { path: 'production', element: <LegacyTaskLink kind="production"/> },
  { path: 'distribution', element: <LegacyTaskLink kind="distribution"/> },
  { path: 'history', element: <LegacyTaskLink kind="history"/> },
  { path: 'content', element: <LegacyTaskLink kind="content"/> },
  { path: 'videos', element: <LegacyTaskLink kind="videos"/> },
  { path: 'settings/assets', element: <Navigate replace to="/library?tab=media"/> },
  { path: 'settings/knowledge', element: <Navigate replace to="/library?tab=knowledge"/> },
  { path: 'settings/*', element: <SettingsPage/> },
  { path: '*', element: <HomePage/> },
] }]);
const root = document.getElementById('root');
if (root) createRoot(root).render(<QueryClientProvider client={queryClient}><RouterProvider router={router}/></QueryClientProvider>);
