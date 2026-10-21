import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ checkAuth: vi.fn(), sync: vi.fn() }));
vi.mock("../src/adapters", () => ({
  checkPlatformAuth: dependencies.checkAuth,
}));
vi.mock("../src/background/sync-service", () => ({
  performSync: dependencies.sync,
}));
import { StudioExecutor } from "../src/studio/executor";
import {
  readMaintenanceSafety,
  readConnectionChangeSafety,
} from "../src/studio/lifecycle";
import {
  normalizeStudioReceipt,
  studioHello,
  validateMcpUrl,
  studioSocketOptions,
} from "../src/studio/protocol";

let storage: Record<string, unknown>;
let failStorage: boolean;
const request = () => ({
  platforms: ["zhihu"],
  draftOnly: true,
  execution: {
    protocolVersion: 1,
    jobId: randomUUID(),
    contentHash: "a".repeat(64),
    expectedUserId: "owner-123",
  },
  article: { title: "Reviewed title", content: "<p>Reviewed body</p>" },
});
const receipt = {
  platform: "zhihu",
  success: true,
  draftOnly: true,
  postId: "123",
  postUrl: "https://zhuanlan.zhihu.com/p/123/edit?token=PRIVATE",
};
beforeEach(() => {
  storage = {};
  failStorage = false;
  vi.clearAllMocks();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (key: string | string[]) =>
          Object.fromEntries(
            (Array.isArray(key) ? key : [key]).map((item) => [
              item,
              structuredClone(storage[item]),
            ]),
          ),
        set: async (value: Record<string, unknown>) => {
          if (failStorage) throw new Error("storage unavailable");
          Object.assign(storage, structuredClone(value));
        },
      },
    },
  });
  dependencies.checkAuth.mockResolvedValue({
    isAuthenticated: true,
    userId: "owner-123",
  });
  dependencies.sync.mockImplementation(
    async (_article, _platforms, options) => {
      await options.beforeSync("zhihu");
      return { results: [receipt], syncId: "fixture" };
    },
  );
});

