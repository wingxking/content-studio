import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import {
  companionTabs,
  deliveryLabel,
  type CompanionMethod,
} from "../../../../src/contracts/studio-ui";
import "../../../../src/contracts/studio-tokens.css";
import "./studio-home.css";
import { SettingsDrawer } from "../components/SettingsDrawer";
import {
  ExtensionUpdates,
  extensionReleaseSchema,
  type ExtensionRelease,
} from "../components/ExtensionUpdates";
import {
  emptyCapture,
  persistCapture,
  restoreCapture,
  type CaptureSession,
} from "../../studio/capture-session";

const refSchema = z.object({
  kind: z.enum(["plan", "video", "article"]),
  id: z.string().uuid(),
});
const taskSchema = refSchema.extend({
  title: z.string(),
  status: z.string(),
  episodeCount: z.number(),
});
const tasksSchema = z.object({
  items: z.array(taskSchema),
  nextCursor: z.string().nullable(),
});
const accountSchema = z.object({
  id: z.string().uuid(),
  platform: z.string(),
  label: z.string(),
  status: z.string(),
  boundUserId: z.string().nullable(),
});
const deliveriesSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      status: z.string(),
      ref: refSchema,
      episodeId: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
const platformNames: Record<string, string> = {
  wechat: "微信公众号",
  zhihu: "知乎",
  bilibili: "B站专栏",
  youtube: "YouTube",
  xiaohongshu: "小红书",
  reddit: "Reddit",
  x: "X",
  producthunt: "Product Hunt",
};
async function message(type: string, payload?: unknown): Promise<unknown> {
  const response: unknown = await chrome.runtime.sendMessage({
    type,
    ...(payload === undefined ? {} : { payload }),
  });
  if (
    response &&
    typeof response === "object" &&
    "error" in response &&
    typeof response.error === "string"
  )
    throw new Error(response.error);
  return response;
}
async function rpc(
  method: CompanionMethod,
  data: unknown = {},
): Promise<unknown> {
  return message("STUDIO_UI_REQUEST", { method, data });
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请稍后重试。";
function useTaskPage(ready: boolean, search: string, cursor: string | null) {
  const [result, setResult] = useState<z.infer<typeof tasksSchema>>({
    items: [],
    nextCursor: null,
  });
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void rpc("tasks.list", {
        search,
        limit: 10,
        ...(cursor ? { cursor } : {}),
      })
        .then((value) => {
          if (active) {
            setResult(tasksSchema.parse(value));
            setError("");
          }
        })
        .catch((failure) => {
          if (active) setError(errorText(failure));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [ready, search, cursor]);
  return { ...result, error, loading };
}
export function StudioHome() {
  const navigate = useNavigate();
  const [tab, setTab] =
    useState<(typeof companionTabs)[number]["id"]>("capture");
  const [settings, setSettings] = useState(false),
    [ready, setReady] = useState(false),
    [origin, setOrigin] = useState("");
  const [offline, setOffline] = useState(false);
  const [writeBlock, setWriteBlock] = useState("");
  const [connection, setConnection] = useState("正在检查连接"),
    [release, setRelease] = useState<ExtensionRelease>();
  const [mode, setMode] = useState<"managed" | "standalone">("managed");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState<CaptureSession>(emptyCapture),
    [restored, setRestored] = useState(false);
  const persistence = useRef(Promise.resolve());
  const [captureSearch, setCaptureSearch] = useState(""),
    [captureCursor, setCaptureCursor] = useState<string | null>(null);
  const [taskSearch, setTaskSearch] = useState(""),
    [taskCursor, setTaskCursor] = useState<string | null>(null);
  const captureTasks = useTaskPage(
    ready && tab === "capture",
    captureSearch,
    captureCursor,
  );
  const tasks = useTaskPage(ready && tab === "tasks", taskSearch, taskCursor);
  const [accounts, setAccounts] = useState<z.infer<typeof accountSchema>[]>([]);
  const [deliveries, setDeliveries] = useState<
    z.infer<typeof deliveriesSchema>["items"]
  >([]);
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null),
    [nextDeliveryCursor, setNextDeliveryCursor] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [accountChecks, setAccountChecks] = useState<
    Record<string, { matched: boolean; text: string }>
  >({});
  useEffect(() => {
    let active = true;
    void restoreCapture()
      .then((saved) => {
        if (active) {
          if (saved) {
            setCapture(saved);
            setNotice(
              saved.submitted
                ? "已恢复待核对的采集；可用同一命令检查保存结果。"
                : "已恢复上次未保存的采集。",
            );
          }
          setRestored(true);
        }
      })
      .catch(() => {
        if (active) {
          setError("无法恢复采集，请重新打开插件后重试。");
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!restored) return;
    persistence.current = persistence.current
      .then(() => persistCapture(capture))
      .catch(() => {
        setError("采集暂未保存在浏览器，请保持窗口打开后重试。");
      });
  }, [capture, restored]);
  useEffect(() => {
    let active = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const status = z
          .object({
            connected: z.boolean().optional(),
            uiConnected: z.boolean().optional(),
            enabled: z.boolean().optional(),
            connectionState: z
              .enum(["connecting", "offline", "connected"])
              .optional(),
            endpoint: z.string().optional(),
            draftWriteBlocked: z.boolean().optional(),
            draftWriteBlockedReason: z.string().nullable().optional(),
            mode: z.enum(["managed", "standalone"]).optional(),
          })
          .parse(await message("MCP_STATUS"));
        if (active && status.mode) setMode(status.mode);
        if (!active) return;
        setReady(status.uiConnected === true);
        setOffline(
          status.enabled === true &&
            (status.connectionState === "offline" ||
              (status.connected === true && !status.uiConnected)),
        );
        setWriteBlock(
          status.draftWriteBlocked
            ? (status.draftWriteBlockedReason ??
                "草稿写入暂停，请核对已有结果。")
            : "",
        );
        setConnection(
          status.uiConnected
            ? "工作台已连接"
            : status.connected
              ? "任务助手已离线 · 草稿通道仍连接 · 正在自动重试"
              : status.enabled
                ? status.connectionState === "offline"
                  ? `工作台已离线${status.endpoint ? ` · ${status.endpoint}` : ""} · 正在自动重试`
                  : "正在连接工作台"
                : "尚未连接工作台",
        );
        if (status.uiConnected) {
          const info = z
            .object({
              workbenchOrigin: z.string().url(),
              extensionRelease: extensionReleaseSchema.optional(),
            })
            .parse(await rpc("status"));
          const url = new URL(info.workbenchOrigin);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error("工作台地址无效。");
          if (active) {
            setOrigin(url.origin);
            setRelease(info.extensionRelease);
          }
        }
      } catch {
        if (active) {
          setReady(false);
          setOffline(true);
          setConnection("连接暂不可用，请检查连接设置。");
        }
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const loadDeliveries = useCallback(async () => {
    const result = deliveriesSchema.parse(
      await rpc("deliveries.list", {
        ...(deliveryCursor ? { cursor: deliveryCursor } : {}),
      }),
    );
    setDeliveries(result.items);
    setNextDeliveryCursor(result.nextCursor ?? null);
    setRequested(
      (current) =>
        new Set(
          [...current].filter((id) =>
            result.items.some(
              (item) => item.id === id && item.status === "scheduled",
            ),
          ),
        ),
    );
  }, [deliveryCursor]);
  useEffect(() => {
    if (!ready || tab !== "tasks") return;
    let active = true,
      pending = false;
    const load = async () => {
      if (pending || !active) return;
      pending = true;
      try {
        await loadDeliveries();
      } catch (failure) {
        if (active) setError(errorText(failure));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready, tab, loadDeliveries]);
  useEffect(() => {
    if (!ready || tab !== "accounts") return;
    let active = true;
    void rpc("accounts.list")
      .then((value) => {
        if (active)
          setAccounts(
            z.object({ accounts: z.array(accountSchema) }).parse(value)
              .accounts,
          );
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [ready, tab]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const open = (path = "") => {
    if (origin) void chrome.tabs.create({ url: `${origin}${path}` });
  };
  const changeCapture = (patch: Partial<CaptureSession>) =>
    setCapture((current) => ({ ...current, ...patch }));
  const readPage = () =>
    action(async () => {
      const input = z
        .object({
          title: z.string(),
          url: z.string().url(),
          excerpt: z.string(),
          selected: z.boolean(),
          truncated: z.boolean(),
        })
        .parse(await message("STUDIO_CAPTURE_PREVIEW"));
      setCapture({
        ...emptyCapture(),
        title: input.title,
        url: input.url,
        excerpt: input.excerpt,
        selected: capture.selected,
      });
      setNotice(
        input.truncated
          ? "已读取前 12,000 字，请预览后保存。"
          : input.selected
            ? "已读取选中的文本，请预览后保存。"
            : "已读取网页摘录，请预览后保存。",
      );
    });
  const save = () =>
    action(async () => {
      const url = new URL(capture.url);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) =>
          /token|secret|password|authorization|credential|signature|api.?key|^sig$|^x-(?:amz|goog)-/iu.test(
            key,
          ),
        )
      )
        throw new Error("请使用不含登录凭据的公开来源链接。");
      if (capture.url.length > 2000 || !capture.title.trim())
        throw new Error("请检查标题与来源链接。");
      const [kind, id] = capture.selected.split(":");
      const task = capture.selected ? refSchema.parse({ kind, id }) : undefined;
      const submitted = { ...capture, submitted: true };
      await persistence.current;
      await persistCapture(submitted);
      setCapture(submitted);
      await rpc("capture.create", {
        commandId: capture.commandId,
        title: capture.title,
        url: capture.url,
        excerpt: capture.excerpt,
        ...(task ? { task } : {}),
      });
      const cleared = emptyCapture();
      await persistCapture(cleared);
      setCapture(cleared);
      setNotice(
        task
          ? "已加入任务资料。可在该任务中纳入后续生产。"
          : "已保存到资料库。",
      );
    });
  const switchStandalone = () =>
    action(async () => {
      await persistence.current;
      await message("STUDIO_SET_MODE", { mode: "standalone" });
      navigate("/?mode=standalone");
    });
  const listError =
    tab === "capture" ? captureTasks.error : tab === "tasks" ? tasks.error : "";
  return (
    <div className="studio-companion">
      <header>
        <img src="/assets/icon-48.png" alt="" width="34" height="34" />
        <div>
          <h1>Content Studio</h1>
          <p role="status">{connection}</p>
        </div>
        <button disabled={!origin} onClick={() => open("/tasks")}>
          打开工作台 ↗
        </button>
      </header>
      <nav aria-label="插件功能">
        {companionTabs.map((item) => (
          <button
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {error || listError ? (
        <p role="alert" className="studio-error">
          {error || listError}
        </p>
      ) : null}
      {writeBlock ? (
        <p role="status" className="studio-notice">
          {writeBlock}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="studio-notice">
          {notice}
        </p>
      ) : null}
      {!ready ? (
        <section>
          <h2>{offline ? "恢复工作台连接" : "连接工作台"}</h2>
          {offline ? (
            <p>
              请确认本机工作台正在运行，并粘贴同一插件配对生成的最新私密连接地址。修复连接保留待核对记录，草稿写入继续暂停至核对完成。
            </p>
          ) : null}
          <ol>
            <li>在插件连接设置中启用连接，复制扩展 ID 和配对 Token。</li>
            <li>在工作台“设置 → 平台与账号”保存配对。</li>
            <li>将工作台生成的私密连接地址粘贴回插件。</li>
          </ol>
          <button className="studio-primary" onClick={() => setSettings(true)}>
            {offline ? "修复连接" : "连接设置"}
          </button>
        </section>
      ) : null}
      {tab === "capture" ? (
        <section>
          <h2>把网页资料加入任务</h2>
          <p>优先采集选中文本。未保存的摘录会在本次浏览器会话内保留。</p>
          <button
            disabled={busy || !restored || capture.submitted}
            onClick={() => void readPage()}
          >
            读取当前网页 / 选中文本
          </button>
          {capture.url ? (
            <>
              <label>
                标题
                <input
                  maxLength={300}
                  disabled={capture.submitted}
                  value={capture.title}
                  onChange={(event) =>
                    changeCapture({ title: event.target.value })
                  }
                />
              </label>
              <label>
                来源
                <input
                  type="url"
                  disabled={capture.submitted}
                  value={capture.url}
                  onChange={(event) =>
                    changeCapture({ url: event.target.value })
                  }
                />
              </label>
              <label>
                摘录
                <textarea
                  rows={5}
                  maxLength={12000}
                  disabled={capture.submitted}
                  value={capture.excerpt}
                  onChange={(event) =>
                    changeCapture({ excerpt: event.target.value })
                  }
                />
              </label>
              <label>
                搜索保存目标
                <input
                  value={captureSearch}
                  disabled={capture.submitted}
                  onChange={(event) => {
                    setCaptureSearch(event.target.value);
                    setCaptureCursor(null);
                  }}
                />
              </label>
              <label>
                保存位置
                <select
                  value={capture.selected}
                  disabled={capture.submitted}
                  onChange={(event) =>
                    changeCapture({ selected: event.target.value })
                  }
                >
                  <option value="">仅保存到资料库</option>
                  {capture.selected &&
                  !captureTasks.items.some(
                    (task) => `${task.kind}:${task.id}` === capture.selected,
                  ) ? (
                    <option value={capture.selected}>已选择的任务</option>
                  ) : null}
                  {captureTasks.items.map((task) => (
                    <option
                      key={`${task.kind}:${task.id}`}
                      value={`${task.kind}:${task.id}`}
                    >
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="studio-actions">
                {captureCursor ? (
                  <button
                    disabled={capture.submitted}
                    onClick={() => setCaptureCursor(null)}
                  >
                    回到首页
                  </button>
                ) : null}
                {captureTasks.nextCursor ? (
                  <button
                    disabled={captureTasks.loading || capture.submitted}
                    onClick={() => setCaptureCursor(captureTasks.nextCursor)}
                  >
                    更多任务
                  </button>
                ) : null}
              </div>
              {capture.submitted ? (
                <p>
                  上次保存结果待确认。再次检查使用同一命令，不会重复创建资料。
                </p>
              ) : null}
              <button
                className="studio-primary"
                disabled={!ready || busy || !capture.title.trim()}
                onClick={() => void save()}
              >
                {capture.submitted ? "检查保存结果" : "保存到任务 / 资料库"}
              </button>
              {!capture.submitted ? (
                <button
                  disabled={busy}
                  onClick={() => setCapture(emptyCapture())}
                >
                  放弃摘录
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      {tab === "tasks" ? (
        <section>
          <h2>待处理与最近草稿</h2>
          <p>这里显示当前页的草稿交付。完整发布历史在工作台的任务内查看。</p>
          {!deliveries.length ? (
            <p>暂无草稿交付。先在工作台确认内容和目标账号。</p>
          ) : (
            deliveries.map((item) => (
              <article key={item.id}>
                <strong>{item.title}</strong>
                <p>
                  {requested.has(item.id)
                    ? "已请求执行 · 等待回执"
                    : deliveryLabel(item.status, true)}
                </p>
                <button
                  disabled={!origin}
                  onClick={() =>
                    open(
                      `/tasks/${item.ref.kind}/${item.ref.id}/publish${item.episodeId ? `?episode=${item.episodeId}` : ""}`,
                    )
                  }
                >
                  查看任务与回执
                </button>
                {item.status === "scheduled" && !requested.has(item.id) ? (
                  <button
                    disabled={busy || !ready || Boolean(writeBlock)}
                    onClick={() =>
                      void action(async () => {
                        await rpc("drafts.run", { jobId: item.id });
                        setRequested(
                          (current) => new Set([...current, item.id]),
                        );
                        setNotice("已请求执行同一草稿任务，正在刷新回执。");
                        await loadDeliveries();
                      })
                    }
                  >
                    同步已确认草稿
                  </button>
                ) : null}
              </article>
            ))
          )}
          <div className="studio-actions">
            {deliveryCursor ? (
              <button onClick={() => setDeliveryCursor(null)}>回到首页</button>
            ) : null}
            {nextDeliveryCursor ? (
              <button onClick={() => setDeliveryCursor(nextDeliveryCursor)}>
                下一页草稿
              </button>
            ) : null}
          </div>
          <h3>查找任务</h3>
          <label>
            搜索任务
            <input
              value={taskSearch}
              onChange={(event) => {
                setTaskSearch(event.target.value);
                setTaskCursor(null);
              }}
            />
          </label>
          {tasks.loading ? <p role="status">正在读取任务…</p> : null}
          {tasks.items.map((task) => (
            <article key={`${task.kind}:${task.id}`}>
              <strong>{task.title}</strong>
              <p>
                {task.episodeCount} 期 ·{" "}
                {task.status === "enabled"
                  ? "计划已启用"
                  : task.status === "paused"
                    ? "计划已暂停"
                    : task.status}
              </p>
              <button
                disabled={!origin}
                onClick={() => open(`/tasks/${task.kind}/${task.id}/content`)}
              >
                管理此任务 →
              </button>
            </article>
          ))}
          <div className="studio-actions">
            {taskCursor ? (
              <button onClick={() => setTaskCursor(null)}>回到首页</button>
            ) : null}
            {tasks.nextCursor ? (
              <button
                disabled={tasks.loading}
                onClick={() => setTaskCursor(tasks.nextCursor)}
              >
                下一页任务
              </button>
            ) : null}
            <button disabled={!origin} onClick={() => open("/tasks")}>
              全部任务 ↗
            </button>
          </div>
        </section>
      ) : null}
      {tab === "accounts" ? (
        <section>
          <h2>核对当前浏览器账号</h2>
          <p>
            插件可执行公众号、知乎、B站专栏的已审核草稿。其他发布能力在工作台管理。
          </p>
          {!accounts.length ? (
            <p>暂无账号，请先在工作台添加目标账号。</p>
          ) : null}
          {accounts.map((account) => {
            const supported = ["wechat", "zhihu", "bilibili"].includes(
              account.platform,
            );
            const check = accountChecks[account.id];
            return (
              <article key={account.id}>
                <strong>
                  {platformNames[account.platform] ?? account.platform} ·{" "}
                  {account.label}
                </strong>
                <p>
                  {supported
                    ? account.boundUserId
                      ? "已绑定草稿身份 · 需要核对当前登录"
                      : "尚未绑定草稿身份"
                    : "此平台通过工作台管理发布授权"}
                </p>
                {check ? (
                  <p
                    className={check.matched ? "studio-notice" : "studio-error"}
                    role="status"
                  >
                    {check.text}
                  </p>
                ) : null}
                {supported ? (
                  <button
                    disabled={busy || !ready}
                    onClick={() =>
                      void action(async () => {
                        const result = z
                          .object({
                            isAuthenticated: z.boolean(),
                            username: z.string().nullable(),
                            matched: z.boolean(),
                            error: z.string().nullable(),
                          })
                          .parse(
                            await rpc("accounts.check", {
                              accountId: account.id,
                            }),
                          );
                        setAccountChecks((current) => ({
                          ...current,
                          [account.id]: {
                            matched: result.matched,
                            text: result.matched
                              ? `身份一致：${result.username ?? account.label}`
                              : (result.error ??
                                (result.isAuthenticated
                                  ? "当前登录身份与工作台绑定不一致，请在工作台核对。"
                                  : "请先在此 Chrome 配置中登录目标平台，再核对。")),
                          },
                        }));
                      })
                    }
                  >
                    核对账号
                  </button>
                ) : null}
              </article>
            );
          })}
          <button disabled={!origin} onClick={() => open("/settings/accounts")}>
            管理平台账号 ↗
          </button>
        </section>
      ) : null}
      <ExtensionUpdates release={release} origin={origin} />
      <footer>
        <button onClick={() => setSettings(true)}>连接设置</button>
        <button onClick={() => navigate("/about")}>关于 Content Studio</button>
      </footer>
      <details>
        <summary>高级使用模式</summary>
        <p>
          独立模式使用本地同步功能，不接受工作台任务。切换会停用工作台连接，保留配对和所有执行记录；有正在执行或待核对草稿时无法切换。
        </p>
        {mode === "standalone" ? (
          <>
            <button
              disabled={busy}
              onClick={() => navigate("/?mode=standalone")}
            >
              打开独立模式
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await message("STUDIO_SET_MODE", { mode: "managed" });
                  setMode("managed");
                  setSettings(true);
                })
              }
            >
              切换到工作台模式
            </button>
          </>
        ) : (
          <button disabled={busy} onClick={() => void switchStandalone()}>
            切换到独立模式
          </button>
        )}
      </details>
      <SettingsDrawer open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}
