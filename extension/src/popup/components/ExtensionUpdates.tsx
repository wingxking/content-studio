import { useEffect, useState } from "react";
import { z } from "zod";
import { isNewerVersion } from "../../studio/lifecycle";

export const extensionReleaseSchema = z.object({
  version: z.string(),
  downloadPath: z.literal("/downloads/content-studio-extension.zip"),
  notes: z.string().optional(),
  minCompanionProtocolVersion: z.number().int().optional(),
});
export type ExtensionRelease = z.infer<typeof extensionReleaseSchema>;
const stateSchema = z.object({
  installedVersion: z.string(),
  installType: z.string(),
  availableVersion: z.string().nullable(),
  canReload: z.boolean(),
  blockedReason: z.string().nullable(),
  preservationNotice: z.string().nullable().optional(),
  checkStatus: z.string().optional(),
});
export function ExtensionUpdates({
  release,
  origin = "",
}: {
  release?: ExtensionRelease;
  origin?: string;
}) {
  const [state, setState] = useState<z.infer<typeof stateSchema> | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const request = async (type: string) => {
    const response: unknown = await chrome.runtime.sendMessage({ type });
    if (response && typeof response === "object" && "error" in response)
      throw new Error(String(response.error));
    return response;
  };
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void request("STUDIO_UPDATE_STATUS")
        .then((value) => {
          if (active) setState(stateSchema.parse(value));
        })
        .catch(() => {
          if (active) setError("暂时无法检查安装类型，请重新打开插件。");
        });
    };
    refresh();
    const changed = () => refresh();
    chrome.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "更新未完成。");
    } finally {
      setBusy(false);
    }
  };
  const newer =
    release &&
    isNewerVersion(
      release.version,
      state?.installedVersion ?? chrome.runtime.getManifest().version,
    );
  return (
    <details
      className="studio-updates"
      open={Boolean(newer || state?.availableVersion)}
    >
      <summary>
        版本与更新 · {chrome.runtime.getManifest().version}
        {newer || state?.availableVersion ? " · 有更新" : ""}
      </summary>
      {state?.installType === "development" ? (
        <p>
          当前从本地目录加载。更新不会自动写入本地文件；请下载新版、替换原安装目录的文件，再重新加载现有插件。保留扩展条目和执行记录。
        </p>
      ) : (
        <p>
          Chrome
          会自动检查已发布的扩展更新。收到新版本后可在草稿操作完成后应用。
        </p>
      )}
      {newer ? (
        <p>
          工作台提供 {release.version}
          {release.notes ? `：${release.notes}` : ""}
        </p>
      ) : null}
      {state?.availableVersion ? (
        <p>Chrome 已准备 {state.availableVersion}，等待应用。</p>
      ) : null}
      {state?.preservationNotice ? (
        <p role="status">{state.preservationNotice}</p>
      ) : null}
      {state?.blockedReason ? <p role="status">{state.blockedReason}</p> : null}
      {newer && origin ? (
        <button
          onClick={() =>
            void chrome.tabs.create({ url: `${origin}${release.downloadPath}` })
          }
        >
          下载新版插件
        </button>
      ) : null}
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const next = stateSchema.parse(
              await request("STUDIO_CHECK_UPDATE"),
            );
            setState(next);
            setMessage(
              next.checkStatus === "unpacked"
                ? "本地目录安装请按上述步骤更新。"
                : next.checkStatus === "throttled"
                  ? "Chrome 暂时限制频繁检查，请稍后再试。"
                  : next.checkStatus === "update_available"
                    ? "Chrome 已发现新版本。"
                    : "Chrome 暂未发现可用更新。",
            );
          })
        }
      >
        检查更新
      </button>
      {state?.installType === "development" || state?.availableVersion ? (
        <button
          disabled={busy || !state.canReload}
          onClick={() =>
            void run(async () => {
              await request("STUDIO_APPLY_UPDATE");
              setMessage("正在重新加载现有插件…");
            })
          }
        >
          {state.installType === "development"
            ? "已替换文件，重新加载"
            : "应用更新"}
        </button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="studio-error">
          {error}
        </p>
      ) : null}
    </details>
  );
}
