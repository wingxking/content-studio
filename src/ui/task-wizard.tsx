import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Account } from "../core/model.ts";
import { platformIds } from "../core/model.ts";
import {
  taskInputSchema,
  type Task,
  type TaskInput,
  type TaskRun,
} from "../core/task-model.ts";
import { taskHref } from "../contracts/workbench.ts";
import { newTaskInput } from "./task-panel.tsx";
import { TaskDeliverySettings, TaskBrandSettings } from "./task-delivery.tsx";
import { ResearchSettings } from "./research-settings.tsx";
import { AssetPicker } from "./assets.tsx";
import {
  ActionNotice,
  UnsavedChanges,
  useAssets,
  useCommandIds,
  useCommittedNavigation,
  useModels,
  useWorkspaceAction,
  useWorkspaceSummary,
} from "./workspace-hooks.tsx";
import { errorMessage, labels, request } from "./api.ts";
import { PageIntro } from "./workspace-layout.tsx";
import { creationKind, creationKinds, type CreationKind } from "./task-navigation.ts";

const KnowledgePicker = lazy(() =>
  import("./knowledge-panel.tsx").then((module) => ({
    default: module.KnowledgePicker,
  })),
);
const VideoWorkspace = lazy(() =>
  import("./video-workspace.tsx").then((module) => ({
    default: module.VideoWorkspace,
  })),
);
export function TaskCreatePage() {
  const [params] = useSearchParams();
  const [kind, setKind] = useState<CreationKind>(() => creationKind(params.get("type")));
  const [opened, setOpened] = useState<Set<CreationKind>>(() => new Set([creationKind(params.get("type"))]));
  const selectKind = (next: CreationKind) => {
    setOpened((current) => current.has(next) ? current : new Set([...current, next]));
    setKind(next);
  };
  return (
    <>
      <PageIntro
        title="新建任务"
        description="确定目标、选择资料、设置执行与交付。每次生产的内容都在同一个任务中管理。"
      />
      <div className="segmented" role="group" aria-label="任务类型">
        {creationKinds.map((type) => (
          <button
            key={type}
            className={kind === type ? "selected" : ""}
            aria-pressed={kind === type}
            onClick={() => selectKind(type)}
          >
            {type === "content"
              ? "文章生产"
              : type === "discovery"
                ? "发现选题"
                : "视频项目"}
          </button>
        ))}
      </div>
      {creationKinds.filter((type) => opened.has(type)).map((type) => (
        <div key={type} hidden={kind !== type}>
          {type === "video" ? (
            <Suspense fallback={<p>加载视频配置…</p>}>
              <VideoWorkspace createOnly />
            </Suspense>
          ) : <TaskWizard kind={type} />}
        </div>
      ))}
    </>
  );
}
function TaskWizard({ kind }: { kind: TaskInput["kind"] }) {
  const models = useModels();
  const assets = useAssets();
  const summary = useWorkspaceSummary();
  const feedback = useWorkspaceAction();
  const commands = useCommandIds();
  const allowNavigation = useCommittedNavigation();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(() => newTaskInput(kind));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  useEffect(() => {
    if (!value.model && models.data?.[0])
      setValue((current) => ({ ...current, model: models.data[0]!.id }));
  }, [models.data, value.model]);
  useEffect(() => {
    if (destination && saved) {
      allowNavigation();
      navigate(destination);
    }
  }, [destination, saved, navigate, allowNavigation]);
  const set = <K extends keyof TaskInput>(key: K, next: TaskInput[K]) =>
    setValue((current) => ({ ...current, [key]: next }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    const input = taskInputSchema.safeParse(value);
    if (!input.success) {
      setError(input.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    const runNow =
      (event.nativeEvent as SubmitEvent).submitter instanceof
        HTMLButtonElement &&
      ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)
        .value === "run";
    await feedback.action(async () => {
      const commandId = commands(JSON.stringify(input.data));
      const task = await request<Task>("tasks", { ...input.data, commandId });
      const run = runNow
        ? await request<TaskRun>(`tasks/${task.id}/run`, { commandId })
        : null;
      setSaved(true);
      setDestination(
        taskHref({ kind: "plan", id: task.id }, "overview", run?.id),
      );
    }, "任务已保存。");
  };
  return (
    <form
      className="panel task-wizard"
      onSubmit={(event) => void submit(event)}
    >
      <UnsavedChanges dirty={!saved && Boolean(value.title || value.prompt)} />
      <ActionNotice {...feedback} />
      <ol className="wizard-steps">
        {["创作目标", "资料与要求", "执行与交付"].map((label, index) => (
          <li className={index === step ? "active" : ""} key={label}>
            <button
              type="button"
              disabled={index > step}
              onClick={() => setStep(index)}
            >
              {index + 1} · {label}
            </button>
          </li>
        ))}
      </ol>
      {error ? <p role="alert">{error}</p> : null}
      {step === 0 ? (
        <>
          <label>
            任务名称
            <input
              required
              maxLength={200}
              value={value.title}
              onChange={(event) => set("title", event.target.value)}
              placeholder="例如：每周 AI 工具实践"
            />
          </label>
          <label>
            {kind === "discovery" ? "关注哪些方向" : "希望创作什么"}
            <textarea
              required
              minLength={3}
              maxLength={12000}
              value={value.prompt}
              onChange={(event) => set("prompt", event.target.value)}
              rows={4}
            />
          </label>
          <label>
            目标读者
            <input
              value={value.audience}
              maxLength={1000}
              onChange={(event) => set("audience", event.target.value)}
            />
          </label>
          <fieldset>
            <legend>目标平台</legend>
            <div className="platform-picker">
              {platformIds.map((platform) => (
                <label className="channel" key={platform}>
                  <input
                    type="checkbox"
                    checked={value.platforms.includes(platform)}
                    onChange={() =>
                      set(
                        "platforms",
                        value.platforms.includes(platform)
                          ? value.platforms.filter((item) => item !== platform)
                          : [...value.platforms, platform],
                      )
                    }
                  />
                  {labels[platform]}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : null}
      {step === 1 ? (
        <>
          <ResearchSettings value={value} onChange={setValue} />
          <details>
            <summary>补充指定来源</summary>
            {value.sources.map((source, index) => (
              <div className="source-input" key={index}>
                {(["title", "url", "excerpt"] as const).map((field) => (
                  <label key={field}>
                    {field === "title"
                      ? "标题"
                      : field === "url"
                        ? "公开链接"
                        : "摘录"}
                    <input
                      type={field === "url" ? "url" : "text"}
                      value={source[field]}
                      onChange={(event) =>
                        set(
                          "sources",
                          value.sources.map((item, i) =>
                            i === index
                              ? { ...item, [field]: event.target.value }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            ))}
            <button
              type="button"
              disabled={value.sources.length >= 20}
              onClick={() =>
                set("sources", [
                  ...value.sources,
                  { title: "", url: "", excerpt: "" },
                ])
              }
            >
              添加来源
            </button>
          </details>
          <Suspense fallback={<p>加载知识文档…</p>}>
            <KnowledgePicker
              selected={value.knowledgeIds}
              onChange={(ids) => set("knowledgeIds", ids)}
              disabled={feedback.busy}
            />
          </Suspense>
          <AssetPicker
            assets={assets.data ?? []}
            selected={value.assetIds}
            onChange={(ids) => set("assetIds", ids)}
            onUpload={assets.onUpload}
            maxSelected={12}
          />
          <TaskBrandSettings
            brand={value.brand}
            onChange={(brand) => set("brand", brand)}
          />
        </>
      ) : null}
      {step === 2 ? (
        <>
          <label>
            创作模型
            <select
              required
              value={value.model}
              onChange={(event) => set("model", event.target.value)}
            >
              <option value="">选择模型</option>
              {models.data?.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          {models.error ? (
            <p role="alert">
              {errorMessage(models.error)}{" "}
              <button type="button" onClick={() => void models.refetch()}>
                重试读取模型
              </button>
            </p>
          ) : null}
          <label>
            生产频率
            <select
              value={value.frequency.type}
              onChange={(event) =>
                set("frequency", {
                  ...value.frequency,
                  type: event.target.value as TaskInput["frequency"]["type"],
                })
              }
            >
              <option value="once">仅运行一次 / 指定时间</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {value.frequency.type === "once" ? (
            <label>
              指定生产时间（可选）
              <input
                type="datetime-local"
                value={value.frequency.onceAt ? localDateTime(value.frequency.onceAt) : ""}
                onChange={(event) =>
                  set("frequency", {
                    ...value.frequency,
                    onceAt: event.target.value
                      ? new Date(event.target.value).toISOString()
                      : undefined,
                  })
                }
              />
            </label>
          ) : (
            <label>
              生产时间
              <input
                required
                type="time"
                value={value.frequency.time}
                onChange={(event) =>
                  set("frequency", {
                    ...value.frequency,
                    time: event.target.value,
                  })
                }
              />
            </label>
          )}
          {value.frequency.type === "weekly" ? (
            <div className="weekday-picker">
              {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => (
                <label key={day} className="channel">
                  <input
                    type="checkbox"
                    checked={value.frequency.weekdays?.includes(index) ?? false}
                    onChange={() =>
                      set("frequency", {
                        ...value.frequency,
                        weekdays: value.frequency.weekdays?.includes(index)
                          ? value.frequency.weekdays.filter(
                              (day) => day !== index,
                            )
                          : [...(value.frequency.weekdays ?? []), index],
                      })
                    }
                  />
                  周{day}
                </label>
              ))}
            </div>
          ) : null}
          <label>
            计划时区
            <input
              required
              value={value.frequency.timezone}
              onChange={(event) =>
                set("frequency", {
                  ...value.frequency,
                  timezone: event.target.value,
                })
              }
            />
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
            />
            启用本任务的定时计划
          </label>
          {summary.data?.schedulerEnabled === false ? (
            <p className="hint">定时生产总开关当前暂停，仍可保存并运行一次。</p>
          ) : null}
          {kind === "discovery" ? (
            <label className="inline-check">
              <input
                type="checkbox"
                checked={value.discoveryAutomation.enabled}
                onChange={(event) =>
                  set("discoveryAutomation", {
                    ...value.discoveryAutomation,
                    enabled: event.target.checked,
                  })
                }
              />
              发现选题后自动生产草稿（每期最多{" "}
              {value.discoveryAutomation.maxDrafts} 篇）
            </label>
          ) : null}
          <TaskDeliverySettings
            value={value}
            accounts={(summary.data?.accounts ?? []) as Account[]}
            onChange={(delivery) =>
              setValue((current) => ({
                ...current,
                delivery,
                draftSync: { enabled: false, accountIds: [] },
              }))
            }
          />
        </>
      ) : null}
      <div className="form-footer">
        <span>第 {step + 1} 步，共 3 步</span>
        <div>
          {step > 0 ? (
            <button type="button" onClick={() => setStep(step - 1)}>
              上一步
            </button>
          ) : null}
          {step < 2 ? (
            <button className="primary" disabled={!value.platforms.length}>
              下一步
            </button>
          ) : (
            <>
              <button disabled={feedback.busy} value="save">
                保存任务
              </button>
              <button
                disabled={
                  feedback.busy ||
                  !models.data?.some((model) => model.id === value.model)
                }
                className="primary"
                value="run"
              >
                保存并运行一次
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}

function localDateTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