describe("Studio draft executor", () => {
  it("negotiates locally and checks only an explicitly selected reviewed platform", async () => {
    const executor = new StudioExecutor();
    expect(await executor.handle("studio.hello")).toEqual(studioHello);
    expect(dependencies.checkAuth).not.toHaveBeenCalled();
    expect(await executor.handle("checkAuth", { platform: "zhihu" })).toEqual({
      isAuthenticated: true,
      userId: "owner-123",
    });
    expect(dependencies.checkAuth).toHaveBeenCalledTimes(1);
    expect(dependencies.checkAuth).toHaveBeenCalledWith("zhihu");
    for (const method of [
      "publish",
      "uploadImage",
      "listPlatforms",
      "extractArticle",
    ])
      await expect(executor.handle(method)).rejects.toThrow();
    await expect(
      executor.handle("checkAuth", { platform: "x" }),
    ).rejects.toThrow();
  });

  it("validates a single draft-only job, rechecks identity and returns a sanitized receipt", async () => {
    const input = request();
    const result = await new StudioExecutor().handle("syncArticle", input);
    expect(result).toEqual({
      execution: input.execution,
      results: [
        { ...receipt, postUrl: "https://zhuanlan.zhihu.com/p/123/edit" },
      ],
    });
    expect(dependencies.checkAuth).toHaveBeenCalledTimes(2);
    expect(dependencies.sync.mock.calls[0]?.[1]).toEqual(["zhihu"]);
    expect(JSON.stringify(storage.contentStudioDraftJournalV1)).not.toMatch(
      /Reviewed body|PRIVATE/,
    );
  });

  it("replays a completed receipt across executor restarts without a second write", async () => {
    const input = request();
    const first = await new StudioExecutor().handle("syncArticle", input);
    expect(await new StudioExecutor().handle("syncArticle", input)).toEqual(
      first,
    );
    expect(dependencies.sync).toHaveBeenCalledTimes(1);
    await expect(
      new StudioExecutor().handle("syncArticle", {
        ...input,
        article: { ...input.article, content: "changed" },
      }),
    ).rejects.toThrow("payload changed");
  });

  it("does not write for an unbound account or unavailable local journal", async () => {
    dependencies.checkAuth.mockResolvedValue({
      isAuthenticated: true,
      userId: "another-owner",
    });
    await expect(
      new StudioExecutor().handle("syncArticle", request()),
    ).rejects.toThrow("account changed");
    expect(dependencies.sync).not.toHaveBeenCalled();
    dependencies.checkAuth.mockResolvedValue({
      isAuthenticated: true,
      userId: "owner-123",
    });
    failStorage = true;
    await expect(
      new StudioExecutor().handle("syncArticle", request()),
    ).rejects.toThrow("storage unavailable");
    expect(dependencies.sync).not.toHaveBeenCalled();
  });

  it("blocks account or connection changes during preprocessing before calling the writer", async () => {
    dependencies.checkAuth
      .mockResolvedValueOnce({ isAuthenticated: true, userId: "owner-123" })
      .mockResolvedValue({ isAuthenticated: true, userId: "switched-user" });
    await expect(
      new StudioExecutor().handle("syncArticle", request()),
    ).rejects.toThrow("account changed");
    dependencies.checkAuth.mockResolvedValue({
      isAuthenticated: true,
      userId: "owner-123",
    });
    storage = {};
    let connected = true;
    dependencies.sync.mockImplementation(
      async (_article, _platforms, options) => {
        connected = false;
        await options.beforeSync("zhihu");
        return { results: [] };
      },
    );
    await expect(
      new StudioExecutor().handle("syncArticle", request(), () => connected),
    ).rejects.toThrow("session disconnected");
  });

  it("keeps an interrupted or invalid-receipt job uncertain and rejects replay after restart", async () => {
    for (const outcome of ["network", "receipt"] as const) {
      storage = {};
      const input = request();
      dependencies.sync.mockImplementation(async () => {
        if (outcome === "network") throw new Error("lost after write");
        return { results: [{ ...receipt, draftOnly: false }] };
      });
      await expect(
        new StudioExecutor().handle("syncArticle", input),
      ).rejects.toThrow();
      const calls = dependencies.sync.mock.calls.length;
      await expect(
        new StudioExecutor().handle("syncArticle", input),
      ).rejects.toThrow("reconciliation");
      expect(dependencies.sync).toHaveBeenCalledTimes(calls);
    }
  });

  it("preserves unknown outcomes through connection repair and reload, blocks every new write but permits completed receipts and checks", async () => {
    const completed = request();
    const original = await new StudioExecutor().handle(
      "syncArticle",
      completed,
    );
    const uncertain = request();
    dependencies.sync.mockRejectedValue(new Error("lost after write"));
    await expect(
      new StudioExecutor().handle("syncArticle", uncertain),
    ).rejects.toThrow();
    const savedJournal = structuredClone(storage.contentStudioDraftJournalV1);
    expect(
      (
        await readConnectionChangeSafety(
          {
            studioMode: "managed",
            mcpServerUrl: `ws://localhost:19528/connect?key=${"p".repeat(40)}`,
          },
          `ws://localhost:19527/connect?key=${"n".repeat(40)}`,
        )
      ).safe,
    ).toBe(true);
    expect((await readMaintenanceSafety()).safe).toBe(true);
    // Model a service worker restart using a fresh executor, retaining local storage.
    dependencies.sync.mockClear();
    dependencies.checkAuth.mockClear();
    const restarted = new StudioExecutor();
    await expect(restarted.handle("syncArticle", uncertain)).rejects.toThrow(
      "reconciliation",
    );
    await expect(restarted.handle("syncArticle", request())).rejects.toThrow(
      "reconciliation",
    );
    expect(await restarted.handle("syncArticle", completed)).toEqual(original);
    expect(dependencies.checkAuth).not.toHaveBeenCalled();
    expect(dependencies.sync).not.toHaveBeenCalled();
    expect(await restarted.handle("studio.hello")).toEqual(studioHello);
    expect(
      await restarted.handle("checkAuth", { platform: "zhihu" }),
    ).toMatchObject({ isAuthenticated: true });
    expect(storage.contentStudioDraftJournalV1).toEqual(savedJournal);
  });

  it("allows maintenance of corrupt journals but never writes or overwrites them", async () => {
    for (const corrupt of ["broken", null, { job: { status: "completed" } }]) {
      storage.contentStudioDraftJournalV1 = corrupt;
      expect((await readMaintenanceSafety()).safe).toBe(true);
      await expect(
        new StudioExecutor().handle("syncArticle", request()),
      ).rejects.toThrow();
      expect(storage.contentStudioDraftJournalV1).toEqual(corrupt);
    }
    expect(dependencies.sync).not.toHaveBeenCalled();
    expect(dependencies.checkAuth).not.toHaveBeenCalled();
  });

  it("keeps the business lock while allowing local heartbeats", async () => {
    let complete: (value: { results: (typeof receipt)[] }) => void = () => {};
    dependencies.sync.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const executor = new StudioExecutor();
    const saving = executor.handle("syncArticle", request());
    await vi.waitFor(() => expect(dependencies.sync).toHaveBeenCalled());
    expect(await executor.handle("studio.hello")).toEqual(studioHello);
    await expect(executor.handle("syncArticle", request())).rejects.toThrow(
      "busy",
    );
    complete({ results: [receipt] });
    await saving;
  });

  it("rejects broad targets, publication flags and absent approval context", async () => {
    const input = request();
    const invalid = [
      { ...input, draftOnly: false },
      { ...input, execution: undefined },
      { ...input, platforms: ["zhihu", "bilibili"] },
      { ...input, platforms: ["xiaohongshu"] },
      { ...input, article: { ...input.article, publish: true } },
    ];
    for (const value of invalid)
      await expect(
        new StudioExecutor().handle("syncArticle", value),
      ).rejects.toThrow();
    expect(dependencies.sync).not.toHaveBeenCalled();
  });

  it("normalizes all native editor receipts and limits Studio pairing to localhost", () => {
    expect(
      normalizeStudioReceipt(
        {
          ...receipt,
          platform: "weixin",
          postUrl:
            "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&appmsgid=123&token=PRIVATE",
        },
        "weixin",
      ).postUrl,
    ).not.toContain("PRIVATE");
    expect(
      normalizeStudioReceipt(
        {
          ...receipt,
          platform: "bilibili",
          postUrl:
            "https://member.bilibili.com/platform/upload/text/edit?aid=123&token=PRIVATE",
        },
        "bilibili",
      ).postUrl,
    ).not.toContain("PRIVATE");
    for (const postUrl of [
      "https://evil.example/p/123/edit",
      "https://zhuanlan.zhihu.com/p/other/edit",
      "http://zhuanlan.zhihu.com/p/123/edit",
    ])
      expect(() =>
        normalizeStudioReceipt({ ...receipt, postUrl }, "zhihu"),
      ).toThrow();
    expect(
      validateMcpUrl(`ws://127.0.0.1:19527/connect?key=${"a".repeat(32)}`),
    ).toContain("19527");
    for (const url of [
      "https://localhost/",
      `ws://evil.example/connect?key=${"a".repeat(32)}`,
      "ws://127.0.0.1/connect?key=short",
    ])
      expect(() => validateMcpUrl(url)).toThrow();
  });
  it("synchronizes an attested original receipt without calling the writer and keeps replay idempotent", async () => {
    const payload = request();
    const executor = new StudioExecutor();
    dependencies.sync.mockRejectedValueOnce(new Error("lost receipt"));
    await expect(executor.handle("syncArticle",payload)).rejects.toThrow();
    expect(await executor.handle("studio.journal")).toEqual({blocked:true,invalid:false,pending:[payload.execution.jobId]});
    const syncCalls=dependencies.sync.mock.calls.length;
    const result = await executor.handle("studio.confirmReceipt",{request:payload,receipt});
    expect(result).toEqual({synchronized:true,jobId:payload.execution.jobId});
    const preserved=structuredClone(storage.contentStudioDraftJournalV1);
    await executor.handle("studio.confirmReceipt",{request:payload,receipt});
    expect(storage.contentStudioDraftJournalV1).toEqual(preserved);
    expect(await executor.handle("studio.journal")).toEqual({blocked:false,invalid:false,pending:[]});
    await executor.handle("syncArticle",payload);
    expect(dependencies.sync).toHaveBeenCalledTimes(syncCalls);
  });

  it("rejects changed payloads, missing journals, switched identities and disconnected receipt synchronization", async () => {
    const payload=request();const executor=new StudioExecutor();
    dependencies.sync.mockRejectedValueOnce(new Error("lost receipt"));
    await expect(executor.handle("syncArticle",payload)).rejects.toThrow();
    const original=structuredClone(storage.contentStudioDraftJournalV1);
    for (const altered of [{...payload,article:{...payload.article,content:"changed"}},{...payload,execution:{...payload.execution,jobId:randomUUID()}}]) {
      await expect(executor.handle("studio.confirmReceipt",{request:altered,receipt})).rejects.toThrow();
    }
    dependencies.checkAuth.mockResolvedValueOnce({isAuthenticated:true,userId:"other"});
    await expect(executor.handle("studio.confirmReceipt",{request:payload,receipt})).rejects.toThrow();
    await expect(executor.handle("studio.confirmReceipt",{request:payload,receipt},()=>false)).rejects.toThrow();
    await expect(executor.handle("studio.confirmReceipt",{request:payload,receipt:{...receipt,postUrl:"https://evil.example/p/123/edit"}})).rejects.toThrow();
    expect(storage.contentStudioDraftJournalV1).toEqual(original);
    expect(dependencies.sync).toHaveBeenCalledTimes(1);
  });

  it("keeps other unknown records blocking and reports corrupt records without exposing stored values", async () => {
    const payload=request();const executor=new StudioExecutor();
    dependencies.sync.mockRejectedValueOnce(new Error("lost receipt"));
    await expect(executor.handle("syncArticle",payload)).rejects.toThrow();
    const journal=storage.contentStudioDraftJournalV1 as Record<string,unknown>;
    const other=randomUUID();journal[other]=structuredClone(journal[payload.execution.jobId]);
    await executor.handle("studio.confirmReceipt",{request:payload,receipt});
    expect(await executor.handle("studio.journal")).toEqual({blocked:true,invalid:false,pending:[other]});
    await expect(executor.handle("syncArticle",request())).rejects.toThrow();
    storage.contentStudioDraftJournalV1={secret:"private-corrupt-content"};
    expect(await executor.handle("studio.journal")).toEqual({blocked:true,invalid:true,pending:[]});
    await expect(executor.handle("studio.confirmReceipt",{request:payload,receipt})).rejects.toThrow();
    expect(dependencies.sync).toHaveBeenCalledTimes(1);
  });

  it("keeps both managed WebSocket URLs free of pairing credentials while preserving secure handshakes", () => {
    const key="a".repeat(43);
    for (const path of ["/connect","/ui/connect"]) {
      const transport=studioSocketOptions(`ws://127.0.0.1:19527${path}?key=${key}`);
      expect(transport.url).toBe(`ws://127.0.0.1:19527${path}`);
      expect(transport.url).not.toContain(key);
      expect(transport.protocols).toEqual([`content-studio-key.${key}`]);
    }
    expect(studioSocketOptions("ws://localhost:9527").protocols).toEqual([]);
    expect(()=>studioSocketOptions(`ws://evil.example/ui/connect?key=${key}`)).toThrow();
  });

});
