import { useState } from 'react';
import type { RuntimeAction, RuntimeSetup } from '../core/runtime-overview.ts';
import { request, type RunAction } from './api.ts';
import { useRuntimePolling } from './runtime-polling.ts';

export type RuntimePanelProps = { busy: boolean; action: RunAction; onNavigate: (view: string) => void };
const stepStatus = { ready: '连接检查通过', action_required: '需要操作', blocked: '当前受阻' } as const;
export function SetupPanel({ busy, action, onNavigate }: RuntimePanelProps) {
  const [revision, setRevision] = useState(0); const { data, error, loading } = useRuntimePolling<RuntimeSetup>('runtime/setup', revision);
  const perform = (item: RuntimeAction) => {
    if (item.view) { onNavigate(item.view); return; }
    if (item.endpoint) { const endpoint = item.endpoint; void action(() => request(endpoint, item.body ?? {}), '配置检查已更新，请核对当前状态。'); }
  };
  return <><section className="intro"><span className="eyebrow">LOCAL SETUP</span><h1>检查现有 Docker 工作区，逐项完成配置。</h1><p>本向导检查已有实例，提供受控的配置与核验入口。完整运行、真实发布和本地验收需要各自的执行证据。</p></section><section className="panel"><div className="panel-heading"><h2>配置进度</h2><button disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>重新检查</button></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}{loading && !data ? <p role="status">正在检查本地服务与配置…</p> : null}{data ? <><p className="hint">检查时间：{new Date(data.checkedAt).toLocaleString('zh-CN')} · 当前运行：{data.runtime} · 阶段二等待本地验收</p><ol className="job-list">{data.steps.map(step => <li className="note-card" key={step.id}><div className="panel-heading"><h3>{step.title}</h3><span className={`badge ${step.status === 'ready' ? 'green' : 'amber'}`}>{stepStatus[step.status]}</span></div><p>{step.detail}</p><div className="job-actions">{step.actions.map((item, index) => item.href ? <a key={index} href={item.href} target="_blank" rel="noreferrer">{item.label} ↗</a> : <button key={index} disabled={busy} onClick={() => perform(item)}>{item.label}</button>)}</div></li>)}</ol></> : null}</section></>;
}
