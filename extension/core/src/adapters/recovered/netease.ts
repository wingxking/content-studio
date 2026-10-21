/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import type {
  Article,
  AuthResult,
  HeaderRule,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PreprocessConfig, PublishOptions } from "../types";
import { neteaseLogger } from "./support";
import type { NeteaseAccount } from "./types";
export class NeteaseAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "netease",
    name: "网易号",
    icon: "https://static.ws.126.net/163/f2e/news/yxybd_pc/resource/static/share-icon.png",
    homepage: "https://mp.163.com/#/article-publish",
    capabilities: ["article", "draft", "image_upload"],
  };
  preprocessConfig: PreprocessConfig = {
    outputFormat: "html",
    convertTablesToText: !0,
  };
  accountInfo: NeteaseAccount | null = null;
  HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: "*://mp.163.com/*",
      headers: {
        Origin: "https://mp.163.com",
        Referer: "https://mp.163.com/subscribe_v4/index.html",
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];
  async checkAuth(): Promise<AuthResult> {
    var e;
    try {
      const t = await this.get<{ code: number; data: NeteaseAccount }>(
        `https://mp.163.com/wemedia/navinfo.do?_=${Date.now()}`,
      );
      return (
        neteaseLogger.debug("checkAuth response:", t),
        t.code !== 1 || !((e = t.data) != null && e.tid)
          ? { isAuthenticated: !1 }
          : ((this.accountInfo = t.data),
            {
              isAuthenticated: !0,
              userId: t.data.tid,
              username: t.data.tname,
              avatar: t.data.icon,
            })
      );
    } catch (caughtError) {
      const t =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        neteaseLogger.debug("checkAuth: not logged in -", t),
        { isAuthenticated: !1, error: t.message }
      );
    }
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      if (
        (neteaseLogger.info("Starting publish..."),
        !this.accountInfo && !(await this.checkAuth()).isAuthenticated)
      )
        throw new Error("请先登录网易号");
      const r = await this.fetchUrsToken();
      let s = e.html || "";
      s = await this.processImages(s, (p) => this.uploadImageByUrl(p), {
        skipPatterns: ["126.net", "163.com", "netease.com"],
        onProgress: t == null ? void 0 : t.onImageProgress,
      });
      const n = this.accountInfo!.tid,
        i = this.accountInfo!.realUserId || "",
        a = Date.now(),
        u = new URLSearchParams();
      (u.append("wemediaId", n),
        u.append("articleId", "-1"),
        u.append("title", e.title),
        u.append("content", s),
        u.append("cover", "threeImg"),
        u.append("operation", "saveDraft"),
        u.append("scheduled", "0"),
        u.append("ursToken", r),
        u.append("onlineState", "1"),
        u.append("picUrl", ""),
        u.append("original", "0"),
        u.append("subjectId", ""));
      const l = `https://mp.163.com/wemedia/article/status/api/publishV2.do?_=${a}&wemediaId=${n}&realUserId=${encodeURIComponent(i)}`,
        d = await (
          await this.runtime.fetch(l, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: u.toString(),
          })
        ).json();
      if ((neteaseLogger.debug("Publish response:", d), d.code !== 1))
        throw new Error(d.msg || "保存草稿失败");
      let m = "";
      d.data && (m = new URLSearchParams(d.data).get("docId") || d.data);
      const f = `https://mp.163.com/subscribe_v4/index.html#/article-publish/${m}?option=editDraft`;
      return this.createResult(!0, {
        postId: m,
        postUrl: f,
        draftOnly: (t == null ? void 0 : t.draftOnly) ?? !0,
      });
    }).catch((r) => this.createResult(!1, { error: r.message }));
  }
  async ensureNeteaseTab() {
    if (!this.runtime.tabs)
      throw new Error("网易号发布需要浏览器 tabs API 支持");
    const e = await this.runtime.tabs.query("https://mp.163.com/*");
    if (e.length > 0 && e[0].id) return e[0].id;
    neteaseLogger.info("No existing tab found, creating new one...");
    const t = await this.runtime.tabs.create(
      "https://mp.163.com/subscribe_v4/index.html#/article-publish",
      !1,
    );
    return (
      await this.runtime.tabs.waitForLoad(t.id, 3e4),
      neteaseLogger.info("New tab created and loaded:", t.id),
      t.id
    );
  }
  async fetchUrsToken() {
    if (!this.runtime.tabs)
      return (neteaseLogger.warn("No tabs API, cannot get ursToken"), "");
    const e = await this.ensureNeteaseTab();
    neteaseLogger.debug("Using tab:", e, "to get ursToken");
    const t = await this.runtime.tabs.executeScript(e, async () => {
      try {
        const r = window.neg;
        if (!(r != null && r.getToken))
          return { success: !1, error: "neg.getToken not available" };
        const s = await r.getToken();
        return s.code === 200 && s.token
          ? { success: !0, token: s.token }
          : { success: !1, error: `getToken returned code ${s.code}` };
      } catch (caughtError) {
        const r =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        return { success: !1, error: r.message };
      }
    }, []);
    return t != null && t.success && t.token
      ? (neteaseLogger.debug("Got ursToken via neg.getToken()"), t.token)
      : (neteaseLogger.warn(
          "Failed to get ursToken:",
          t == null ? void 0 : t.error,
        ),
        "");
  }
  async uploadImageByUrl(e: string) {
    if (!this.accountInfo) throw new Error("未登录");
    const t = await fetch(e);
    if (!t.ok) throw new Error("图片下载失败: " + e);
    const r = await t.blob(),
      s = new FormData();
    s.append("file", r, "image.jpg");
    const i = await (
      await this.runtime.fetch(
        `https://mp.163.com/wemedia/article/api/uploadCoverImage.do?wemediaId=${this.accountInfo!.tid}`,
        { method: "POST", credentials: "include", body: s },
      )
    ).json();
    if (
      (neteaseLogger.debug("Image upload response:", i),
      i.code !== 1 || !i.data)
    )
      throw new Error("图片上传失败: " + (i.msg || "未知错误"));
    const a = i.data.url || i.data.picUrl;
    if (!a) throw new Error("图片上传返回数据不完整");
    return { url: a };
  }
}
