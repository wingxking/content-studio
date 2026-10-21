/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import type {
  Article,
  AuthResult,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PreprocessConfig } from "../types";
import { yidianLogger } from "./support";
export class YidianAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "yidian",
    name: "一点号",
    icon: "https://www.yidianzixun.com/favicon.ico",
    homepage: "https://mp.yidianzixun.com",
    capabilities: ["article", "draft", "image_upload"],
  };
  preprocessConfig: PreprocessConfig = {
    outputFormat: "html",
    removeLinks: !0,
  };
  mpCode: string | null = null;
  async checkAuth(): Promise<AuthResult> {
    try {
      const r = (
        await (
          await this.runtime.fetch("https://mp.yidianzixun.com", {
            credentials: "include",
          })
        ).text()
      ).match(/<script id="__val_"[^>]*>([\s\S]*?)<\/script>/);
      if (!r) return { isAuthenticated: !1, error: "未找到用户数据" };
      const s = r[1],
        n = s.match(/window\.mpcode\s*=\s*['"]([a-f0-9]+)['"]/);
      n &&
        ((this.mpCode = n[1]),
        yidianLogger.debug("mpCode extracted:", this.mpCode));
      const i = s.match(/window\.mpuser\s*=\s*(\{[\s\S]*?\});/);
      if (!i) return { isAuthenticated: !1, error: "未登录" };
      try {
        const a = JSON.parse(i[1]);
        return a.id
          ? {
              isAuthenticated: !0,
              userId: a.id,
              username: a.media_name,
              avatar: a.media_pic,
            }
          : { isAuthenticated: !1, error: "未登录" };
      } catch {
        return { isAuthenticated: !1, error: "解析用户数据失败" };
      }
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return { isAuthenticated: !1, error: e.message };
    }
  }
  getHeaders(e?: string) {
    const t: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
    };
    return (
      e && (t["Content-Type"] = e),
      this.mpCode && (t["x-mp-code"] = this.mpCode),
      t
    );
  }
  async ensureMpCode() {
    this.mpCode ||
      (await this.checkAuth(),
      this.mpCode || yidianLogger.warn("mpCode not found, requests may fail"));
  }
  async uploadImageByUrl(e: string) {
    var h;
    await this.ensureMpCode();
    try {
      const d = this.getHeaders(),
        m = `https://mp.yidianzixun.com/api/getImageFromUrl?src=${encodeURIComponent(e)}`,
        p = await (
          await this.runtime.fetch(m, { credentials: "include", headers: d })
        ).json();
      if (p.status === "success" && p.inner_addr)
        return (
          yidianLogger.debug(`Image uploaded via URL: ${p.inner_addr}`),
          { url: p.inner_addr }
        );
    } catch (caughtError) {
      const d =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      yidianLogger.debug("URL upload failed, trying multipart upload:", d);
    }
    const r = await (await this.runtime.fetch(e)).blob(),
      s =
        ((h = e.match(/\.(png|jpg|jpeg|gif|webp)/i)) == null ? void 0 : h[1]) ||
        "png",
      n = `image_${Date.now()}.${s}`,
      i = new FormData();
    i.append("upfile", r, n);
    const a = this.getHeaders(),
      l = await (
        await this.runtime.fetch(
          "https://mp.yidianzixun.com/upload?action=uploadimage&picType=wemedia_cnt",
          { method: "POST", credentials: "include", headers: a, body: i },
        )
      ).json();
    if (l.status !== "success" || !l.url)
      throw new Error(`图片上传失败: ${JSON.stringify(l)}`);
    return (
      yidianLogger.debug(`Image uploaded via multipart: ${l.url}`),
      { url: l.url }
    );
  }
  async publish(e: Article): Promise<SyncResult> {
    const t = Date.now();
    try {
      await this.ensureMpCode();
      let r = e.html || "";
      r = await this.processImages(r, (a) => this.uploadImageByUrl(a));
      const s = {
          title: e.title,
          cate: "",
          cateB: "",
          coverType: "default",
          covers: [],
          content: r,
          hasSubTitle: 0,
          subTitle: "",
          original: 0,
          reward: 0,
          videos: [],
          audios: [],
          votes: {
            vote_id: "",
            vote_options: [],
            vote_end_time: "",
            vote_title: "",
            vote_type: 1,
            isAdded: !1,
          },
          images: [],
          goods: [],
          is_mobile: 0,
          status: 0,
          import_url: "",
          import_hash: "",
          image_urls: {},
          minTimingHour: 3,
          maxTimingDay: 7,
          tags: [],
          isPubed: !1,
          lastSaveTime: "",
          dirty: !1,
          editorType: "articleEditor",
          activity_id: 0,
          join_activity: 0,
          wm_globallink: "",
          wm_globaltime: "",
          outsideImages: [],
          wm_content_source: { type: 1 },
          notSaveToStore: !0,
        },
        i = await (
          await this.runtime.fetch("https://mp.yidianzixun.com/model/Article", {
            method: "POST",
            credentials: "include",
            headers: this.getHeaders("application/json;charset=UTF-8"),
            body: JSON.stringify(s),
          })
        ).json();
      if (!i.id) throw new Error("同步错误: " + JSON.stringify(i));
      return {
        platform: this.meta.id,
        success: !0,
        postId: i.id,
        postUrl: `https://mp.yidianzixun.com/#/Writing/${i.id}`,
        draftOnly: !0,
        timestamp: t,
      };
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
    }
  }
}
