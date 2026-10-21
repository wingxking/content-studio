import { z } from "zod";
import {
  isStudioUrl,
  validateMcpUrl,
  studioJournalKey as journalKey,
} from "./protocol";
import { hasUnresolvedJournal } from "./journal";

export type StudioMode = "managed" | "standalone";
export function configuredMode(config: Record<string, unknown>): StudioMode {
  if (config.studioMode === "standalone" || config.studioMode === "managed")
    return config.studioMode;
  try {
    return typeof config.mcpServerUrl === "string" &&
      isStudioUrl(config.mcpServerUrl)
      ? "managed"
      : "standalone";
  } catch {
    return "managed";
  }
}

export type LifecycleSafety = {
  safe: boolean;
  reason: string | null;
  notice?: string;
};

// Maintenance preserves the journal exactly, even when older data cannot be
// parsed. Storage failures and real execution still prohibit interruption.
export async function readMaintenanceSafety(
  executing = false,
): Promise<LifecycleSafety> {
  try {
    const state = await chrome.storage.local.get([
      journalKey,
      "activeSyncState",
    ]);
    if (executing || state.activeSyncState?.status === "syncing")
      return {
        safe: false,
        reason: "正在执行草稿操作，请完成后再修复连接或更新。",
      };
    return {
      safe: true,
      reason: null,
      ...(hasUnresolvedJournal(state[journalKey])
        ? {
            notice:
              "更新保留待核对记录，草稿写入继续暂停。请在工作台核对原有结果。",
          }
        : {}),
    };
  } catch {
    return {
      safe: false,
      reason: "无法读取持久执行记录，暂不能修复连接或更新。请稍后重试。",
    };
  }
}

export async function readLifecycleSafety(
  executing = false,
): Promise<LifecycleSafety> {
  const safety = await readMaintenanceSafety(executing);
  if (!safety.safe) return safety;
  return safety.notice
    ? {
        safe: false,
        reason:
          "草稿写入已暂停：有草稿结果待核对或记录异常。请先在工作台核对，原记录会继续保留。",
      }
    : safety;
}

export async function readConnectionChangeSafety(
  config: Record<string, unknown>,
  url: string,
  executing = false,
): Promise<LifecycleSafety> {
  let next: string;
  try {
    next = validateMcpUrl(url);
  } catch {
    return {
      safe: false,
      reason: "地址未保存：请使用工作台提供的本机私密连接地址。",
    };
  }
  if (configuredMode(config) === "managed") {
    if (!isStudioUrl(next))
      return {
        safe: false,
        reason: "托管模式只能连接工作台。切换独立模式必须先核对所有草稿结果。",
      };
    try {
      if (
        typeof config.mcpServerUrl === "string" &&
        isStudioUrl(validateMcpUrl(config.mcpServerUrl))
      )
        return readMaintenanceSafety(executing);
    } catch {
      /* Initial pairing still requires the strict lifecycle guard. */
    }
  }
  return readLifecycleSafety(executing);
}

export type UpdateState = {
  installedVersion: string;
  installType: string;
  availableVersion: string | null;
  canReload: boolean;
  blockedReason: string | null;
  preservationNotice: string | null;
};
const updateKey = "contentStudioPendingUpdate";
const versionSchema = z.string().regex(/^\d+(?:\.\d+){0,3}$/);
export function isNewerVersion(next: string, current: string): boolean {
  if (
    !versionSchema.safeParse(next).success ||
    !versionSchema.safeParse(current).success
  )
    return false;
  const a = next.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
export async function recordAvailableUpdate(version: string): Promise<void> {
  if (isNewerVersion(version, chrome.runtime.getManifest().version))
    await chrome.storage.local.set({ [updateKey]: version });
}
export async function extensionUpdateState(
  executing = false,
): Promise<UpdateState> {
  const [info, state, safety] = await Promise.all([
    chrome.management.getSelf(),
    chrome.storage.local.get(updateKey),
    readMaintenanceSafety(executing),
  ]);
  const installedVersion = chrome.runtime.getManifest().version;
  const pending = state[updateKey];
  return {
    installedVersion,
    installType: info.installType,
    availableVersion:
      typeof pending === "string" && isNewerVersion(pending, installedVersion)
        ? pending
        : null,
    canReload: safety.safe,
    blockedReason: safety.reason,
    preservationNotice: safety.notice ?? null,
  };
}
export async function requestExtensionUpdate(
  executing = false,
): Promise<UpdateState & { checkStatus: string }> {
  const state = await extensionUpdateState(executing);
  if (state.installType === "development")
    return { ...state, checkStatus: "unpacked" };
  const result = await chrome.runtime.requestUpdateCheck();
  if (result.status === "update_available" && result.version)
    await recordAvailableUpdate(result.version);
  return {
    ...(await extensionUpdateState(executing)),
    checkStatus: result.status,
  };
}
