import { configuredMode } from "./lifecycle";

// Retain the existing id so an upgrade replaces its own menu, not another item.
export const contextMenuId = "wechatsync-open-editor";
let pending = Promise.resolve();
export function ensureContextMenu(): Promise<void> {
  const initialize = async () => {
    await new Promise<void>((resolve) => {
      chrome.contextMenus.remove(contextMenuId, () => {
        // A first installation has no previous item.
        void chrome.runtime.lastError;
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      chrome.contextMenus.create(
        {
          id: contextMenuId,
          title: "Content Studio - 打开内容助手",
          contexts: ["page", "selection"],
        },
        () => {
          const failure = chrome.runtime.lastError;
          if (failure)
            reject(new Error("Content Studio menu initialization failed"));
          else resolve();
        },
      );
    });
  };
  pending = pending.catch(() => {}).then(initialize);
  return pending;
}

export async function openManagedAssistant(): Promise<boolean> {
  const config = await chrome.storage.local.get(["studioMode", "mcpServerUrl"]);
  if (configuredMode(config) !== "managed") return false;
  const popup = chrome.runtime.getManifest().action?.default_popup;
  if (!popup) throw new Error("Content Studio assistant unavailable");
  await chrome.tabs.create({ url: chrome.runtime.getURL(popup) });
  return true;
}
