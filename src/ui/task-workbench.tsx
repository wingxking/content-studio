import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { z } from "zod";
import {
  taskContextSchema,
  taskHref,
  taskIndexSchema,
  taskRefSchema,
  activitySchema,
  contextContentSchema,
  resourcesSchema,
  captureSchema,
  captureInputSchema,
  type TaskContext,
  type TaskRef,
} from "../contracts/workbench.ts";
import { studioTabs } from "../contracts/studio-ui.ts";
import { articleDetailSchema } from "../contracts/workspace.ts";
import { taskRunSchema, type Task, type TaskRun } from "../core/task-model.ts";
import {
  readWorkspace,
  writeWorkspace,
  workspaceQuery,
} from "../client/workspace.ts";
import {
  ActionNotice,
  useAssets,
  useCommandIds,
  useModels,
  useWorkspaceAction,
  useWorkspaceSummary,
  useHasUnsavedChanges,
} from "./workspace-hooks.tsx";
import { editableTask, TaskForm } from "./task-panel.tsx";
import { TaskPublishing } from "./task-publishing.tsx";
import { RunEvidencePanel } from "./research-settings.tsx";
import { JobPanel } from "./publish-panel.tsx";
import { EmptyState, PageIntro, QueryError } from "./workspace-layout.tsx";
import { request, statusLabel } from "./api.ts";
import { createTaskHref, taskContentHref } from "./task-navigation.ts";

const DraftPanel = lazy(() =>
  import("./editor-panel.tsx").then((module) => ({
    default: module.DraftPanel,
  })),
);
const VideoTask = lazy(() =>
  import("./video-workspace.tsx").then((module) => ({
    default: module.VideoTask,
  })),
);
const active = (status: string) =>
  [
    "queued",
    "researching",
    "generating",
    "rendering",
    "running",
    "submitting",
  ].includes(status);
