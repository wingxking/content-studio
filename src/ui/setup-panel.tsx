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
  const changeSwitch = (endpoint: string, body: Record<string, unknown>, message: string) => { void action(async () => { await request(endpoint, body); setRevision(value => value + 1); }, message); };
  const required = data?.steps.filter(step => !step.optional) ?? [];
  const optional = data?.steps.filter(step => step.optional) ?? [];
  return <><section className="intro"><h1>工作台配置</h1><p>先完成创作必需的服务和模型连接。平台发布、知识库和验收可在需要时继续配置。</p></section><RuntimeSwitches schedulerEnabled={error ? null : data?.schedulerEnabled ?? null} publishingPaused={error ? null : data?.publishingPaused ?? null} busy={busy || loading} onScheduler={enabled => changeSwitch('runtime/scheduler', { enabled }, enabled ? '定时生产已启用，已启用的任务会按计划执行。' : '定时生产已暂停，仍可手动运行任务。')} onPublishing={paused => changeSwitch('pause', { paused }, paused ? '公开发布已暂停。' : '公开发布已恢复，已批准且到期的交付会继续执行。')}/><section className="panel"><div className="panel-heading"><h2>开始创作所需配置</h2><button disabled={busy || loading} onClick={() => setRevision(value => value + 1)}>重新检查</button></div>{error ? <p className="inline-error" role="alert">{error}</p> : null}{loading && !data ? <p role="status">正在检查服务与模型连接…</p> : null}{data ? <><p className="setup-progress">{required.filter(step => step.status === 'ready').length} / {required.length} 项必需配置检查通过。{required.every(step => step.status === 'ready') ? <button type="button" className="text-button" onClick={() => onNavigate('tasks')}>开始创作 →</button> : '请先处理标有“需要操作”或“当前受阻”的项目。'}</p><SetupChecklist steps={required} busy={busy} perform={perform}/><details className="setup-optional"><summary>平台发布、知识库与更多选项 · {optional.length} 项</summary><p className="home-copy">这些选项按使用需要配置；没有发布账号也可以先生成、复制和导出内容。</p><SetupChecklist steps={optional} busy={busy} perform={perform}/></details><details><summary>查看运行检查信息</summary><ReleaseDetails release={data.release}/><p className="hint">检查时间：{new Date(data.checkedAt).toLocaleString('zh-CN')} · 当前运行：{data.runtime}</p></details></> : null}</section></>;
}
export function RuntimeSwitches({ schedulerEnabled, publishingPaused, busy, onScheduler, onPublishing }: { schedulerEnabled: boolean | null; publishingPaused: boolean | null; busy: boolean; onScheduler: (enabled: boolean) => void; onPublishing: (paused: boolean) => void }) {
  return <section className="panel runtime-switches" aria-labelledby="runtime-controls"><h2 id="runtime-controls">运行开关</h2><div className="runtime-switch-grid"><section aria-label="定时生产"><div><h3>定时生产</h3><span className={`badge ${schedulerEnabled === true ? 'green' : 'amber'}`}>{schedulerEnabled === null ? '状态未知' : schedulerEnabled ? '已启用' : '已暂停'}</span></div><p>启用后，已开启的任务会按各自计划生产内容。暂停时仍可手动运行一次。</p><button type="button" disabled={busy || schedulerEnabled === null} onClick={() => { if (schedulerEnabled !== null) onScheduler(!schedulerEnabled); }}>{schedulerEnabled === null ? '等待生产状态检查' : schedulerEnabled ? '暂停定时生产' : '启用定时生产'}</button></section><section aria-label="公开发布"><div><h3>公开发布</h3><span className={`badge ${publishingPaused === false ? 'green' : 'amber'}`}>{publishingPaused === null ? '状态未知' : publishingPaused ? '已暂停' : '已启用'}</span></div><p>恢复后，已批准且到期的交付会继续执行。生产任务与平台草稿不会因此自动获得公开发布授权。</p><button type="button" disabled={busy || publishingPaused === null} onClick={() => { if (publishingPaused !== null) onPublishing(!publishingPaused); }}>{publishingPaused === null ? '等待发布状态检查' : publishingPaused ? '恢复公开发布' : '暂停公开发布'}</button></section></div></section>;
}
function SetupChecklist({ steps, busy, perform }: { steps: RuntimeSetup['steps']; busy: boolean; perform: (item: RuntimeAction) => void }) {
  return <ol className="job-list">{steps.map(step => <li className="note-card" key={step.id}><div className="panel-heading"><h3>{step.title}</h3><span className={`badge ${step.status === 'ready' ? 'green' : 'amber'}`}>{stepStatus[step.status]}</span></div><p>{step.detail}</p><div className="job-actions">{step.actions.map((item, index) => item.href ? <a key={index} href={item.href} target="_blank" rel="noreferrer">{item.label} ↗</a> : <button key={index} disabled={busy} onClick={() => perform(item)}>{item.label}</button>)}</div></li>)}</ol>;
}

export function ReleaseDetails({ release }: { release?: { version: string; builtAt: string; sourceDigest: string } | null }) {
  return release ? <dl className="release-details"><dt>运行版本</dt><dd>{release.version}</dd><dt>构建时间（新加坡）</dt><dd>{new Date(release.builtAt).toLocaleString('zh-CN', { timeZone: 'Asia/Singapore' })}</dd><dt>源码指纹</dt><dd><code title={release.sourceDigest}>{release.sourceDigest.slice(0, 12)}</code></dd></dl> : <p className="hint">当前运行版本信息暂不可用。</p>;
}
