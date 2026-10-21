// Actual restored MCP client + executor + sync service + Zhihu adapter, with
// a real authenticated draft-bridge. Only platform HTTP and Chrome APIs are fixtures.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "../extension/node_modules/vitest";
import { createDraftBridge } from "../src/server/draft-bridge.ts";
import { saveDraftBridgeConfig } from "../src/core/draft-bridge-config.ts";
import { parseNativeDraftReceipt } from "../src/core/remote-drafts.ts";

const actualFetch = globalThis.fetch;
const extensionId = "a".repeat(32);
const config = {
  extensionId,
  extensionToken: "isolated-protocol-test-token",
  pairingKey: "isolated-pairing-key-".repeat(3),
  serviceKey: "isolated-service-key-".repeat(3),
};
let storage: Record<string, unknown>;
let creates: number;
let updates: string[];
let userId: string;
let changeAccount: boolean;
let documentAlreadyLoaded: boolean;
let directory: string;
let bridge: ReturnType<typeof createDraftBridge>;
let ports: { wsPort: number; httpPort: number };
let client: import("../extension/src/mcp/client").McpClient;
const input = (platform = "zhihu") => ({
  platforms: [platform],
  draftOnly: true,
  execution: {
    protocolVersion: 1 as const,
    jobId: randomUUID(),
    contentHash: "a".repeat(64),
    expectedUserId: "owner-123",
  },
  article: {
    title: "Isolated reviewed article",
    content: "<p>Approved body.</p><p>https://www.w3.org/</p>",
  },
});
async function request(method: string, params: unknown) {
  const response = await actualFetch(
    `http://127.0.0.1:${ports.httpPort}/request`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, params }),
    },
  );
  return { status: response.status, body: await response.json() };
}
async function connected() {
  const response = await actualFetch(
    `http://127.0.0.1:${ports.httpPort}/status`,
    { headers: { Authorization: `Bearer ${config.serviceKey}` } },
  );
  return (await response.json()).connected;
}
beforeEach(async () => {
  storage = { loggerConfig: { enabled: false }, mcpEnabled: false };
  creates = 0;
  updates = [];
  userId = "owner-123";
  changeAccount = false;
  documentAlreadyLoaded = true;
  const tabListeners = new Set<
    (id: number, info: { status: string }) => void
  >();
  vi.stubGlobal("chrome", {
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
      sendMessage: async (message: { type: string; targetTabId?: number; payload?: { rawHtml: string; platforms: string[] } }) => {
        if (message.type !== "STUDIO_PREPROCESS_DOCUMENT") return {};
        expect(message.targetTabId).toBe(1);
        if (changeAccount) userId = "another-user";
        const payload = message.payload!;
        return { platformContents: Object.fromEntries(payload.platforms.map(platform => [platform, { html: payload.rawHtml, markdown: "" }])) };
      },
    },
    storage: {
      local: {
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            (typeof keys === "string" ? [keys] : keys).map((key) => [
              key,
              structuredClone(storage[key]),
            ]),
          ),
        set: async (value: Record<string, unknown>) => {
          Object.assign(storage, structuredClone(value));
        },
        remove: async (key: string) => {
          delete storage[key];
        },
      },
    },
    cookies: {
      getAll: async () => [{ name: "bili_jct", value: "fixture-csrf" }],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    declarativeNetRequest: {
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      HeaderOperation: { SET: "set" },
      updateDynamicRules: async () => {},
    },
    windows: {
      create: async () => {
        setTimeout(() => {
          for (const listener of tabListeners)
            listener(1, { status: "complete" });
        }, 0);
        return {
          id: 1,
          tabs: [
            { id: 1, status: documentAlreadyLoaded ? "complete" : "loading" },
          ],
        };
      },
      remove: async () => {},
    },
    tabs: {
      get: async () => ({ id: 1, status: "complete" }),
      onUpdated: {
        addListener: (
          listener: (id: number, info: { status: string }) => void,
        ) => tabListeners.add(listener),
        removeListener: (
          listener: (id: number, info: { status: string }) => void,
        ) => tabListeners.delete(listener),
      },
      query: async () => [{ id: 1, url: "https://fixture.invalid/" }],
      sendMessage: async (
        _id: number,
        message: { payload: { rawHtml: string; platforms: string[] } },
      ) => {
        throw new Error("tabs.sendMessage cannot reach extension documents");
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const value = String(url);
      if (value === "https://mp.weixin.qq.com/")
        return new Response(
          `data: { t: 'fixture-token' }; user_name: '${userId}'; nick_name: 'Fixture owner'; ticket: 'fixture-ticket'; time: '123456';`,
        );
      if (value.startsWith("https://api.bilibili.com/x/web-interface/nav?"))
        return Response.json({
          code: 0,
          data: { isLogin: true, mid: userId, uname: "Fixture owner" },
        });
      if (
        (value.startsWith("https://mp.weixin.qq.com/cgi-bin/operate_appmsg?") ||
          value ===
            "https://api.bilibili.com/x/article/creative/draft/addupdate") &&
        options?.method === "POST"
      ) {
        creates++;
        updates.push(String(options.body));
        return Response.json({
          appMsgId: String(8000 + creates),
          code: 0,
          data: { aid: 8000 + creates },
        });
      }
      if (value === "https://www.zhihu.com/api/v4/me")
        return Response.json({ id: userId, name: "Fixture owner" });
      if (
        value === "https://zhuanlan.zhihu.com/api/articles/drafts" &&
        options?.method === "POST"
      ) {
        creates++;
        return Response.json({ id: String(8000 + creates) });
      }
      if (
        /^https:\/\/zhuanlan\.zhihu\.com\/api\/articles\/\d+\/draft$/.test(
          value,
        ) &&
        options?.method === "PATCH"
      ) {
        updates.push(String(options.body));
        return new Response(null, { status: 204 });
      }
      throw new Error(
        "Unexpected external network request in isolated integration test",
      );
    },
  );
  class ExtensionSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { origin: `chrome-extension://${extensionId}` });
    }
  }
  vi.stubGlobal("WebSocket", ExtensionSocket);
  directory = await mkdtemp(join(tmpdir(), "studio-extension-roundtrip-"));
  const configPath = join(directory, "config.json");
  await saveDraftBridgeConfig(config, configPath);
  bridge = createDraftBridge({
    configPath,
    host: "127.0.0.1",
    wsPort: 0,
    httpPort: 0,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 1500,
  });
  ports = await bridge.start();
  const { McpClient } = await import("../extension/src/mcp/client");
  client = new McpClient();
  client.setToken(config.extensionToken);
  client.setServerUrl(
    `ws://127.0.0.1:${ports.wsPort}/connect?key=${config.pairingKey}`,
  );
  client.connect();
  await vi.waitFor(async () => expect(await connected()).toBe(true));
});
afterEach(async () => {
  client?.disconnect();
  await bridge?.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["zhihu", "weixin", "bilibili"] as const)(
  "completes a real %s adapter/gateway roundtrip and returns a job-bound editor receipt",
  async (platform) => {
    const auth = await request("checkAuth", { platform });
    expect(auth.status).toBe(200);
    expect(auth.body.result.userId).toBe("owner-123");
    const payload = input(platform);
    const result = await request("syncArticle", payload);
    expect(result.status).toBe(200);
    expect(creates).toBe(1);
    expect(updates).toHaveLength(1);
    expect(decodeURIComponent(updates[0])).toContain("https://www.w3.org/");
    const nativePlatform = platform === "weixin" ? "wechat" : platform;
    const url =
      platform === "weixin"
        ? "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=8001"
        : platform === "bilibili"
          ? "https://member.bilibili.com/platform/upload/text/edit?aid=8001"
          : "https://zhuanlan.zhihu.com/p/8001/edit";
    expect(
      parseNativeDraftReceipt(
        nativePlatform,
        result.body.result,
        payload.execution,
      ),
    ).toEqual({
      destination: "platform",
      id: "8001",
      url,
      verification: "adapter_reported",
    });
    client.disconnect();
    await vi.waitFor(async () => expect(await connected()).toBe(false));
    const { McpClient } = await import("../extension/src/mcp/client");
    client = new McpClient();
    client.setToken(config.extensionToken);
    client.setServerUrl(
      `ws://127.0.0.1:${ports.wsPort}/connect?key=${config.pairingKey}`,
    );
    client.connect();
    await vi.waitFor(async () => expect(await connected()).toBe(true));
    const replay = await request("syncArticle", payload);
    expect(replay).toEqual(result);
    expect(creates).toBe(1);
  },
);

it("rechecks the account after preprocessing and never creates a draft for a switched login", async () => {
  changeAccount = true;
  const result = await request("syncArticle", input());
  expect(result.status).toBe(502);
  expect(creates).toBe(0);
  expect(updates).toHaveLength(0);
});

it("keeps a created but interrupted draft uncertain across connection and executor restarts", async () => {
  const payload = input();
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith("/draft") && options?.method === "PATCH")
        throw new Error("Simulated transport loss after creation");
      return original(url, options);
    },
  );
  expect((await request("syncArticle", payload)).status).toBe(502);
  expect(creates).toBe(1);
  client.disconnect();
  await vi.waitFor(async () => expect(await connected()).toBe(false));
  const { McpClient } = await import("../extension/src/mcp/client");
  client = new McpClient();
  client.setToken(config.extensionToken);
  client.setServerUrl(
    `ws://127.0.0.1:${ports.wsPort}/connect?key=${config.pairingKey}`,
  );
  client.connect();
  await vi.waitFor(async () => expect(await connected()).toBe(true));
  expect((await request("syncArticle", payload)).status).toBe(502);
  expect(creates).toBe(1);
});