export function TaskIndexPage() {
  const [params, setParams] = useSearchParams();
  const suffix = workspaceQuery({
    cursor: params.get("cursor") ?? undefined,
    search: params.get("search") ?? undefined,
    kind: params.get("kind") ?? undefined,
    tag: params.get("tag") ?? undefined,
    archived: params.get("archived") ?? undefined,
  });
  const list = useQuery({
    queryKey: ["workspace", "task-index", suffix],
    queryFn: ({ signal }) =>
      readWorkspace(`task-index${suffix}`, taskIndexSchema, signal),
    refetchOnWindowFocus: true,
  });
  const change = (key: string, value: string) =>
    setParams((current) => {
      current.delete("cursor");
      if (value) current.set(key, value);
      else current.delete(key);
      return current;
    });
  return (
    <>
      <PageIntro
        title="任务中心"
        description="每个任务集中管理各期内容、资料、平台版本、发布与记录。"
      />
      <div className="task-toolbar">
        <Link className="button primary" to="/tasks/new">
          新建任务
        </Link>
        <label>
          搜索任务
          <input
            type="search"
            value={params.get("search") ?? ""}
            onChange={(event) => change("search", event.target.value)}
          />
        </label>
        <label>
          类型
          <select
            value={params.get("kind") ?? ""}
            onChange={(event) => change("kind", event.target.value)}
          >
            <option value="">全部类型</option>
            <option value="content">文章生产</option>
            <option value="discovery">发现选题</option>
            <option value="video">视频项目</option>
            <option value="article">历史独立内容</option>
          </select>
        </label>
        <label>
          标签
          <input
            value={params.get("tag") ?? ""}
            onChange={(event) => change("tag", event.target.value)}
          />
        </label>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={params.get("archived") === "true"}
            onChange={(event) =>
              change("archived", event.target.checked ? "true" : "")
            }
          />
          已归档
        </label>
      </div>
      <QueryError error={list.error} />
      {list.isPending ? <p role="status">正在读取任务…</p> : null}
      <div className="task-cards">
        {list.data?.items.map((item) => (
          <Link
            key={`${item.kind}:${item.id}`}
            className="panel task-card"
            to={taskHref(item)}
          >
            <span className="eyebrow">
              {item.category === "discovery"
                ? "发现选题"
                : item.kind === "video"
                  ? "视频项目"
                  : item.kind === "article"
                    ? "历史独立内容"
                    : "文章生产"}
            </span>
            <h2>{item.title}</h2>
            <span className="badge">
              {item.status === "enabled"
                ? "计划已启用"
                : item.status === "paused"
                  ? "计划已暂停"
                  : item.status === "standalone"
                    ? "待管理内容"
                    : statusLabel(item.status)}
            </span>
            <p>
              {item.episodeCount} 期内容
              {item.nextRunAt
                ? ` · 下次生产 ${new Date(item.nextRunAt).toLocaleString("zh-CN")}`
                : ""}
            </p>
            {item.tags.length ? <small>{item.tags.join(" · ")}</small> : null}
          </Link>
        ))}
      </div>
      {list.isSuccess && !list.data.items.length ? (
        <EmptyState
          title="从一个任务开始"
          description="填写主题，生成第一期内容；以后每次运行都保留在这个任务中。"
          to="/tasks/new"
          action="创建任务"
        />
      ) : null}
      <div className="job-actions">
        {params.has("cursor") ? (
          <button onClick={() => change("cursor", "")}>返回第一页</button>
        ) : null}
        {list.data?.nextCursor ? (
          <button
            onClick={() =>
              setParams((current) => {
                current.set("cursor", list.data.nextCursor!);
                return current;
              })
            }
          >
            下一页
          </button>
        ) : null}
      </div>
    </>
  );
}
export function TaskDetailPage() {
  const params = useParams();
  const parsed = taskRefSchema.safeParse({ kind: params.kind, id: params.id });
  if (!parsed.success)
    return (
      <EmptyState
        title="任务地址无效"
        description="请从任务中心选择任务。"
        to="/tasks"
        action="返回任务中心"
      />
    );
  return (
    <TaskDetail
      key={`${parsed.data.kind}:${parsed.data.id}`}
      taskRef={parsed.data}
      tab={
        studioTabs.some((tab) => tab.id === params.tab)
          ? params.tab!
          : "content"
      }
    />
  );
}
function TaskDetail({ taskRef, tab }: { taskRef: TaskRef; tab: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const commands = useCommandIds();
  const summary = useWorkspaceSummary();
  const hasUnsavedChanges = useHasUnsavedChanges();
  const models = useModels();
  const assets = useAssets();
  const feedback = useWorkspaceAction([
    "workspace",
    "task-context",
    taskRef.kind,
    taskRef.id,
  ]);
  const base = `task-context/${taskRef.kind}/${taskRef.id}`;
  const episode = params.get("episode");
  const episodeCursor = params.get("episodesCursor");
  const context = useQuery({
    queryKey: [
      "workspace",
      "task-context",
      taskRef.kind,
      taskRef.id,
      episode,
      episodeCursor,
    ],
    queryFn: ({ signal }) =>
      readWorkspace(
        `${base}${workspaceQuery({ episode: episode ?? undefined, cursor: episodeCursor ?? undefined })}`,
        taskContextSchema,
        signal,
      ),
    refetchInterval: (query) =>
      query.state.data?.episodes.some((episode) => active(episode.status))
        ? 4000
        : false,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (context.data?.selectedEpisodeId && !episode)
      setParams(
        (current) => {
          current.set("episode", context.data.selectedEpisodeId!);
          return current;
        },
        { replace: true },
      );
  }, [context.data?.selectedEpisodeId, episode, setParams]);
  const current = context.data?.selectedEpisodeId;
  const currentEpisode = context.data?.episodes.find(
    (item) => item.id === current,
  );
  const content = useQuery({
    queryKey: [
      "workspace",
      "task-context",
      taskRef.kind,
      taskRef.id,
      current,
      "content",
      params.get("contentCursor"),
    ],
    queryFn: ({ signal }) =>
      readWorkspace(
        `${base}/episodes/${current}/content${workspaceQuery({ cursor: params.get("contentCursor") ?? undefined })}`,
        contextContentSchema,
        signal,
      ),
    enabled: Boolean(current) && taskRef.kind !== "video",
    refetchInterval:
      currentEpisode && active(currentEpisode.status) ? 4000 : false,
  });
  const requestedArticle = params.get("article");
  const articleOwner = useQuery({
    queryKey: ["workspace", "article-owner", requestedArticle],
    queryFn: ({ signal }) => readWorkspace(`resolve-article/${requestedArticle}`, z.object({ ref: taskRefSchema, episode: z.uuid() }), signal),
    enabled: Boolean(requestedArticle) && taskRef.kind !== "video",
  });
  const explicitArticleMatches = articleOwner.data?.ref.kind === taskRef.kind && articleOwner.data.ref.id === taskRef.id && articleOwner.data.episode === current;
  const selectedId = requestedArticle
    ? explicitArticleMatches ? requestedArticle : null
    : content.data?.items[0]?.id;
  const article = useQuery({
    queryKey: ["workspace", "article", selectedId],
    queryFn: ({ signal }) =>
      readWorkspace(`articles/${selectedId}`, articleDetailSchema, signal),
    enabled: Boolean(selectedId),
    refetchInterval: (query) =>
      query.state.data?.draft.adaptationStatus === "pending" ||
      query.state.data?.jobs.some((job) =>
        ["scheduled", "submitting", "queued"].includes(job.status),
      )
        ? 4000
        : false,
  });
  const requestedJob = params.get("job");
  const focusedDelivery = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "publish" || !requestedJob || focusedDelivery.current === requestedJob || !article.data?.jobs.some((job) => job.id === requestedJob)) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(`delivery-${requestedJob}`);
      if (element) {
        focusedDelivery.current = requestedJob;
        element.scrollIntoView({ block: "center" });
        element.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, requestedJob, article.data]);
  const run = useQuery({
    queryKey: ["workspace", "run", current],
    queryFn: ({ signal }) =>
      readWorkspace(`runs/${current}`, taskRunSchema, signal),
    enabled:
      taskRef.kind === "plan" &&
      Boolean(current) &&
      (tab === "resources" ||
        tab === "activity" ||
        context.data?.plan?.kind === "discovery"),
    refetchInterval: (query) =>
      query.state.data && active(query.state.data.status) ? 4000 : false,
  });
  const activity = useQuery({
    queryKey: [
      "workspace",
      "task-context",
      taskRef.kind,
      taskRef.id,
      current,
      "activity",
    ],
    queryFn: ({ signal }) =>
      readWorkspace(
        `${base}/episodes/${current}/activity`,
        activitySchema,
        signal,
      ),
    enabled: Boolean(current) && tab === "activity" && taskRef.kind !== "video",
    refetchInterval:
      currentEpisode && active(currentEpisode.status) ? 4000 : false,
  });
  const [visited, setVisited] = useState<Set<string>>(() => new Set([tab]));
  const settings = useRef<HTMLDialogElement>(null);
  const [tagText, setTagText] = useState("");
  const [batchId, setBatchId] = useState<string | null>(params.get("batch"));
  const batchParam = params.get("batch");
  useEffect(() => setBatchId(batchParam), [batchParam]);
  useEffect(
    () =>
      setVisited((current) =>
        current.has(tab) ? current : new Set([...current, tab]),
      ),
    [tab],
  );
  const setEpisode = (id: string) =>
    setParams((current) => {
      current.set("episode", id);
      current.delete("article");
      current.delete("contentCursor");
      current.delete("batch");
      current.delete("job");
      return current;
    });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["workspace", "task-context", taskRef.kind, taskRef.id],
      }),
      client.invalidateQueries({
        queryKey: ["workspace", "article", selectedId],
      }),
      client.invalidateQueries({ queryKey: ["workspace", "task-index"] }),
    ]);
  };
  const tabHref = (next: string) => {
    const query = new URLSearchParams(params);
    if (current) query.set("episode", current);
    return `/tasks/${taskRef.kind}/${taskRef.id}/${next}${query.size ? `?${query}` : ""}`;
  };
  const createFromQuestion = async (questionIndex: number) =>
    feedback.action(async () => {
      const result = await writeWorkspace(
        "from-question",
        {
          runId: current,
          questionIndex,
          runNow: true,
          commandId: commands(`question:${current}:${questionIndex}`),
        },
        z.object({
          task: z.object({ id: z.uuid() }),
          run: taskRunSchema.nullable(),
        }),
      );
      navigate(
        taskHref(
          { kind: "plan", id: result.task.id },
          "overview",
          result.run?.id,
        ),
      );
    }, "已创建并启动此选题的内容任务。");
  if (context.error)
    return (
      <>
        <QueryError error={context.error} />
        <Link to="/tasks">返回任务中心</Link>
        <button onClick={() => void context.refetch()}>重试读取</button>
      </>
    );
  if (!context.data) return <p role="status">正在打开任务…</p>;
  const data = context.data;
  const plan = data.plan;
  return (
    <div className="task-detail">
      <header className="task-header">
        <Link to="/tasks">← 任务中心</Link>
        <div className="panel-heading">
          <div>
            <h1>{data.title}</h1>
            <p>
              {taskRef.kind === "video"
                ? "独立视频项目 · 创建和渲染均由你发起"
                : plan
                  ? `${plan.kind === "discovery" ? "选题发现" : "文章生产"} · ${plan.enabled ? "计划已启用" : "计划已暂停"} · ${plan.frequency.timezone}`
                  : "历史独立内容"}
              {plan?.nextRunAt
                ? ` · 下次生产 ${new Date(plan.nextRunAt).toLocaleString("zh-CN")}`
                : ""}
            </p>
          </div>
          <div className="job-actions">
            {plan ? (
              <>
                <button
                  className="primary"
                  disabled={
                    feedback.busy || hasUnsavedChanges ||
                    !models.data?.some((model) => model.id === plan.model)
                  }
                  title={hasUnsavedChanges ? "请先保存当前修改，再运行下一期。" : undefined}
                  onClick={() =>
                    void feedback.action(async () => {
                      const next = await request<TaskRun>(
                        `tasks/${plan.id}/run`,
                        { commandId: crypto.randomUUID() },
                      );
                      setEpisode(next.id);
                      await refresh();
                    }, "已启动本次生产。")
                  }
                >
                  运行一次
                </button>
                <button
                  disabled={feedback.busy}
                  onClick={() =>
                    void feedback.action(
                      async () => {
                        await request(
                          `tasks/${plan.id}`,
                          { ...editableTask(plan), enabled: !plan.enabled },
                          "PUT",
                        );
                        await refresh();
                      },
                      plan.enabled ? "计划已暂停。" : "计划已启用。",
                    )
                  }
                >
                  {plan.enabled ? "暂停计划" : "启用计划"}
                </button>
              </>
            ) : null}
            <button
              onClick={() => {
                setTagText(data.tags.join("，"));
                settings.current?.showModal();
              }}
            >
              任务设置
            </button>
          </div>
        </div>
        {summary.data?.schedulerEnabled === false && plan?.enabled ? (
          <p className="hint">
            定时生产总开关已暂停，当前可以手动运行。
            <Link to="/settings/setup">管理运行开关 →</Link>
          </p>
        ) : null}
        {data.archivedAt ? <p className="badge">已归档</p> : null}
      </header>
      <ActionNotice {...feedback} />
      {currentEpisode ? <div className="task-period-summary"><strong>当前期次 · {new Date(currentEpisode.createdAt).toLocaleString("zh-CN")}</strong><span className="badge">{statusLabel(currentEpisode.status)}</span>{plan ? <span>任务设置用于后续执行，本期内容与引用独立保留。</span> : null}</div> : null}
      <div className={`task-detail-layout ${data.episodes.length > 1 || data.nextCursor || episodeCursor ? "" : "single-period"}`}>
        {data.episodes.length > 1 || data.nextCursor || episodeCursor ? <aside className="episode-list" aria-label="期次">
          <h2>{taskRef.kind === "plan" ? "每期内容" : "当前项目"}</h2>
          {data.episodes.map((item) => (
            <button
              key={item.id}
              className={item.id === current ? "selected" : ""}
              onClick={() => setEpisode(item.id)}
            >
              <strong>
                {new Date(item.createdAt).toLocaleDateString("zh-CN")}
              </strong>
              <small>{item.title}</small>
              <span>{statusLabel(item.status)}</span>
            </button>
          ))}
          {!data.episodes.length ? (
            <p>运行一次后，第一期内容将显示在这里。</p>
          ) : null}
          {data.nextCursor ? (
            <button
              onClick={() =>
                setParams((current) => {
                  current.set("episodesCursor", data.nextCursor!);
                  current.delete("episode");
                  return current;
                })
              }
            >
              更早的期次
            </button>
          ) : null}
          {episodeCursor ? (
            <button
              onClick={() =>
                setParams((current) => {
                  current.delete("episodesCursor");
                  current.delete("episode");
                  return current;
                })
              }
            >
              最新期次
            </button>
          ) : null}
        </aside> : null}
        <section className="task-detail-main">
          <nav className="task-tabs" aria-label="任务管理">
            {studioTabs.map((item) => (
              <Link
                aria-current={tab === item.id ? "page" : undefined}
                className={tab === item.id ? "active" : ""}
                key={item.id}
                to={tabHref(item.id)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <QueryError error={content.error ?? article.error ?? run.error} />
          <QueryError error={articleOwner.error} />
          {requestedArticle && articleOwner.isSuccess && !explicitArticleMatches ? <p role="alert">该内容不属于当前任务期次。请从任务中心重新选择内容。</p> : null}
          {requestedJob && article.isSuccess && !article.data.jobs.some((job) => job.id === requestedJob) ? <p role="alert">该交付记录不属于当前稿件，请从发布管理重新打开。</p> : null}
          {taskRef.kind === "video" ? (
            <Suspense fallback={<p>加载视频项目…</p>}>
              <VideoTask id={taskRef.id} section={tab} />
            </Suspense>
          ) : (
            <>
              {visited.has("content") ? (
                <div hidden={tab !== "content"}>
                  {content.data?.items.length ? (
                    <ContentPicker
                      items={content.data.items}
                      selected={selectedId}
                      selectedTitle={article.data?.draft.title}
                      onSelect={(id) =>
                        setParams((current) => {
                          current.set("article", id);
                          current.delete("job");
                          current.delete("batch");
                          return current;
                        })
                      }
                    />
                  ) : (
                    <EmptyState
                      title="本期内容尚未生成"
                      description={currentEpisode ? "打开记录查看生产进度与需要处理的事项。" : "点击上方“运行一次”生成第一期内容。"}
                      to={currentEpisode ? tabHref("activity") : undefined}
                      action={currentEpisode ? "查看生产记录" : undefined}
                    />
                  )}
                  {article.data ? (
                    <Suspense fallback={<p>加载内容编辑器…</p>}>
                      <DraftPanel
                        key={article.data.draft.id}
                        draft={article.data.draft}
                        jobs={article.data.jobs}
                        accounts={summary.data?.accounts ?? []}
                        models={models.data ?? []}
                        assets={assets.data ?? []}
                        onUpload={assets.onUpload}
                        busy={feedback.busy}
                        action={async (task, message) =>
                          feedback.action(async () => {
                            await task();
                            await refresh();
                          }, message)
                        }
                        showPublishing={false}
                      />
                    </Suspense>
                  ) : null}
                </div>
              ) : null}
              {tab === "publish" ? (
                <section className="panel">
                  {content.data?.items.length ? (
                    <ContentPicker
                      items={content.data.items}
                      selected={selectedId}
                      selectedTitle={article.data?.draft.title}
                      onSelect={(id) =>
                        setParams((current) => {
                          current.set("article", id);
                          current.delete("job");
                          current.delete("batch");
                          return current;
                        })
                      }
                    />
                  ) : null}
                  {article.data ? (
                    <TaskPublishing
                      key={article.data.draft.id}
                      draft={article.data.draft}
                      jobs={article.data.jobs}
                      accounts={summary.data?.accounts ?? []}
                      busy={feedback.busy}
                      action={async (task, message) =>
                        feedback.action(async () => {
                          await task();
                          await refresh();
                        }, message)
                      }
                      batchId={batchId}
                      onBatch={(id) => {
                        setBatchId(id);
                        setParams((current) => {
                          current.set("batch", id);
                          return current;
                        });
                        void refresh();
                      }}
                    />
                  ) : (
                    <EmptyState
                      title="生成内容后可检查发布"
                      description="所有平台版本和账号交付都保存在当前任务内。"
                    />
                  )}
                </section>
              ) : null}
            </>
          )}
          {tab === "resources" ? (
            <TaskResources
              context={data}
              episodeId={current}
              run={run.data}
              articleSources={article.data?.draft.brief.sources ?? []}
            />
          ) : null}
          {plan?.kind === "discovery" &&
          ["overview", "content"].includes(tab) &&
          run.data?.questions.length ? (
            <section className="panel">
              <h2>本期选题</h2>
              {run.data.questions.map((question, index) => (
                <article key={`${run.data!.id}:${index}`} className="note-card">
                  <h3>{question.question}</h3>
                  <p>{question.audienceNeed}</p>
                  {data.related.find(
                    (link) =>
                      link.parentRunId === current &&
                      link.questionIndex === index &&
                      link.relation === "question_derived",
                  ) ? (
                    <Link
                      className="button"
                      to={taskHref({
                        kind: "plan",
                        id: data.related.find(
                          (link) =>
                            link.parentRunId === current &&
                            link.questionIndex === index &&
                            link.relation === "question_derived",
                        )!.childTaskId,
                      })}
                    >
                      打开已生成内容
                    </Link>
                  ) : (
                    <button
                      disabled={feedback.busy}
                      onClick={() => void createFromQuestion(index)}
                    >
                      生产此选题内容
                    </button>
                  )}
                </article>
              ))}
            </section>
          ) : null}
          {tab === "activity" ? (
            <section className="panel">
              <h2>本期记录</h2>
              <QueryError error={activity.error} />
              {activity.data?.events.map((event) => (
                <article className="note-card" key={event.id}>
                  <strong>
                    {event.kind} · {statusLabel(event.status)}
                  </strong>
                  <p>
                    {new Date(event.at).toLocaleString("zh-CN")} ·{" "}
                    {event.detail}
                  </p>
                </article>
              ))}
              {run.data ? (
                <>
                  <p>
                    生产：{statusLabel(run.data.status)} · {run.data.phase}
                  </p>
                  {run.data.error ? <p role="alert">{run.data.error}</p> : null}
                  {run.data.warnings.map((warning) => (
                    <p key={warning} className="hint">
                      {warning}
                    </p>
                  ))}
                  <RunEvidencePanel
                    runId={run.data.id}
                    running={active(run.data.status)}
                  />
                </>
              ) : null}
              {article.data?.jobs.map((job) => (
                <JobPanel
                  key={job.id}
                  job={job}
                  title={job.snapshot?.variant.title ?? data.title}
                  account={summary.data?.accounts.find(
                    (account) => account.id === job.accountId,
                  )}
                  busy={feedback.busy}
                  action={feedback.action}
                />
              ))}
              {!run.data &&
              !article.data?.jobs.length &&
              taskRef.kind !== "video" ? (
                <p>暂无执行或交付记录。</p>
              ) : null}
            </section>
          ) : null}
          {content.data?.nextCursor ? (
            <button
              onClick={() =>
                setParams((current) => {
                  current.set("contentCursor", content.data.nextCursor!);
                  current.delete("article");
                  return current;
                })
              }
            >
              更多本期内容
            </button>
          ) : null}
        </section>
      </div>
      <dialog ref={settings} className="task-settings-dialog">
        <div className="panel-heading">
          <h2>任务设置</h2>
          <button onClick={() => settings.current?.close()}>关闭</button>
        </div>
        <label>
          标签（逗号分隔）
          <input
            value={tagText}
            onChange={(event) => setTagText(event.target.value)}
          />
        </label>
        <div className="job-actions">
          <button
            disabled={feedback.busy}
            onClick={() =>
              void feedback.action(async () => {
                await writeWorkspace(
                  `${base}/presentation`,
                  {
                    tags: tagText
                      .split(/[,，]/u)
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                    archived: Boolean(data.archivedAt),
                  },
                  z.object({ saved: z.boolean() }),
                );
                await refresh();
              }, "标签已保存。")
            }
          >
            保存标签
          </button>
          <button
            disabled={feedback.busy}
            onClick={() =>
              void feedback.action(
                async () => {
                  await writeWorkspace(
                    `${base}/presentation`,
                    { tags: data.tags, archived: !data.archivedAt },
                    z.object({ saved: z.boolean() }),
                  );
                  await refresh();
                  settings.current?.close();
                },
                data.archivedAt ? "任务已取消归档。" : "任务已归档。",
              )
            }
          >
            {data.archivedAt ? "取消归档" : "归档任务"}
          </button>
        </div>
        <p className="hint">
          归档前请暂停计划并处理执行中、待交付和待对账事项。
        </p>
        {plan ? (
          <TaskForm
            key={plan.updatedAt}
            input={editableTask(plan)}
            editing
            models={models.data ?? []}
            modelsLoading={models.isFetching}
            onRefreshModels={() => void models.refetch()}
            accounts={summary.data?.accounts ?? []}
            assets={assets.data ?? []}
            onUpload={assets.onUpload}
            busy={feedback.busy}
            onSubmit={async (input, runNow) => {
              await feedback.perform(async () => {
                const saved = await request<Task>(
                  `tasks/${plan.id}`,
                  input,
                  "PUT",
                );
                if (runNow) {
                  const next = await request<TaskRun>(`tasks/${saved.id}/run`, {
                    commandId: crypto.randomUUID(),
                  });
                  setEpisode(next.id);
                }
                await refresh();
                settings.current?.close();
              }, "任务设置已保存。");
            }}
          />
        ) : null}
        <ActionNotice {...feedback} />
      </dialog>
    </div>
  );
}
function ContentPicker({
  items,
  selected,
  selectedTitle,
  onSelect,
}: {
  items: z.infer<typeof contextContentSchema>["items"];
  selected: string | null | undefined;
  selectedTitle?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <label>
      本期内容
      <select
        value={selected ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="" disabled>
          选择内容
        </option>
        {selected && !items.some((item) => item.id === selected) ? <option value={selected}>{selectedTitle ?? "正在读取指定内容…"}</option> : null}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title} · r{item.revision}
          </option>
        ))}
      </select>
    </label>
  );
}
export function TaskResources({
  context,
  episodeId,
  run,
  articleSources,
}: {
  context: TaskContext;
  episodeId: string | null | undefined;
  run?: TaskRun;
  articleSources: { title: string; url: string; excerpt: string }[];
}) {
  const client = useQueryClient();
  const commands = useCommandIds();
  const feedback = useWorkspaceAction([
    "workspace",
    "task-resources",
    context.ref.kind,
    context.ref.id,
  ]);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const query = useQuery({
    queryKey: [
      "workspace",
      "task-resources",
      context.ref.kind,
      context.ref.id,
      episodeId,
    ],
    queryFn: ({ signal }) =>
      readWorkspace(
        `task-context/${context.ref.kind}/${context.ref.id}${episodeId ? `/episodes/${episodeId}` : ""}/resources`,
        resourcesSchema,
        signal,
      ),
  });
  const sources = run?.sources.length ? run.sources : articleSources;
  const captures = query.data?.captures ?? [];
  const unlink = (id: string) => feedback.action(async () => {
    await request(`workspace/resource-links/${id}`, {}, "DELETE");
    await query.refetch();
  }, "已解除附件关联，资料库与本期引用保留。");
  const useSource = async (capture: (typeof captures)[number]) =>
    feedback.action(async () => {
      const plan = context.plan;
      if (!plan)
        throw new Error(
          "此内容没有定时生产配置，可在内容编辑器中补充来源后重新调研。",
        );
      if (plan.authorization)
        throw new Error(
          "此计划已有自动发布授权，请在任务设置中添加资料并重新确认授权。",
        );
      const next = [
        ...plan.sources.filter((source) => source.url !== capture.url),
        { title: capture.title, url: capture.url, excerpt: capture.excerpt },
      ];
      if (next.length > 20)
        throw new Error("任务最多使用 20 个指定来源，请先移除不需要的来源。");
      await request(
        `tasks/${plan.id}`,
        { ...editableTask(plan), sources: next },
        "PUT",
      );
      await client.invalidateQueries({
        queryKey: [
          "workspace",
          "task-context",
          context.ref.kind,
          context.ref.id,
        ],
      });
    }, "资料已纳入后续生产；本期既有内容与引用继续保留。");
  return (
    <section className="panel">
      <h2>资料与素材</h2>
      <ActionNotice {...feedback} />
      <QueryError error={query.error} />
      {episodeId ? <><h3>本期实际引用</h3>
      {sources.length ? (
        sources.map((source) => (
          <article className="note-card" key={source.url}>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.title || source.url} ↗
            </a>
            <p>{source.excerpt}</p>
          </article>
        ))
      ) : (
        <p>尚无已固定的引用证据。</p>
      )}</> : <p className="hint">先收集任务资料，再运行第一期。任务附件可以供后续各期参考。</p>}
      <h3>任务附件</h3>
      {captures.map((capture) => (
        <article className="note-card" key={capture.id}>
          <a href={capture.url} target="_blank" rel="noreferrer">
            {capture.title} ↗
          </a>
          <p>{capture.excerpt}</p>
          <span className="badge">已收藏</span>
          {query.data?.links.filter(link => link.resource_kind === "capture" && link.resource_id === capture.id).map(link => <button key={link.id} disabled={feedback.busy} onClick={() => void unlink(link.id)}>移除附件关联</button>)}
          {context.plan ? (
            <button
              disabled={feedback.busy}
              onClick={() => void useSource(capture)}
            >
              纳入后续生产
            </button>
          ) : null}
        </article>
      ))}
      {query.data?.links
        .filter((link) => link.resource_kind !== "capture")
        .map((link) => {
          const resource = query.data?.resources.find((item) => item.id === link.resource_id && item.kind === link.resource_kind);
          return <article className="note-card task-resource" key={link.id}>
            <strong>{resource?.name ?? "资源暂不可用"}</strong>
            <p className="hint">{link.resource_kind === "asset" ? "媒体素材" : "知识文档"} · {link.episode_id ? "本期附件" : "任务附件"}</p>
            {resource?.mime?.startsWith("image/") && resource.url ? <img loading="lazy" src={resource.url} alt={resource.name} /> : null}
            <div className="job-actions">{resource?.url ? <a className="button" href={resource.url} target="_blank" rel="noreferrer">查看资料 ↗</a> : null}<button disabled={feedback.busy} onClick={() => void unlink(link.id)}>移除附件关联</button></div>
          </article>;
        })}
      <Link to="/library">从资料库查看素材与使用位置 →</Link>
      <details>
        <summary>{episodeId ? "采集网页资料到本期" : "采集网页资料到任务"}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void feedback.action(async () => {
              const input = captureInputSchema.parse({
                commandId: commands(
                  JSON.stringify({ title, url, excerpt, episodeId }),
                ),
                title,
                url,
                excerpt,
                task: context.ref,
                ...(episodeId ? { episodeId } : {}),
              });
              await writeWorkspace("captures", input, captureSchema);
              setTitle("");
              setUrl("");
              setExcerpt("");
              await query.refetch();
            }, "资料已收藏到当前任务。");
          }}
        >
          <label>
            标题
            <input
              required
              value={title}
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            公开链接
            <input
              required
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label>
            摘录
            <textarea
              value={excerpt}
              maxLength={12000}
              onChange={(event) => setExcerpt(event.target.value)}
            />
          </label>
          <button disabled={feedback.busy}>加入任务资料</button>
        </form>
      </details>
      <p className="hint">
        追加附件不改写已生成内容或原始证据。需要更新本期内容时，在内容标签发起重新调研。
      </p>
    </section>
  );
}

