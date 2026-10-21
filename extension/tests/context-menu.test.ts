import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  contextMenuId,
  ensureContextMenu,
  openManagedAssistant,
} from "../src/studio/context-menu";

const menus = new Map<string, { title?: string }>();
const createTab = vi.fn(async () => ({}));
let managed = true;
beforeEach(() => {
  managed = true;
  menus.clear();
  menus.set(contextMenuId, { title: "旧菜单" });
  createTab.mockClear();
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined,
      getManifest: () => ({
        action: { default_popup: "src/popup/index.html" },
      }),
      getURL: (path: string) => `chrome-extension://fixture/${path}`,
    },
    storage: {
      local: {
        get: async () => ({ studioMode: managed ? "managed" : "standalone" }),
      },
    },
    tabs: { create: createTab },
    contextMenus: {
      remove: (id: string, callback: () => void) => {
        menus.delete(id);
        queueMicrotask(callback);
      },
      create: (
        details: { id: string; title: string },
        callback: () => void,
      ) => {
        if (menus.has(details.id)) throw new Error("duplicate-id");
        menus.set(details.id, details);
        queueMicrotask(callback);
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

it("replaces its old menu idempotently even when install and update initialization overlap", async () => {
  menus.set("unrelated-menu", { title: "Unrelated" });
  await Promise.all([
    ensureContextMenu(),
    ensureContextMenu(),
    ensureContextMenu(),
  ]);
  expect(menus.size).toBe(2);
  expect(menus.get(contextMenuId)?.title).toBe("Content Studio - 打开内容助手");
  expect(menus.get("unrelated-menu")?.title).toBe("Unrelated");
});

it("routes managed context and floating actions only to the assistant, with no page/editor or account APIs", async () => {
  expect(await openManagedAssistant()).toBe(true);
  expect(createTab).toHaveBeenCalledOnce();
  expect(createTab).toHaveBeenCalledWith({
    url: "chrome-extension://fixture/src/popup/index.html",
  });
  managed = false;
  expect(await openManagedAssistant()).toBe(false);
  expect(createTab).toHaveBeenCalledOnce();
});