it("handles a preprocessor that finishes between window creation and listener registration", async () => {
  documentAlreadyLoaded = false;
  expect((await request("syncArticle", input())).status).toBe(200);
  expect(creates).toBe(1);
  expect(updates).toHaveLength(1);
});

it("does not report a complete draft when a local image upload fails", async () => {
  const payload = input();
  payload.article.content =
    '<p>Reviewed image</p><img src="data:image/png;base64,iVBORw0KGgo=" />';
  expect((await request("syncArticle", payload)).status).toBe(502);
  expect(creates).toBe(1);
  expect(updates).toHaveLength(0);
  expect((await request("syncArticle", payload)).status).toBe(502);
  expect(creates).toBe(1);
});

it("reconciles the same original draft after a lost local receipt without a duplicate platform write", async () => {
  const payload=input();
  expect((await request("syncArticle",payload)).status).toBe(200);
  const journal=storage.contentStudioDraftJournalV1 as Record<string,{status:string;receipt?:unknown}>;
  journal[payload.execution.jobId]!.status="started";
  delete journal[payload.execution.jobId]!.receipt;
  expect((await request("studio.journal",{})).body).toEqual({result:{blocked:true,invalid:false,pending:[payload.execution.jobId]}});
  expect((await request("syncArticle",input())).status).toBe(502);
  const confirmation={request:payload,receipt:{platform:"zhihu",success:true,draftOnly:true,postId:"8001",postUrl:"https://zhuanlan.zhihu.com/p/8001/edit"}};
  expect((await request("studio.confirmReceipt",{...confirmation,request:{...payload,article:{...payload.article,title:"Changed"}}})).status).toBe(502);
  expect((await request("studio.confirmReceipt",confirmation)).status).toBe(200);
  expect((await request("studio.confirmReceipt",confirmation)).status).toBe(200);
  expect((await request("studio.journal",{})).body).toEqual({result:{blocked:false,invalid:false,pending:[]}});
  expect((await request("syncArticle",payload)).status).toBe(200);
  expect(creates).toBe(1);expect(updates).toHaveLength(1);
  expect((await request("syncArticle",input())).status).toBe(200);
  expect(creates).toBe(2);expect(updates).toHaveLength(2);
});

