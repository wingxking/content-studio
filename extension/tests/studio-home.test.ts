import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import { captureSessionKey } from "../src/studio/capture-session";
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../src/popup/components/SettingsDrawer", () => ({
  SettingsDrawer: () => null,
}));
import { StudioHome } from "../src/popup/pages/StudioHome";

const taskId = "81036c04-ddff-4796-a17c-30a763c18298",
  jobId = "7d6eedaa-cf1c-4a26-8c0a-a049dcf0786c",
  commandId = "c960618b-0bca-424e-906d-4658b5307cf5";
const session: Record<string, unknown> = {};
const calls: Array<{
  type: string;
  payload?: { method: string; data: Record<string, unknown> };
}> = [];
let root: Root,
  container: HTMLElement,
  deliveryStatus = "scheduled";
let offline = false;
let writeBlocked = false;
let companionOffline = false;
beforeEach(async () => {
  vi.useFakeTimers();
  calls.length = 0;
  offline = false;
  writeBlocked = false;
  companionOffline = false;
  deliveryStatus = "scheduled";
  Object.keys(session).forEach((key) => delete session[key]);
  const { window } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const listeners = { addListener() {}, removeListener() {} };
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "2.0.12" }),
      sendMessage: async (message: {
        type: string;
        payload?: { method: string; data: Record<string, unknown> };
      }) => {
        calls.push(message);
        if (message.type === "MCP_STATUS")
          return {
            enabled: true,
            connected: !offline,
            uiConnected: !offline && !companionOffline,
            draftWriteBlocked: writeBlocked,
            draftWriteBlockedReason: writeBlocked
              ? "草稿写入已暂停：有草稿结果待核对或记录异常。"
              : null,
            connectionState: offline ? "offline" : "connected",
            endpoint: "ws://localhost:19528",
            mode: "managed",
          };
        if (message.type === "STUDIO_UPDATE_STATUS")
          return {
            installedVersion: "2.0.12",
            installType: "development",
            availableVersion: null,
            canReload: true,
            blockedReason: null,
          };
        if (message.type === "STUDIO_UI_REQUEST") {
          const method = message.payload?.method,
            data = message.payload?.data;
          if (method === "status")
            return { workbenchOrigin: "http://127.0.0.1:4310" };
          if (method === "tasks.list")
            return {
              items: [
                {
                  kind: "plan",
                  id: taskId,
                  title: data?.cursor ? "第二页任务" : "第一页任务",
                  status: "paused",
                  episodeCount: 1,
                },
              ],
              nextCursor: data?.cursor ? null : "next-page",
            };
          if (method === "deliveries.list")
            return {
              items: [
                {
                  id: jobId,
                  title: "待同步文章",
                  status: deliveryStatus,
                  ref: { kind: "plan", id: taskId },
                  episodeId: null,
                },
              ],
              nextCursor: null,
            };
          if (method === "drafts.run") {
            deliveryStatus = "submitting";
            return { id: jobId, status: deliveryStatus };
          }
          if (method === "capture.create") {
            expect(session[captureSessionKey]).toMatchObject({
              commandId,
              submitted: true,
            });
            return { id: commandId };
          }
        }
        return {};
      },
    },
    tabs: { create: vi.fn() },
    storage: {
      onChanged: listeners,
      local: { get: async () => ({}) },
      session: {
        get: async (key: string) => ({ [key]: session[key] }),
        set: async (value: Record<string, unknown>) => {
          Object.assign(session, structuredClone(value));
        },
      },
    },
  });
  container = window.document.getElementById("root") as unknown as HTMLElement;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(createElement(StudioHome)));
  await act(async () => vi.advanceTimersByTimeAsync(250));
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  );
  expect(button).toBeTruthy();
  await act(async () =>
    button!.dispatchEvent(new window.Event("click", { bubbles: true })),
  );
}
it("restores and confirms the same capture command after closing the popup during a save", async () => {
  session[captureSessionKey] = {
    commandId,
    title: "保存中的资料",
    url: "https://example.com/source",
    excerpt: "Same evidence",
    selected: `plan:${taskId}`,
    submitted: true,
  };
  await mount();
  expect(container.textContent).toContain("已恢复待核对的采集");
  await click("检查保存结果");
  expect(
    calls.find((item) => item.payload?.method === "capture.create")?.payload
      ?.data,
  ).toMatchObject({
    commandId,
    title: "保存中的资料",
    task: { kind: "plan", id: taskId },
  });
  expect(container.textContent).toContain("已加入任务资料");
  expect(session[captureSessionKey]).toMatchObject({
    title: "",
    submitted: false,
  });
});
it("pages task lookup and refreshes a submitted draft instead of leaving its submit button active", async () => {
  await mount();
  await click("待处理");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(container.textContent).toContain("第一页任务");
  await click("下一页任务");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(container.textContent).toContain("第二页任务");
  expect(
    calls.some(
      (item) =>
        item.payload?.method === "tasks.list" &&
        item.payload.data.cursor === "next-page",
    ),
  ).toBe(true);
  await click("同步已确认草稿");
  expect(container.textContent).toContain("提交中");
  expect(
    [...container.querySelectorAll("button")].some(
      (item) => item.textContent === "同步已确认草稿",
    ),
  ).toBe(false);
  deliveryStatus = "draft_saved";
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.textContent).toContain("草稿已保存 · 未公开");
});

it("shows an offline endpoint and a recovery entry instead of claiming indefinite connection progress", async () => {
  offline = true;
  await mount();
  expect(container.textContent).toContain(
    "工作台已离线 · ws://localhost:19528",
  );
  expect(container.textContent).toContain("修复连接");
  expect(container.textContent).not.toContain("正在连接工作台");
  offline = false;
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.textContent).toContain("工作台已连接");
});

it("keeps unresolved-journal warnings visible while connected and prevents new draft requests", async () => {
  writeBlocked = true;
  await mount();
  expect(container.textContent).toContain("工作台已连接");
  const warning = [...container.querySelectorAll("p")].find((item) =>
    item.textContent?.includes("草稿写入已暂停"),
  );
  expect(warning).toBeTruthy();
  expect(warning!.closest("details")).toBeNull();
  await click("待处理");
  await act(async () => vi.advanceTimersByTimeAsync(250));
  const submit = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === "同步已确认草稿",
  );
  expect(submit?.hasAttribute("disabled")).toBe(true);
  expect(calls.some((item) => item.payload?.method === "drafts.run")).toBe(
    false,
  );
});
it("offers recovery when only the companion channel is offline", async () => {
  companionOffline = true;
  await mount();
  expect(container.textContent).toContain("任务助手已离线 · 草稿通道仍连接");
  expect(container.textContent).toContain("修复连接");
});
