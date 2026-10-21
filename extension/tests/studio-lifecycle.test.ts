import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configuredMode,
  extensionUpdateState,
  readLifecycleSafety,
  readMaintenanceSafety,
  readConnectionChangeSafety,
  recordAvailableUpdate,
  requestExtensionUpdate,
} from "../src/studio/lifecycle";
import {
  emptyCapture,
  persistCapture,
  restoreCapture,
} from "../src/studio/capture-session";
import { studioJournalKey } from "../src/studio/protocol";

const local: Record<string, unknown> = {},
  session: Record<string, unknown> = {};
let installType = "normal";
let installedVersion = "2.0.12";
const check = vi.fn(async () => ({
  status: "update_available",
  version: "2.0.13",
}));
function storage(values: Record<string, unknown>) {
  return {
    get: async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]),
      ),
    set: async (patch: Record<string, unknown>) => {
      Object.assign(values, structuredClone(patch));
    },
  };
}
beforeEach(() => {
  Object.keys(local).forEach((key) => delete local[key]);
  Object.keys(session).forEach((key) => delete session[key]);
  installType = "normal";
  installedVersion = "2.0.12";
  check.mockClear();
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: installedVersion }),
      requestUpdateCheck: check,
    },
    management: { getSelf: async () => ({ installType }) },
    storage: { local: storage(local), session: storage(session) },
  });
});
afterEach(() => vi.unstubAllGlobals());
it("restores the exact capture command and frozen payload after a popup closes during save", async () => {
  const draft = {
    ...emptyCapture(),
    title: "Example",
    url: "https://example.com/page",
    excerpt: "Evidence",
    selected: "plan:18eb8b3a-69af-4711-93fb-e12365978255",
    submitted: true,
  };
  await persistCapture(draft);
  expect(await restoreCapture()).toEqual(draft);
  const cleared = emptyCapture();
  await persistCapture(cleared);
  expect((await restoreCapture())?.commandId).not.toBe(draft.commandId);
});
it("separates an explicit standalone mode from a retained Studio pairing", () => {
  const configured = {
    mcpServerUrl: "ws://localhost:19527/connect?key=" + "p".repeat(40),
    mcpEnabled: false,
  };
  expect(configuredMode(configured)).toBe("managed");
  expect(configuredMode({ ...configured, studioMode: "standalone" })).toBe(
    "standalone",
  );
});
it("keeps mode switches strict while maintenance preserves unknown and malformed journals", async () => {
  local[studioJournalKey] = { job: { status: "started" } };
  expect((await readLifecycleSafety()).safe).toBe(false);
  expect(local[studioJournalKey]).toEqual({ job: { status: "started" } });
  expect((await readMaintenanceSafety()).safe).toBe(true);
  expect((await extensionUpdateState()).preservationNotice).toContain(
    "草稿写入继续暂停",
  );
  delete local[studioJournalKey];
  expect((await readLifecycleSafety()).safe).toBe(true);
  expect((await readLifecycleSafety(true)).safe).toBe(false);
  local[studioJournalKey] = "corrupt";
  expect((await readLifecycleSafety()).safe).toBe(false);
  expect((await readMaintenanceSafety()).safe).toBe(true);
  expect(local[studioJournalKey]).toBe("corrupt");
});
it("uses Chrome update checks only for installed packages, never to update unpacked files", async () => {
  installType = "development";
  expect((await requestExtensionUpdate()).checkStatus).toBe("unpacked");
  expect(check).not.toHaveBeenCalled();
  installType = "normal";
  expect((await requestExtensionUpdate()).availableVersion).toBe("2.0.13");
  expect(check).toHaveBeenCalledOnce();
});
it("records Chrome update events and clears stale version display after an installed upgrade", async () => {
  await recordAvailableUpdate("2.0.13");
  expect((await extensionUpdateState()).availableVersion).toBe("2.0.13");
  await recordAvailableUpdate("2.0.9");
  expect((await extensionUpdateState()).availableVersion).toBe("2.0.13");
  installedVersion = "2.0.13";
  expect((await extensionUpdateState()).availableVersion).toBeNull();
});

it("allows only idle managed-to-managed recovery without modifying unknown or corrupt records", async () => {
  const previous = "ws://localhost:19528/connect?key=" + "p".repeat(40);
  const next = "ws://127.0.0.1:19527/connect?key=" + "n".repeat(40);
  const config = { studioMode: "managed", mcpServerUrl: previous };
  for (const journal of [{ job: { status: "started" } }, "corrupt", null]) {
    local[studioJournalKey] = journal;
    const snapshot = structuredClone(local);
    expect((await readConnectionChangeSafety(config, next)).safe).toBe(true);
    expect(
      (await readConnectionChangeSafety(config, "ws://localhost:9527")).safe,
    ).toBe(false);
    expect((await readConnectionChangeSafety(config, "")).safe).toBe(false);
    expect((await readConnectionChangeSafety(config, next, true)).safe).toBe(
      false,
    );
    expect(
      (
        await readConnectionChangeSafety(
          { ...config, studioMode: "standalone" },
          next,
        )
      ).safe,
    ).toBe(false);
    expect(local).toEqual(snapshot);
  }
  local.activeSyncState = { status: "syncing" };
  expect((await readMaintenanceSafety()).safe).toBe(false);
  expect((await readConnectionChangeSafety(config, next)).safe).toBe(false);
  vi.spyOn(chrome.storage.local, "get").mockRejectedValue(
    new Error("storage read failed"),
  );
  expect((await readMaintenanceSafety()).safe).toBe(false);
  expect((await readConnectionChangeSafety(config, next)).safe).toBe(false);
});
