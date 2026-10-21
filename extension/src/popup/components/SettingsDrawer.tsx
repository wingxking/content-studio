import { cn } from "@/lib/utils";
import { ChevronRight, Plug, PlugZap, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trackFeatureDiscovery } from "../../lib/analytics";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface McpStatus {
  enabled: boolean;
  connected: boolean;
  uiConnected?: boolean;
  connectionState?: "connecting" | "offline" | "connected";
  endpoint?: string;
  token?: string;
  serverUrl?: string;
}

interface CMSAccount {
  id: string;
  name: string;
  type: string;
  url: string;
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    enabled: false,
    connected: false,
  });
  const [cmsAccounts, setCmsAccounts] = useState<CMSAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [floatingButtonEnabled, setFloatingButtonEnabled] = useState(false);
  const [bridgeError, setBridgeError] = useState("");
  const [documentCheck, setDocumentCheck] = useState("");
  const [serverUrlInput, setServerUrlInput] = useState("");
  const connectionSaving = useRef(false);
  const [savingConnection, setSavingConnection] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState("");

  // 获取状态
  useEffect(() => {
    if (!open) return;

    // MCP 状态
    chrome.runtime.sendMessage({ type: "MCP_STATUS" }, (response) => {
      if (response && !response.error) {
        setMcpStatus({
          enabled: response.enabled ?? false,
          connected: response.connected ?? false,
          uiConnected: response.uiConnected ?? false,
          connectionState: response.connectionState,
          endpoint: response.endpoint,
          token: response.token,
          serverUrl: response.serverUrl,
        });
        setServerUrlInput(response.serverUrl || "");
      }
    });

    // CMS 账户
    chrome.storage.local.get("cmsAccounts", (result) => {
      setCmsAccounts(result.cmsAccounts || []);
    });

    // 悬浮按钮设置
    chrome.storage.local.get("floatingButtonEnabled", (result) => {
      setFloatingButtonEnabled(result.floatingButtonEnabled ?? false);
    });
  }, [open]);

  // MCP 状态轮询 + 通知 background 加速重连
  useEffect(() => {
    if (!open || !mcpStatus.enabled) return;

    // 通知 background：用户正在关注，加速重连
    chrome.runtime.sendMessage({ type: "MCP_WATCH_START" });

    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: "MCP_STATUS" }, (response) => {
        if (response && !response.error) {
          setMcpStatus((prev) => ({
            ...prev,
            connected: response.connected ?? false,
            uiConnected: response.uiConnected ?? false,
            connectionState: response.connectionState,
            endpoint: response.endpoint,
          }));
        }
      });
    }, 3000);

    return () => {
      clearInterval(interval);
      // 设置页关闭，恢复正常重连策略
      chrome.runtime.sendMessage({ type: "MCP_WATCH_STOP" });
    };
  }, [open, mcpStatus.enabled]);

  // 切换 MCP
  const toggleMcp = async () => {
    setLoading(true);
    const action = mcpStatus.enabled ? "MCP_DISABLE" : "MCP_ENABLE";

    // 追踪 MCP 功能发现
    if (!mcpStatus.enabled) {
      trackFeatureDiscovery("mcp", "settings").catch(() => {});
    }

    chrome.runtime.sendMessage({ type: action }, (response) => {
      setLoading(false);
      if (response?.success) {
        setMcpStatus((prev) => ({
          ...prev,
          enabled: !prev.enabled,
          connected: false,
          token: response.token, // 保存返回的 token
        }));
      } else setBridgeError(response?.error || "连接设置未保存，请稍后重试。");
    });
  };

  // Explicit submission avoids applying partially typed private URLs.
  const saveConnection = () => {
    if (connectionSaving.current) return;
    connectionSaving.current = true;
    setSavingConnection(true); setBridgeError(""); setConnectionNotice("");
    const value = serverUrlInput.trim();
    chrome.runtime.sendMessage({type: "MCP_SET_SERVER_URL", payload: {url:value}}, response => {
      connectionSaving.current = false; setSavingConnection(false);
      if (chrome.runtime.lastError || response?.error || !response?.success) {
        setBridgeError(response?.error || "连接地址未保存，请确认工作台提供的地址后重试。");
        return;
      }
      setMcpStatus(previous=>({...previous,serverUrl:value}));
      setConnectionNotice(response.notice || "连接地址已保存，正在连接工作台。");
    });
  };

  // 切换悬浮按钮
  const toggleFloatingButton = () => {
    const next = !floatingButtonEnabled;
    setFloatingButtonEnabled(next);
    chrome.storage.local.set({ floatingButtonEnabled: next });
  };

  // 删除 CMS 账户
  const deleteCmsAccount = async (id: string) => {
    // 直接从 storage 读取最新数据，避免多窗口操作时覆盖
    const storage = await chrome.storage.local.get("cmsAccounts");
    const accounts: CMSAccount[] = storage.cmsAccounts || [];
    const updated = accounts.filter((a) => a.id !== id);
    await chrome.storage.local.set({ cmsAccounts: updated });
    await chrome.storage.local.remove(`cms_pwd_${id}`);
    setCmsAccounts(updated);
  };

  if (!open) return null;

  return (
    <>
      {/* 遮罩 */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* 抽屉 */}
      <div
        className={cn(
          "fixed inset-y-0 right-0 w-80 bg-background z-50 shadow-xl",
          "transform transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">连接与高级设置</h2>
          <button aria-label="关闭连接设置" onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 space-y-6 overflow-y-auto h-[calc(100%_-_57px)]">
          {/* 同步桥接设置 */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              工作台连接
            </h3>

            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                {mcpStatus.connected ? (
                  <PlugZap className="w-5 h-5 text-green-500" />
                ) : (
                  <Plug className="w-5 h-5 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">工作台连接</p>
                  <p className="text-xs text-muted-foreground">
                    {mcpStatus.enabled
                      ? mcpStatus.uiConnected
                        ? "工作台已连接"
                        : mcpStatus.connectionState === "offline"
                          ? "工作台已离线 · 正在自动重试"
                          : mcpStatus.connected
                            ? "任务助手已离线 · 草稿通道仍连接"
                            : "正在连接…"
                      : "未启用"}
                  </p>
                </div>
              </div>

              <button
                onClick={toggleMcp}
                role="switch"
                aria-label="工作台连接"
                aria-checked={mcpStatus.enabled}
                disabled={loading}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors",
                  mcpStatus.enabled ? "bg-primary" : "bg-muted-foreground/30",
                  loading && "opacity-50",
                )}
              >
                <span
                  className={cn(
                    "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                    mcpStatus.enabled ? "translate-x-6" : "translate-x-1",
                  )}
                />
              </button>
            </div>

            {bridgeError && (
              <p role="alert" className="text-xs text-red-500">
                {bridgeError}
              </p>
            )}
            {mcpStatus.enabled && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  连接后，可采集资料、核对账号，并执行工作台已审核的公众号、知乎和B站专栏草稿。
                  {mcpStatus.connectionState === "offline"
                    ? " 请确认工作台运行，并更新下方同一插件配对的私密连接地址；修复会保留全部待核对记录。"
                    : ""}
                </p>
                <button
                  className="border rounded p-2 text-xs"
                  onClick={() => {
                    setDocumentCheck("正在检查本地文档处理…");
                    chrome.runtime.sendMessage(
                      { type: "MCP_CHECK_DOCUMENT" },
                      (response) => {
                        setDocumentCheck(
                          !chrome.runtime.lastError && response?.success
                            ? "本地文档处理通过；未访问或写入平台。"
                            : "本地文档处理失败，请重载扩展后重试；未写入平台。",
                        );
                      },
                    );
                  }}
                >
                  检查本地草稿环境
                </button>
                {documentCheck && (
                  <p role="status" className="text-xs">
                    {documentCheck}
                  </p>
                )}
                {mcpStatus.token && (
                  <div className="p-2 bg-muted/50 rounded text-xs">
                    <p className="text-muted-foreground mb-1">
                      扩展 ID：{chrome.runtime.id}
                      <br />
                      Token:
                    </p>
                    <input
                      type="password"
                      aria-label="扩展配对 Token"
                      readOnly
                      value={mcpStatus.token}
                      className="w-full bg-background p-1.5 rounded"
                    />
                    <button
                      className="mt-2"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(mcpStatus.token ?? "")
                          .then(() => setBridgeError(""))
                          .catch(() =>
                            setBridgeError(
                              "复制失败，请选中密钥输入框后复制。",
                            ),
                          );
                      }}
                    >
                      复制配对 Token
                    </button>
                  </div>
                )}
                <form className="p-2 bg-muted/50 rounded text-xs" onSubmit={event=>{event.preventDefault();saveConnection();}}>
                  <p className="text-muted-foreground mb-1">
                    工作台提供的私密连接地址：
                  </p>
                  <input
                    type="password"
                    aria-label="服务器私密连接地址"
                    value={serverUrlInput}
                    onChange={(event) => {setServerUrlInput(event.target.value);setConnectionNotice("");}}
                    disabled={savingConnection}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="粘贴工作台提供的私密连接地址"
                    className="w-full bg-background p-1.5 rounded border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button type="submit" disabled={savingConnection || !serverUrlInput.trim()} className="mt-2 border rounded p-2">{savingConnection ? "正在保存…" : "保存连接地址"}</button>
                  {connectionNotice ? <p role="status" className="mt-2">{connectionNotice}</p> : null}
                </form>
              </div>
            )}
          </div>

          <details>
            <summary className="text-sm cursor-pointer">
              独立模式高级功能
            </summary>
            <p className="text-xs text-muted-foreground mt-2">
              这些功能供独立同步使用。工作台模式通过任务管理资料与发布。
            </p>
            {/* 悬浮同步按钮 */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground">
                网页功能
              </h3>

              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">悬浮同步按钮</p>
                  <p className="text-xs text-muted-foreground">
                    在网页右下角显示快捷同步按钮
                  </p>
                </div>
                <button
                  onClick={toggleFloatingButton}
                  className={cn(
                    "relative w-11 h-6 rounded-full transition-colors",
                    floatingButtonEnabled
                      ? "bg-primary"
                      : "bg-muted-foreground/30",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                      floatingButtonEnabled ? "translate-x-6" : "translate-x-1",
                    )}
                  />
                </button>
              </div>
            </div>

            {/* CMS 账户 */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">
                  自建站点
                </h3>
                <button
                  onClick={() => {
                    onClose();
                    window.location.hash = "/add-cms";
                  }}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="w-3 h-3" />
                  添加
                </button>
              </div>

              {cmsAccounts.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  暂无自建站点
                </p>
              ) : (
                <div className="space-y-2">
                  {cmsAccounts.map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {account.name}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {account.url}
                        </p>
                      </div>
                      <button
                        onClick={() => deleteCmsAccount(account.id)}
                        className="p-1 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 历史记录 */}
            <div className="space-y-3">
              <button
                onClick={() => {
                  onClose();
                  window.location.hash = "/history";
                }}
                className="flex items-center justify-between w-full p-3 bg-muted/50 rounded-lg hover:bg-muted"
              >
                <span className="text-sm font-medium">查看全部历史</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
