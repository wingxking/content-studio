/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import type {
  Article,
  AuthResult,
  HeaderRule,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PreprocessConfig } from "../types";
import {
  SMZDM_HEADERS,
  isWafChallenge,
  smzdmLogger,
  waitWithJitter,
} from "./support";
export class SmzdmAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "smzdm",
    name: "什么值得买",
    icon: "https://www.smzdm.com/favicon.ico",
    homepage: "https://post.smzdm.com/tougao/",
    capabilities: ["article", "draft", "image_upload"],
  };
  preprocessConfig: PreprocessConfig = {
    outputFormat: "html",
    removeLinks: !0,
  };
  HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: "*://post.smzdm.com/*",
      headers: {
        Origin: "https://post.smzdm.com",
        Referer: "https://post.smzdm.com/",
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];
  _currentArticleId: string | null = null;
  async fetchWithRetry(e: string, t: RequestInit, r = 5) {
    const s = { ...SMZDM_HEADERS, ...(t.headers || {}) },
      n = { ...t, headers: s };
    for (let i = 1; i <= r; i++) {
      const a = await this.runtime.fetch(e, n),
        l = await a.clone().text();
      if (!isWafChallenge(l))
        return new Response(l, {
          status: a.status,
          statusText: a.statusText,
          headers: a.headers,
        });
      (smzdmLogger.warn(`WAF challenge on attempt ${i}/${r}: ${e}`),
        i < r && (await waitWithJitter(1500 * i)));
    }
    throw new Error("请求被 WAF 拦截，请稍后重试");
  }
  async checkAuth(): Promise<AuthResult> {
    try {
      const t = await (
        await this.fetchWithRetry("https://post.smzdm.com/tougao/", {
          credentials: "include",
        })
      ).text();
      if (!t.includes("release-new"))
        return { isAuthenticated: !1, error: "未登录" };
      const s =
          t.match(/class="user-name[^"]*"[^>]*>([^<]+)</) ||
          t.match(/nickname['"]\s*:\s*['"]([^'"]+)/),
        n = s ? s[1].trim() : void 0,
        i =
          t.match(/class="user-avatar[^"]*"[^>]*src="([^"]+)"/) ||
          t.match(/avatar['"]\s*:\s*['"]([^'"]+)/),
        a = i ? i[1] : void 0;
      return { isAuthenticated: !0, username: n, avatar: a };
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return { isAuthenticated: !1, error: e.message };
    }
  }
  async createNewArticle() {
    const t = await (
        await this.fetchWithRetry("https://post.smzdm.com/tougao/", {
          credentials: "include",
        })
      ).text(),
      r =
        t.match(/href="\/edit\/([^"]+)"\s+class="release-new"/) ||
        t.match(/class="release-new"[^>]*href="\/edit\/([^"]+)"/);
    if (!r) throw new Error("无法创建新文章，请确认已登录什么值得买");
    const s = r[1];
    return (smzdmLogger.debug("Created new article:", s), s);
  }
  async uploadImageByUrl(e: string) {
    var a;
    const r = await (await this.runtime.fetch(e)).blob();
    if (!this._currentArticleId) throw new Error("上传图片需要先创建文章");
    const s = new FormData();
    (s.append("imgFile", r, "WU_FILE_0"),
      s.append("type", r.type || "image/png"),
      s.append("article_id", this._currentArticleId),
      s.append("insert", "1"),
      s.append("storage", "1"),
      s.append("size", String(r.size)));
    const i = await (
      await this.fetchWithRetry(
        "https://post.smzdm.com/api/images/upload/local",
        { method: "POST", credentials: "include", body: s },
      )
    ).json();
    if (i.error_code !== 0 || !((a = i.data) != null && a.url))
      throw new Error(`图片上传失败: ${i.error_msg || JSON.stringify(i)}`);
    return (
      smzdmLogger.debug(`Image uploaded: ${i.data.url}`),
      { url: i.data.url }
    );
  }
  async publish(e: Article): Promise<SyncResult> {
    const t = Date.now();
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const r = await this.createNewArticle();
        ((this._currentArticleId = r), await waitWithJitter(800));
        let s = e.html || "";
        s = await this.processImages(s, (u) => this.uploadImageByUrl(u), {
          skipPatterns: ["zdmimg.com", "smzdm.com"],
        });
        const n = new URLSearchParams();
        (n.append("article_id", r),
          n.append("submit_type", "auto_save"),
          n.append("title", e.title),
          n.append("editorValue", s),
          n.append("series_title", ""),
          n.append("focus_image", ""),
          n.append("series_order_id", "0"),
          n.append("series_id", "0"),
          n.append("anonymous", "0"),
          n.append("first_publish", "0"),
          n.append("remark", ""),
          n.append("create_state_type", "3"),
          n.append("ai_state_type", "3"),
          n.append("square_pic_url", ""),
          n.append("cover_image_rectangle", ""),
          n.append("custom_topics", ""),
          n.append("group_id", ""));
        const a = await (
          await this.fetchWithRetry(
            "https://post.smzdm.com/api/editor/article/submit",
            {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded; charset=UTF-8",
              },
              body: n.toString(),
            },
          )
        ).json();
        if (a.error_code !== 0)
          throw new Error(`保存草稿失败: ${a.error_msg || JSON.stringify(a)}`);
        return (
          smzdmLogger.debug("Draft saved:", a.data),
          {
            platform: this.meta.id,
            success: !0,
            postId: r,
            postUrl: `https://post.smzdm.com/edit/${r}`,
            draftOnly: !0,
            timestamp: t,
          }
        );
      } catch (caughtError) {
        const r =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        return {
          platform: this.meta.id,
          success: !1,
          error: r.message,
          timestamp: t,
        };
      } finally {
        this._currentArticleId = null;
      }
    });
  }
}
