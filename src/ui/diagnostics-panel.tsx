import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { diagnosticPageSchema } from "../contracts/diagnostics.ts";
import { errorMessage, request } from "./api.ts";
import { workspaceQuery } from "../client/workspace.ts";
import { PageIntro, QueryError } from "./workspace-layout.tsx";

const eventNames: Record<string,string> = { "api.started":"服务启动", "http.completed":"请求完成", "http.failed":"请求未完成", "worker.started":"执行器启动", "work.started":"开始执行", "work.completed":"执行完成", "work.failed":"执行需处理" };
type Observation = { status: string; message: string; nextAction: string; elapsedHours: number; samples: number; checkedAt: string | null; accepted: boolean };
const serviceNames: Record<string,string> = {api:"工作台",article:"文章执行",video:"视频执行",delivery:"交付执行",all:"通用执行"};
const levelNames: Record<string,string> = {info:"正常事件",warn:"需注意",error:"错误"};
export function ObservationControls({ status, busy, onStart, onStop }: {status?:string;busy:boolean;onStart:()=>void;onStop:()=>void}) {
  return <div className="job-actions">{status === "running" ? <button disabled={busy} onClick={onStop}>{busy ? "正在停止…" : "停止当前观察"}</button> : <button disabled={busy || !status} onClick={onStart}>{busy ? "正在启动…" : "开始新的观察窗口"}</button>}<small>每次启动建立新窗口，旧窗口的时长不会累计。</small></div>;
}
export function DiagnosticsPanel() {
  const [level,setLevel] = useState(""); const [service,setService] = useState(""); const [cursor,setCursor] = useState<string>();
  const observationLock = useRef(false);
  const [observationBusy,setObservationBusy] = useState(false);
  const [observationNotice,setObservationNotice] = useState("");
  const [observationError,setObservationError] = useState("");
  const suffix = workspaceQuery({level,service,cursor});
  const logs = useQuery({queryKey:["diagnostics",suffix],queryFn: async () => diagnosticPageSchema.parse(await request(`runtime/logs${suffix}`)),refetchInterval:cursor ? false : 10000});
  const observation = useQuery({queryKey:["runtime","observation"],queryFn: () => request<Observation>("runtime/observation"),refetchInterval:30000});
  const controlObservation = async (operation: "start" | "stop") => {
    if (observationLock.current) return;
    observationLock.current = true;
    setObservationBusy(true);setObservationNotice("");setObservationError("");
    try {
      const result = await request<{started?:boolean;stopped?:boolean}>(`runtime/observation/${operation}`, {});
      setObservationNotice(operation === "start" ? result.started ? "新的观察窗口已启动。" : "已有观察窗口，已刷新当前状态。" : result.stopped ? "当前观察已停止。" : "当前没有运行中的观察窗口。");
      await observation.refetch();
    } catch (error) {setObservationError(errorMessage(error));}
    finally {observationLock.current = false;setObservationBusy(false);}
  };
  return <><PageIntro title="运行诊断" description="按服务和级别查看本地收集的运行事件，定位需要处理的任务。"/>
    <section className="panel"><h2>持续运行观察</h2><QueryError error={observation.error}/>{observation.data ? <><p role="status">{observation.data.message}</p><p>{observation.data.nextAction}</p><small>已记录 {observation.data.samples} 次采样 · {observation.data.elapsedHours.toFixed(2)} 小时{observation.data.checkedAt ? ` · 最后采样 ${new Date(observation.data.checkedAt).toLocaleString("zh-CN")}` : ""}</small></> : <p>正在读取观察状态…</p>}<ObservationControls status={observation.error ? undefined : observation.data?.status} busy={observationBusy} onStart={() => void controlObservation("start")} onStop={() => void controlObservation("stop")}/>{observationNotice ? <p role="status">{observationNotice}</p> : null}{observationError ? <p role="alert">{observationError}</p> : null}</section>
    <section className="panel"><div className="panel-heading"><h2>运行日志</h2><button disabled={logs.isFetching} onClick={() => void logs.refetch()}>{logs.isFetching ? "刷新中…" : "刷新"}</button></div><div className="form-grid"><label>级别<select value={level} onChange={event => {setLevel(event.target.value);setCursor(undefined);}}><option value="">全部</option><option value="info">正常事件</option><option value="warn">需注意</option><option value="error">错误</option></select></label><label>服务<select value={service} onChange={event => {setService(event.target.value);setCursor(undefined);}}><option value="">全部</option>{["api","article","video","delivery","all"].map(value=><option key={value} value={value}>{serviceNames[value]}</option>)}</select></label></div><QueryError error={logs.error}/>
    {logs.isPending ? <p role="status">正在读取日志…</p> : null}
    {logs.data && !logs.data.items.length ? <p>当前筛选没有日志。服务更新后产生的事件会在这里显示。</p> : null}
    {logs.data?.invalidLines || logs.data?.unreadableFiles ? <p role="alert">部分日志不可读取：{logs.data.invalidLines} 条格式异常、{logs.data.unreadableFiles} 个文件不可用。</p> : null}
    <ol className="job-list">{logs.data?.items.map(item=><li className="note-card" key={item.id}><strong>{eventNames[item.event] ?? item.event}</strong> · {serviceNames[item.service] ?? item.service} · {levelNames[item.level] ?? item.level}<p>{new Date(item.at).toLocaleString("zh-CN")}{item.status ? ` · HTTP ${item.status}` : ""}{item.durationMs !== undefined ? ` · ${item.durationMs} ms` : ""}</p>{item.jobId ? <p>关联工作 <code>{item.jobId}</code></p> : null}{item.requestId ? <small>请求 <code>{item.requestId}</code></small> : null}{item.code ? <p>{item.code === "LEASE_LOST" ? "执行器失去租约；请检查运行状态，保留原任务等待恢复。" : "请在任务记录中检查具体原因；结果未知的交付先核验。"}</p> : null}</li>)}</ol>
    <div className="job-actions">{cursor ? <button onClick={()=>setCursor(undefined)}>返回最新</button> : null}{logs.data?.nextCursor ? <button onClick={()=>setCursor(logs.data!.nextCursor!)}>更早日志</button> : null}<a className="button" href={`/api/runtime/logs/export${workspaceQuery({level,service,cursor})}`} download>导出当前筛选（最多200条）</a></div><p className="hint">本地最多保留14天、32MiB，按较先达到的限制清理。只收集固定事件与关联ID，不收集正文、凭据、请求体或原始错误。</p></section></>;
}
