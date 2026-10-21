import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLoggerConfig } from "../core/src/lib/logger";
import { JianshuAdapter } from "../core/src/adapters/recovered/jianshu";
import { DouyinAdapter } from "../core/src/adapters/recovered/douyin";
import { ToutiaoAdapter } from "../core/src/adapters/recovered/toutiao";
import { XiaohongshuAdapter } from "../core/src/adapters/recovered/xiaohongshu";
import { XAdapter } from "../core/src/adapters/recovered/x";
import { markdownToXhsDocument } from "../core/src/adapters/recovered/support";
import { getAdapter, getAllPlatformMetas, initAdapters } from "../src/adapters";
import { createRuntimeFixture, jsonResponse } from "./runtime-fixture";

setLoggerConfig({ enabled: false });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unmocked network request");
    }),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("recovered extension", () => {
  it("registers every distribution target without account/network access", async () => {
    await initAdapters();
    const ids = getAllPlatformMetas().map((platform) => platform.id);
    expect(new Set(ids).size).toBe(29);
    expect(ids.filter((id) => id !== "zip-download")).toHaveLength(28);
    for (const id of [
      "dayu",
      "douyin",
      "jianshu",
      "netease",
      "smzdm",
      "sohufocus",
      "toutiao",
      "x",
      "xiaohongshu",
      "yidian",
    ]) {
      const adapter = await getAdapter(id);
      expect(adapter?.meta.id).toBe(id);
      expect(typeof adapter?.publish).toBe("function");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves Jianshu markdown mode and creates then updates the same draft", async () => {
    const { runtime, requests } = createRuntimeFixture(({ url, options }) => {
      if (url.endsWith("/settings/basic.json"))
        return jsonResponse({
          data: { nickname: "fixture", preferred_note_type: "markdown" },
        });
      if (url.endsWith("/author/notebooks")) return jsonResponse([{ id: 7 }]);
      if (url.endsWith("/author/notes") && options?.method === "POST")
        return jsonResponse({ id: 123 });
      if (url.endsWith("/author/notes/123") && options?.method === "PUT")
        return jsonResponse({ id: 123 });
      throw new Error(`Unexpected fixture URL: ${url}`);
    });
    const adapter = new JianshuAdapter();
    await adapter.init(runtime);
    const result = await adapter.publish({
      title: "Fixture title",
      markdown: "**Keep markdown**",
      html: "<p>HTML alternative</p>",
    });
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: "123",
      postUrl: "https://www.jianshu.com/writer#/notebooks/7/notes/123",
    });
    const update = JSON.parse(String(requests.at(-1)?.options?.body));
    expect(update).toMatchObject({
      id: "123",
      title: "Fixture title",
      content: "**Keep markdown**",
    });
    expect(requests).toHaveLength(4);
  });

  it("submits Douyin article data through the page context as a draft", async () => {
    const pageFetch = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toContain("/web/api/media/aweme/draft?aid=1128");
      const payload = JSON.parse(String(options?.body));
      expect(payload.item.common.draft).toMatchObject({
        title: "图文测试",
        long_article: "离线正文",
        req_type: 0,
        timing: 0,
      });
      return jsonResponse({ status_code: 0 });
    });
    vi.stubGlobal("fetch", pageFetch);
    const { runtime, requests } = createRuntimeFixture(() => {
      throw new Error("Background request not expected");
    });
    const adapter = new DouyinAdapter();
    await adapter.init(runtime);
    const result = await adapter.publish({
      title: "图文测试",
      markdown: "离线正文",
    });
    expect(result).toMatchObject({ success: true, draftOnly: true });
    expect(result.postUrl).toContain("enter_from=draft&creation_id=");
    expect(pageFetch).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
  });

  it("preserves Toutiao draft form fields and returned editor identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options?: RequestInit) => {
        const form = new URLSearchParams(String(options?.body));
        expect(form.get("save")).toBe("0");
        expect(form.get("timer_status")).toBe("0");
        expect(form.get("title")).toBe("头条离线测试");
        expect(form.get("content")).toBe("<p>正文</p>");
        return jsonResponse({ err_no: 0, data: { pgc_id: "fixture-pgc" } });
      }),
    );
    const { runtime } = createRuntimeFixture(() => {
      throw new Error("Unexpected background request");
    });
    const adapter = new ToutiaoAdapter();
    await adapter.init(runtime);
    expect(
      await adapter.publish({
        title: "头条离线测试",
        markdown: "正文",
        html: "<p>正文</p>",
      }),
    ).toMatchObject({ success: true, draftOnly: true, postId: "fixture-pgc" });
  });

  it("reconstructs XHS rich text, table fallback and image references", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const upload = vi.fn(async () => ({
      url: "https://fixture.invalid/uploaded.png",
      width: 820,
      height: 410,
      fileId: "fixture-image",
    }));
    const pending = markdownToXhsDocument(
      "#### 标题\n\n**强调**与[链接](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![示意](https://fixture.invalid/original.png)",
      upload,
    );
    await vi.runAllTimersAsync();
    const document = await pending;
    expect(document.content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level: 3 },
    });
    expect(JSON.stringify(document)).toContain("highlight");
    expect(JSON.stringify(document)).toContain("1 | 2");
    expect(JSON.stringify(document)).toContain("uploaded.png");
    expect(JSON.stringify(document)).toContain('"height":205');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("writes XHS drafts to the creator IndexedDB without claiming a remote publication", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let stored: unknown;
    let databaseName: string | undefined;
    let storeName: string | undefined;
    const objectStoreNames = Object.assign(["article-draft"], {
      contains: (name: string) => name === "article-draft",
    });
    const database = {
      objectStoreNames,
      close() {},
      transaction(names: string[]) {
        storeName = names[0];
        return {
          objectStore() {
            return {
              put(value: unknown) {
                stored = value;
                const request: { onsuccess?: () => void } = {};
                queueMicrotask(() => request.onsuccess?.());
                return request;
              },
            };
          },
        };
      },
    };
    vi.stubGlobal("window", {
      location: { href: "https://creator.xiaohongshu.com/publish/publish" },
    });
    vi.stubGlobal("indexedDB", {
      open(name: string) {
        databaseName = name;
        const request: { result: typeof database; onsuccess?: () => void } = {
          result: database,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    const { runtime, requests } = createRuntimeFixture(({ url }) => {
      if (!url.endsWith("/api/galaxy/user/info"))
        throw new Error(`Unexpected fixture request: ${url}`);
      return jsonResponse({
        success: true,
        data: { userId: "fixture-user", userName: "fixture" },
      });
    });
    const adapter = new XiaohongshuAdapter();
    await adapter.init(runtime);
    const result = await adapter.publish({
      title: "本地草稿测试",
      markdown: "离线正文",
    });
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      message: "请到「草稿箱 → 长文笔记」查看",
    });
    expect(databaseName).toBe("draft-database-v1");
    expect(storeName).toBe("article-draft");
    expect(stored).toMatchObject({
      uid: "fixture-user",
      draftId: result.postId,
    });
    expect(JSON.stringify(stored)).toContain("本地草稿测试");
    expect(requests).toHaveLength(1);
  });

  it("converts X Articles to the platform Draft.js representation", async () => {
    const adapter = new XAdapter();
    const content = await adapter.markdownToDraftContent(
      "## Title\n\n**Bold** and ordinary text",
    );
    expect(content.blocks.some((block) => block.type === "header-two")).toBe(
      true,
    );
    expect(content.blocks.some((block) => block.text.includes("Bold"))).toBe(
      true,
    );
    expect(
      content.blocks
        .flatMap((block) => block.inline_style_ranges)
        .some((range) => range.style === "Bold"),
    ).toBe(true);
  });
});
