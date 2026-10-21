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
import { toutiaoLogger } from "./support";
export class ToutiaoAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "toutiao",
    name: "头条",
    icon: "https://sf1-ttcdn-tos.pstatp.com/obj/ttfe/pgcfe/sz/mp_logo.png",
    homepage: "https://mp.toutiao.com/profile_v4/graphic/publish",
    capabilities: ["article", "draft", "image_upload", "cover"],
  };
  preprocessConfig: PreprocessConfig = {
    outputFormat: "html",
    removeLinks: !0,
    removeEmptyImages: !0,
    removeDataAttributes: !0,
    flattenNestedBold: !0,
    unwrapSingleChildSpans: !0,
  };
  HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: "*://mp.toutiao.com/*",
      headers: {
        Origin: "https://mp.toutiao.com",
        Referer: "https://mp.toutiao.com/profile_v4/graphic/publish",
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];
  async checkAuth(): Promise<AuthResult> {
    var e, t;
    try {
      const r = await this.get<{
        data: {
          user?: { id: string; screen_name: string; https_avatar_url: string };
        };
      }>("https://mp.toutiao.com/mp/agw/media/get_media_info");
      return (
        toutiaoLogger.debug("checkAuth response:", r),
        (t = (e = r.data) == null ? void 0 : e.user) != null && t.id
          ? {
              isAuthenticated: !0,
              userId: String(r.data.user!.id),
              username: r.data.user!.screen_name,
              avatar: r.data.user!.https_avatar_url,
            }
          : { isAuthenticated: !1 }
      );
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        toutiaoLogger.debug("checkAuth: not logged in -", r),
        { isAuthenticated: !1, error: r.message }
      );
    }
  }
  async getCsrfToken() {
    return (
      (
        await this.runtime.fetch("https://mp.toutiao.com/ttwid/check/", {
          method: "HEAD",
          credentials: "include",
          headers: {
            "x-secsdk-csrf-request": "1",
            "x-secsdk-csrf-version": "1.2.22",
          },
        })
      ).headers.get("x-ware-csrf-token") || ""
    );
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      var d;
      toutiaoLogger.info("Starting publish...");
      let r = e.html || "";
      ((r = r.replace(/<figure[^>]*>\s*<\/figure>/gi, "")),
        (r = r.replace(
          /\n{3,}/g,
          `

`,
        )),
        (r = await this.processImages(r, (m) => this.uploadImageByUrl(m), {
          skipPatterns: ["pstatp.com", "toutiao.com", "byteimg.com"],
          onProgress: t == null ? void 0 : t.onImageProgress,
        })),
        (r = r.replace(
          /<img\s+([^>]+)>/gi,
          '<div class="pgc-img"><img $1><p class="pgc-img-caption"></p></div>',
        )));
      const s = "[]",
        n = JSON.stringify({
          content_source: 100000000402,
          content_word_cnt: r.length,
          is_multi_title: 0,
          sub_titles: [],
          gd_ext: {
            entrance: "",
            from_page: "publisher_mp",
            enter_from: "PC",
            device_platform: "mp",
            is_message: 0,
          },
        }),
        i = `${Date.now()}_${Math.random().toString().slice(2, 18)}`,
        a = new URLSearchParams();
      (a.append("pgc_id", "0"),
        a.append("source", "29"),
        a.append("extra", n),
        a.append("content", r),
        a.append("title", e.title),
        a.append(
          "search_creation_info",
          JSON.stringify({ searchTopOne: 0, abstract: "", clue_id: "" }),
        ),
        a.append("title_id", i),
        a.append("mp_editor_stat", "{}"),
        a.append("is_refute_rumor", "0"),
        a.append("save", "0"),
        a.append("timer_status", "0"),
        a.append("timer_time", ""),
        a.append("educluecard", ""),
        a.append("draft_form_data", JSON.stringify({ coverType: 3 })),
        a.append("pgc_feed_covers", s),
        a.append("article_ad_type", "3"),
        a.append("is_fans_article", "0"),
        a.append("govern_forward", "0"),
        a.append("praise", "0"),
        a.append("disable_praise", "0"),
        a.append("tree_plan_article", "0"),
        a.append("activity_tag", "0"),
        a.append("trends_writing_tag", "0"),
        a.append("claim_exclusive", "0"));
      const u = await this.publishViaContentScript(
        "https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231",
        a.toString(),
      );
      if (
        (toutiaoLogger.debug("publish response:", u),
        u.err_no !== 0 || !((d = u.data) != null && d.pgc_id))
      )
        throw new Error(u.message || "发布失败");
      const l = u.data.pgc_id,
        h = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${l}`;
      return this.createResult(!0, {
        postId: l,
        postUrl: h,
        draftOnly: (t == null ? void 0 : t.draftOnly) ?? !0,
      });
    }).catch((r) => this.createResult(!1, { error: r.message }));
  }
  async ensureToutiaoTab() {
    if (!this.runtime.tabs) throw new Error("头条发布需要浏览器 tabs API 支持");
    const e = await this.runtime.tabs.query("https://mp.toutiao.com/*");
    if (e.length > 0 && e[0].id) return e[0].id;
    toutiaoLogger.info("No existing tab found, creating new one...");
    const t = await this.runtime.tabs.create(
      "https://mp.toutiao.com/profile_v4/graphic/publish",
      !1,
    );
    return (
      await this.runtime.tabs.waitForLoad(t.id, 3e4),
      toutiaoLogger.info("New tab created and loaded:", t.id),
      t.id
    );
  }
  async publishViaContentScript(e: string, t: string) {
    if (!this.runtime.tabs) throw new Error("头条发布需要浏览器 tabs API 支持");
    const r = await this.ensureToutiaoTab();
    toutiaoLogger.debug("Using tab:", r, "to execute fetch in MAIN world");
    const s = await this.runtime.tabs.executeScript(
      r,
      async (n, i) => {
        try {
          return {
            success: !0,
            data: await (
              await fetch(n, {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: i,
                credentials: "include",
              })
            ).json(),
          };
        } catch (caughtError) {
          const a =
            caughtError instanceof Error
              ? caughtError
              : new Error(String(caughtError));
          return { success: !1, error: a.message };
        }
      },
      [e, t],
    );
    if (!s || !s.success)
      throw new Error((s == null ? void 0 : s.error) || "发布请求失败");
    return s.data;
  }
  async uploadImageByUrl(e: string) {
    const t = await fetch(e);
    if (!t.ok) throw new Error("图片下载失败: " + e);
    const r = await t.blob(),
      s = await this.getCsrfToken(),
      n = new FormData();
    n.append("image", r, "image.jpg");
    const u = await (
      await this.runtime.fetch(
        "https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web",
        {
          method: "POST",
          credentials: "include",
          headers: { "x-secsdk-csrf-token": s },
          body: n,
        },
      )
    ).text();
    let l;
    try {
      l = JSON.parse(u);
    } catch {
      throw new Error("图片上传响应解析失败");
    }
    if (
      (toutiaoLogger.debug("Image upload response:", l),
      l.code !== 0 || !l.data)
    )
      throw new Error(l.message || "图片上传失败");
    if (!l.data.image_url || !l.data.image_uri)
      throw (
        toutiaoLogger.error("Upload response missing URL:", l),
        new Error("图片上传返回数据不完整")
      );
    return {
      url: l.data.image_url,
      attrs: {
        class: "",
        "ic-uri": "",
        image_type: "image/png",
        mime_type: "",
        web_uri: l.data.image_uri,
        img_width: String(l.data.image_width || 0),
        img_height: String(l.data.image_height || 0),
      },
    };
  }
}