export function LegacyTaskLink({
  kind,
}: {
  kind:
    | "production"
    | "discover"
    | "content"
    | "distribution"
    | "history"
    | "videos";
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["legacy-task-link", kind, params.toString()],
    queryFn: async () => {
      if (params.get("projectId"))
        return taskHref(
          { kind: "video", id: z.uuid().parse(params.get("projectId")) },
          "content",
        );
      if (params.get("articleId")) {
        const result = await readWorkspace(
          `resolve-article/${params.get("articleId")}`,
          z.object({ ref: taskRefSchema, episode: z.uuid() }),
        );
        return taskContentHref(result.ref, kind === "distribution" ? "publish" : "content", { episodeId: result.episode, articleId: params.get("articleId"), jobId: params.get("jobId") });
      }
      if (params.get("taskId"))
        return taskHref(
          { kind: "plan", id: z.uuid().parse(params.get("taskId")) },
          kind === "history" ? "activity" : "overview",
          params.get("runId"),
        );
      if (params.get("runId")) {
        const run = await readWorkspace(
          `runs/${params.get("runId")}`,
          taskRunSchema,
        );
        return taskHref({ kind: "plan", id: run.taskId }, "activity", run.id);
      }
      if (kind === "discover") return createTaskHref("discovery");
      if (kind === "production") return createTaskHref("content");
      if (kind === "videos") return createTaskHref("video");
      return params.has("new") ? createTaskHref("content") : kind === "distribution" ? "/publishing" : "/tasks";
    },
    retry: false,
  });
  useEffect(() => {
    if (query.data) navigate(query.data, { replace: true });
  }, [query.data, navigate]);
  return query.error ? (
    <>
      <QueryError error={query.error} />
      <Link to="/tasks">返回任务中心</Link>
    </>
  ) : (
    <p role="status">正在定位任务与期次…</p>
  );
}
