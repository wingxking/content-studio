import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { z } from "zod";
import {
  librarySchema,
  taskHref,
  taskIndexSchema,
  taskRefSchema,
} from "../contracts/workbench.ts";
import {
  readWorkspace,
  writeWorkspace,
  workspaceQuery,
} from "../client/workspace.ts";
import { AssetsPanel } from "./assets.tsx";
import {
  ActionNotice,
  useAssets,
  useWorkspaceAction,
} from "./workspace-hooks.tsx";
import { PageIntro, QueryError } from "./workspace-layout.tsx";

const KnowledgePanel = lazy(() =>
  import("./knowledge-panel.tsx").then((module) => ({
    default: module.KnowledgePanel,
  })),
);
export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "sources";
  const assets = useAssets();
  const library = useQuery({
    queryKey: ["workspace", "library", params.get("cursor")],
    queryFn: ({ signal }) =>
      readWorkspace(
        `library${workspaceQuery({ cursor: params.get("cursor") ?? undefined })}`,
        librarySchema,
        signal,
      ),
  });
  return (
    <>
      <PageIntro
        title="资料库"
        description="集中管理网页资料、知识文档和媒体。加入任务后可继续追踪使用位置。"
      />
      <nav className="task-tabs" aria-label="资料类型">
        {[
          { id: "sources", label: "网页资料" },
          { id: "knowledge", label: "知识文档" },
          { id: "media", label: "图片与视频" },
        ].map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setParams({ tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {tab === "sources" ? (
        <>
          <QueryError error={library.error} />
          {library.data?.entries.map((entry) => (
            <article className="panel" key={entry.id}>
              <h2>
                <a href={entry.url} target="_blank" rel="noreferrer">
                  {entry.title} ↗
                </a>
              </h2>
              <p>{entry.excerpt}</p>
              <p className="hint">
                {
                  library.data.links.filter(
                    (link) => link.resource_id === entry.id,
                  ).length
                }{" "}
                处任务附件引用
              </p>
              {library.data.links
                .filter((link) => link.resource_id === entry.id)
                .map((link) => (
                  <Link
                    className="button"
                    key={link.id}
                    to={taskHref(
                      { kind: link.task_kind, id: link.task_id },
                      "resources",
                      link.episode_id,
                    )}
                  >
                    打开所属任务
                  </Link>
                ))}
              <ResourceAssignment kind="capture" id={entry.id} />
            </article>
          ))}
          {library.isSuccess && !library.data.entries.length ? (
            <p className="panel">
              在任务的“资料与素材”或浏览器插件中采集第一个网页。
            </p>
          ) : null}
          {library.data?.nextCursor ? (
            <button
              onClick={() =>
                setParams((current) => {
                  current.set("cursor", library.data.nextCursor!);
                  return current;
                })
              }
            >
              更早的资料
            </button>
          ) : null}
        </>
      ) : tab === "knowledge" ? (
        <Suspense fallback={<p>加载知识文档…</p>}>
          <KnowledgePanel renderActions={(source) => <ResourceAssignment kind="knowledge" id={source.id} />} />
        </Suspense>
      ) : (
        <>
          <QueryError error={assets.error} />
          <AssetsPanel embedded assets={assets.data ?? []} onUpload={assets.onUpload} renderActions={(asset) => <ResourceAssignment kind="asset" id={asset.id} />} />
        </>
      )}
    </>
  );
}
export function ResourceAssignment({
  kind,
  id,
}: {
  kind: "capture" | "asset" | "knowledge";
  id: string;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [opened, setOpened] = useState(false);
  const feedback = useWorkspaceAction(["workspace", "task-resources"]);
  const tasks = useQuery({
    queryKey: ["workspace", "task-index", "resource", search],
    queryFn: ({ signal }) =>
      readWorkspace(
        `task-index${workspaceQuery({ search })}`,
        taskIndexSchema,
        signal,
      ),
    enabled: opened,
  });
  return (
    <details onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>加入任务附件</summary>
      <ActionNotice {...feedback} />
      <label>
        查找任务
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <label>
        目标任务
        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">选择任务</option>
          {tasks.data?.items.map((task) => (
            <option
              key={`${task.kind}:${task.id}`}
              value={`${task.kind}:${task.id}`}
            >
              {task.title}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={feedback.busy || !selected}
        onClick={() =>
          void feedback.action(async () => {
            const [taskKind, taskId] = selected.split(":");
            const task = taskRefSchema.parse({ kind: taskKind, id: taskId });
            await writeWorkspace(
              "resource-links",
              { task, kind, id },
              z.object({ saved: z.boolean() }),
            );
          }, "已加入任务附件。可在任务内选择是否用于后续生产。")
        }
      >
        加入所选任务
      </button>
      <QueryError error={tasks.error} />
    </details>
  );
}