it.skipIf(process.env.STUDIO_CONTAINER !== "true")(
  "runs the Studio HTTP API → real Supabase/pgmq worker → real extension → draft receipt flow",
  async () => {
    const previousEnvironment = { ...process.env };
    const { loadRuntimeEnvironment } =
      await import("../src/core/runtime-env.ts");
    await loadRuntimeEnvironment();
    const { dbRequest, dbRpc } = await import("../src/core/database.ts");
    const workspaceId = randomUUID();
    const platformFetch = globalThis.fetch;
    // Allow only this container's local database and our loopback bridge/API.
    const databaseOrigin = new URL(process.env.SUPABASE_URL!).origin;
    expect(databaseOrigin).toBe("http://kong:8000");
    vi.stubGlobal(
      "fetch",
      async (url: string | URL | Request, options?: RequestInit) => {
        const value = new URL(String(url));
        if (value.origin === databaseOrigin || value.hostname === "127.0.0.1")
          return actualFetch(url, options);
        return platformFetch(url, options);
      },
    );
    process.env.STUDIO_WORKSPACE_ID = workspaceId;
    process.env.STUDIO_DATA_DIR = directory;
    process.env.STUDIO_LOCALFS_DIR = join(directory, "localfs");
    process.env.STUDIO_DRAFT_BRIDGE_CONFIG = join(directory, "config.json");
    process.env.STUDIO_DRAFT_BRIDGE_URL = `http://127.0.0.1:${ports.httpPort}`;
    process.env.STUDIO_WORKER_ROLE = "delivery";
    const { createDraft } = await import("../src/core/pipeline.ts");
    const { readState, mutateState } = await import("../src/core/store.ts");
    const { runWorkerOnce } = await import("../src/server/worker.ts");
    const express = (await import("express")).default;
    const { draftConnectorApi } = await import("../src/server/draft-api.ts");
    const app = express();
    app.use(express.json());
    app.use("/api", draftConnectorApi);
    const api = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => api.once("listening", resolve));
    const address = api.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture API failed");
    const post = async (path: string, body: unknown) => {
      const response = await actualFetch(
        `http://127.0.0.1:${address.port}/api/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      expect(
        z
          .object({ pgmq: z.literal(true) })
          .parse(await dbRpc("studio_runtime_health")).pgmq,
      ).toBe(true);
      await mutateState((state) => {
        state.paused = true;
      });
      const platforms = ["wechat", "zhihu", "bilibili"] as const;
      const accountIds: string[] = [];
      for (const platform of platforms) {
        const account = z
          .object({ id: z.uuid() })
          .parse(
            await post("publishing/draft-connectors/accounts", {
              platform,
              expectedUserId: "owner-123",
              permissionConfirmed: true,
            }),
          );
        accountIds.push(account.id);
      }
      const draft = await createDraft(
        {
          topic: "Isolated software fixture",
          audience: "Developers",
          angle: "Review software workflows",
          sources: [
            {
              title: "Fixture source",
              url: "https://www.w3.org/",
              excerpt: "Isolated source fixture.",
            },
          ],
          platforms: [...platforms],
        },
        {
          title: "Isolated workflow",
          body: "Fixture article.",
          variants: platforms.map((platform) => ({
            platform,
            format: "article" as const,
            title: "Reviewed workflow",
            text: "Reviewed fixture body.",
            tags: ["software"],
            mediaPaths: [],
          })),
        },
      );
      const parameters = {
        expectedRevision: draft.revision,
        accountIds,
      };
      const jobs = z
        .array(z.object({ id: z.uuid() }))
        .parse(await post(`drafts/${draft.id}/save-drafts`, parameters));
      expect(jobs).toHaveLength(3);
      for (const _platform of platforms)
        expect(await runWorkerOnce()).toBe(true);
      let state = await readState();
      expect(state.jobs).toHaveLength(3);
      for (const job of state.jobs) {
        expect(job.status).toBe("draft_saved");
        expect(job.attempts).toBe(1);
        expect(job.draftReceipt?.id).toMatch(/^800[1-3]$/);
        expect(job.draftReceipt?.destination).toBe("platform");
        expect(job.remoteId).toBeNull();
        expect(job.remoteUrl).toBeNull();
      }
      expect(state.paused).toBe(true);
      expect(creates).toBe(3);
      expect(updates).toHaveLength(3);
      for (const update of updates)
        expect(decodeURIComponent(update)).toContain("https://www.w3.org/");
      expect(
        (await post(`drafts/${draft.id}/save-drafts`, parameters)).map(
          (job: { id: string }) => job.id,
        ),
      ).toEqual(jobs.map((job: { id: string }) => job.id));
      expect(await runWorkerOnce()).toBe(false);
      state = await readState();
      expect(state.jobs).toHaveLength(3);
      expect(creates).toBe(3);
    } finally {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
      for (let index = 0; index < 20; index++) {
        const claim = z
          .object({ msgId: z.number(), token: z.uuid() })
          .nullable()
          .parse(
            await dbRpc("studio_claim_role_work", {
              p_workspace: workspaceId,
              p_role: "all",
            }),
          );
        if (!claim) break;
        await dbRpc("studio_ack_work", {
          p_workspace: workspaceId,
          p_msg: claim.msgId,
          p_token: claim.token,
        });
      }
      for (const table of [
        "studio_operations",
        "studio_revisions",
        "studio_editor_state",
        "studio_account_execution_leases",
        "studio_queue_leases",
        "studio_article_commands",
        "content_studio_workspaces",
      ])
        await dbRequest(
          `${table}?${table === "content_studio_workspaces" ? "id" : "workspace_id"}=eq.${workspaceId}`,
          { method: "DELETE" },
        );
      process.env = previousEnvironment;
    }
  },
);
