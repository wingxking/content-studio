import { deliveryCalendarSchema } from "../contracts/delivery-calendar.ts";
import { taskContentHref } from "./task-navigation.ts";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { deliveryPageSchema } from "../contracts/workbench.ts";
import { deliveryLabel } from "../contracts/studio-ui.ts";
import { readWorkspace, workspaceQuery } from "../client/workspace.ts";
import { useWorkspaceSummary } from "./workspace-hooks.tsx";
import { labels } from "./api.ts";
import { EmptyState, PageIntro, QueryError } from "./workspace-layout.tsx";
import { publishingCalendarSelection } from "./publishing-calendar-state.ts";

export function PublishingPage() {
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view = ["pending", "calendar", "drafts", "history"].includes(requestedView ?? "") ? requestedView! : "pending";
  const summary = useWorkspaceSummary();
  const { month: validMonth, day, days, leading } = publishingCalendarSelection(params.get("month"), params.get("day"));
  const suffix = workspaceQuery(view === "calendar" ? { month: validMonth, day, timezone: "Asia/Singapore", cursor: params.get("cursor") ?? undefined } : { view, cursor: params.get("cursor") ?? undefined });
  const calendar = useQuery({ queryKey: ["workspace", "delivery-calendar", validMonth], queryFn: ({signal}) => readWorkspace(`delivery-calendar${workspaceQuery({month:validMonth,timezone:"Asia/Singapore"})}`,deliveryCalendarSchema,signal), enabled: view === "calendar", refetchInterval: 15000 });
  const query = useQuery({
    queryKey: ["workspace", "deliveries", suffix],
    queryFn: ({ signal }) =>
      readWorkspace(`${view === "calendar" ? "delivery-calendar/day" : "deliveries"}${suffix}`, deliveryPageSchema, signal),
    refetchInterval: (result) =>
      result.state.data?.items.some((item) =>
        ["scheduled", "submitting", "queued"].includes(item.status),
      )
        ? 4000
        : false,
    refetchOnWindowFocus: true,
  });
  const change = (key: string, value: string) =>
    setParams((current) => {
      current.delete("cursor");
      current.set(key, value);
      return current;
    });
  const rows = query.data?.items ?? [];
  const accountName = (id: string) => {
    const account = summary.data?.accounts.find((account) => account.id === id);
    return account
      ? `${labels[account.platform]} · ${account.label}`
      : "历史账号";
  };
  return (
    <>
      <PageIntro
        title="发布管理"
        description="跨任务查看交付待办、平台草稿、发布日历与历史。打开记录后回到所属任务处理。"
      />
      <nav className="task-tabs" aria-label="发布视图">
        {[
          { id: "pending", label: "待处理" },
          { id: "calendar", label: "发布日历" },
          { id: "drafts", label: "平台草稿" },
          { id: "history", label: "发布历史" },
        ].map((item) => (
          <button
            className={view === item.id ? "active" : ""}
            aria-pressed={view === item.id}
            key={item.id}
            onClick={() => change("view", item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <QueryError error={query.error ?? calendar.error} />
      {query.isPending ? <p role="status">正在读取交付记录…</p> : null}
      {view === "calendar" ? (
        <>
          <label>
            月份 · 新加坡时间 UTC+8
            <input
              type="month"
              value={validMonth}
              onChange={(event) => change("month", event.target.value)}
            />
          </label>
          <p className="hint">
            日历汇总整月已有交付（包括人工待办），不受列表分页影响。生产时间在任务计划中查看。
          </p>
          <div className="publishing-calendar">
            {["日", "一", "二", "三", "四", "五", "六"].map((day) => (
              <strong key={day}>周{day}</strong>
            ))}
            {Array.from({ length: leading }, (_, index) => (
              <div key={`empty:${index}`} />
            ))}
            {Array.from({ length: days }, (_, index) => {
              const date = `${validMonth}-${String(index + 1).padStart(2, "0")}`;
              return (
                <section key={date}>
                  <strong>{index + 1}</strong>
                  <button className={day === date ? "primary" : "quiet"} aria-pressed={day === date} onClick={() => change("day", date)} aria-label={`查看${date}交付`}>
                    {calendar.isPending ? "加载中" : calendar.error ? "待重试" : `${calendar.data?.days.find(item => item.date === date)?.total ?? 0} 项`}
                  </button>
                </section>
              );
            })}
          </div>
          <p role="status">整月 {calendar.data?.total ?? "…"} 项 · 当前选择 {day}（下方明细可分页）</p>
        </>
      ) : null}
        <div className="delivery-rows">
          {rows.map((row) => (
            <article className="panel" key={row.id}>
              <div className="panel-heading">
                <div>
                  <h2>{row.title}</h2>
                  <p>
                    {accountName(row.accountId)} ·{" "}
                    {row.subjectKind === "video" ? "视频" : "文章"} r
                    {row.revision}
                  </p>
                </div>
                <span className="badge">
                  {deliveryLabel(row.status, row.draftOnly)}
                </span>
              </div>
              <small>{view === "calendar" ? "计划时间" : "创建时间"} · {new Date(view === "calendar" ? row.scheduledAt : row.createdAt).toLocaleString("zh-CN", {timeZone:"Asia/Singapore"})}（UTC+8）</small>
              <div className="job-actions">
                <Link
                  className="button"
                  to={taskContentHref(row.ref, "publish", { episodeId: row.episodeId, articleId: row.subjectKind === "article" ? row.subjectId : null, jobId: row.id })}
                >
                  在任务内处理
                </Link>
                {row.remoteUrl ? (
                  <a href={row.remoteUrl} target="_blank" rel="noreferrer">
                    查看平台结果 ↗
                  </a>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      {query.isSuccess && !rows.length ? (
        <EmptyState
          title={
            view === "history"
              ? "尚无已确认的公开发布"
              : view === "drafts"
                ? "尚无平台草稿任务"
                : view === "calendar" ? "这一天没有安排交付" : "没有需要处理的交付"
          }
          description="生成的内容仍在所属任务中。审核版本后，可按账号能力安排交付。"
          to="/tasks"
          action="查看任务"
        />
      ) : null}
      <div className="job-actions">
        {params.has("cursor") ? (
          <button
            onClick={() =>
              setParams((current) => {
                current.delete("cursor");
                return current;
              })
            }
          >
            返回第一页
          </button>
        ) : null}
        {query.data?.nextCursor ? (
          <button
            onClick={() =>
              setParams((current) => {
                current.set("cursor", query.data.nextCursor!);
                return current;
              })
            }
          >
            {view === "calendar" ? "当天明细下一页" : "下一页"}
          </button>
        ) : null}
      </div>
    </>
  );
}
