import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { z } from 'zod';
import { request, errorMessage, type RunAction } from './api.ts';

const recoverySchema = z.object({ blocked:z.boolean(),invalid:z.boolean(),items:z.array(z.object({jobId:z.uuid(),title:z.string(),platform:z.string().nullable(),draftId:z.uuid().nullable(),status:z.string().nullable(),canSync:z.boolean(),reason:z.string()})) });
export function DraftRecoveryPanel({ enabled, extensionId, busy, action }: {enabled:boolean;extensionId:string|null;busy:boolean;action:RunAction}) {
  const recovery = useQuery({queryKey:['draft-journal-recovery',extensionId],enabled,queryFn:async()=>recoverySchema.parse(await request('publishing/draft-connectors/pending')),refetchInterval:enabled ? 15000 : false});
  if (!enabled) return null;
  return <section className="note-card" aria-label="插件待核对记录"><div className="panel-heading"><h3>插件执行记录</h3><button disabled={busy || recovery.isFetching} onClick={()=>void recovery.refetch()}>刷新记录</button></div>
    {recovery.error ? <p role="alert">{errorMessage(recovery.error)}</p> : null}
    {recovery.data ? <><p role="status">{recovery.data.blocked ? '草稿写入已暂停。先核对以下原始结果，再同步已确认的回执。' : '插件没有待核对记录，可以继续已授权的草稿任务。'}</p>{recovery.data.invalid ? <p role="alert">执行记录格式异常，已保留原文件。请恢复经过验证的记录；不要清空记录或重新发送草稿。</p> : null}
    {recovery.data.items.length ? <details open={recovery.data.items.length<=5}><summary>{recovery.data.items.length} 条记录需要核对</summary>{recovery.data.items.map(item=><article className="note-card" key={item.jobId}><h4>{item.title}</h4><p>{item.reason}</p><small>原任务：<code>{item.jobId}</code></small><div className="job-actions">{item.draftId ? <Link className="button" to={`/tasks/article/${item.draftId}/publish?job=${item.jobId}`}>打开原任务核对</Link> : null}{item.canSync ? <button disabled={busy || recovery.isFetching} onClick={()=>void action(async()=>{await request(`jobs/${item.jobId}/draft-receipt/sync`,{});await recovery.refetch();},'已同步核对回执；没有再次发送草稿。')}>同步已核对回执</button> : null}</div></article>)}</details> : null}</> : !recovery.error ? <p>正在读取插件记录…</p> : null}
    <p className="hint">同步只更新插件执行记录。更换连接、扩展 ID 或工作区不会自动删除未知结果，也不会授权重新发送。</p>
  </section>;
}
