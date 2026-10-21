/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import type {
  Article,
  AuthResult,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PreprocessConfig } from "../types";
export class SohuFocusAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "sohufocus",
    name: "搜狐焦点",
    icon: "https://mp.focus.cn/favicon.ico",
    homepage: "https://mp.focus.cn/fe/index.html#/info/draft",
    capabilities: ["article", "draft", "image_upload"],
  };
  preprocessConfig: PreprocessConfig = { outputFormat: "html" };
  async checkAuth(): Promise<AuthResult> {
    var e;
    try {
      const r = await (
        await this.runtime.fetch("https://mp-fe-pc.focus.cn/user/status", {
          credentials: "include",
        })
      ).json();
      return (e = r.data) != null && e.uid
        ? {
            isAuthenticated: !0,
            userId: r.data.uid,
            username: r.data.accountName,
          }
        : { isAuthenticated: !1, error: "未登录" };
    } catch (caughtError) {
      const t =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return { isAuthenticated: !1, error: t.message };
    }
  }
  async uploadImageByUrl(e: string) {
    const r = await (await this.runtime.fetch(e)).blob(),
      s = new FormData();
    s.append("image", r, `${Date.now()}.jpg`);
    const i = await (
      await this.runtime.fetch(
        "https://mp-fe-pc.focus.cn/common/image/upload?type=2",
        { method: "POST", credentials: "include", body: s },
      )
    ).json();
    if (i.code !== 200) throw new Error("图片上传失败");
    return { url: `https://t-img.51f.com/sh740wsh${i.data}` };
  }
  async publish(e: Article): Promise<SyncResult> {
    var r;
    const t = Date.now();
    try {
      let s = e.html || e.markdown || "";
      ((s = await this.processImages(s, (a) => this.uploadImageByUrl(a))),
        (s = s.replace(/>\s+</g, "><")));
      const i = await (
        await this.runtime.fetch(
          "https://mp-fe-pc.focus.cn/news/info/publishNewsInfo",
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectIds: [],
              newsBasic: {
                id: "",
                cityId: 0,
                title: e.title,
                category: 1,
                headImg: "",
                newsAbstract: "",
                isGuide: 0,
                status: 4,
              },
              newsContent: { content: s },
              videoIds: [],
            }),
          },
        )
      ).json();
      if (!((r = i.data) != null && r.id)) throw new Error("发布失败");
      return {
        platform: this.meta.id,
        success: !0,
        postId: i.data.id,
        postUrl: `https://mp.focus.cn/fe/index.html#/info/subinfo/${i.data.id}`,
        draftOnly: !0,
        timestamp: t,
      };
    } catch (caughtError) {
      const s =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return {
        platform: this.meta.id,
        success: !1,
        error: s.message,
        timestamp: t,
      };
    }
  }
}
