import { useEffect, useState } from 'react';
import type { Account } from '../core/model.ts';
import type { ContentKind, PublishingCapability } from '../core/publishing-capabilities.ts';
import { priorityPlatforms } from '../core/publishing-capabilities.ts';
import { errorMessage, labels, request, type RunAction } from './api.ts';

const stageLabels: Record<PublishingCapability['stage'], string> = { needs_account: '待登记账号', needs_login: '待登录', blocked: '接入受阻', manual: '原生流程 · 人工完成', ready: 'API 可用 · 提交前复核', unsupported: '当前未接入此格式' };
export function CapabilitiesPanel({ accounts, busy, action }: { accounts: Account[]; busy: boolean; action: RunAction }) {
  const [capabilities, setCapabilities] = useState<PublishingCapability[]>([]);
  const [kind, setKind] = useState<ContentKind>('article');
  const [error, setError] = useState('');
  useEffect(() => { let active = true; void request<PublishingCapability[]>('publishing/capabilities').then(value => { if (active) { setCapabilities(value); setError(''); } }).catch(caught => { if (active) setError(errorMessage(caught)); }); return () => { active = false; }; }, [accounts]);
  return <section className="panel capability-panel"><div className="panel-heading"><div><h2>逐账号发布能力</h2><p className="hint">浏览器登录、API 接入和最终发布分别核验；本地稿件不代表远端草稿已保存。</p></div><label>内容流水线<select value={kind} onChange={event => setKind(event.target.value as ContentKind)}><option value="article">文章 / 文字 / 产品上线</option><option value="video">独立视频</option></select></label></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="capability-grid">{capabilities.filter(item => item.kind === kind && priorityPlatforms.includes(item.platform as typeof priorityPlatforms[number])).map(item => <article className="note-card" key={`${item.platform}:${item.accountId ?? 'none'}`}><div className="panel-heading"><h3>{labels[item.platform]}</h3><span className={`badge ${item.automatic ? 'green' : 'amber'}`}>{stageLabels[item.stage]}</span></div><p>{accounts.find(account => account.id === item.accountId)?.label ?? '尚未绑定账号'} · {item.format}</p><p className="hint">{item.route} · 远端草稿：{item.remoteDraft ? '可自动保存' : '需原生编辑器操作'} · 自动提交：{item.automatic ? '支持，执行前重新检查' : '不可用'} · 结果：{item.canVerify ? '核对作品标识与链接' : '未接入'}</p><ul>{item.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul><a href={item.nativeUrl} target="_blank" rel="noreferrer">打开对应创作入口 ↗</a>{item.route === 'postiz_api' && item.accountId && <button disabled={busy} onClick={() => void action(() => request(`accounts/${item.accountId}/check`, {}), '已重新查询 Postiz 账号连接，发布许可仍需核对记录。')}>只读检查 API 连接</button>}<details><summary>操作步骤与依据</summary><ol>{item.steps.map(step => <li key={step}>{step}</li>)}</ol>{item.sources.map((source, index) => <p key={source}><a href={source} target="_blank" rel="noreferrer">依据 {index + 1} ↗</a></p>)}</details></article>)}</div></section>;
}
