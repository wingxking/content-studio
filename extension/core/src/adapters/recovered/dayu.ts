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
import { dayuLogger } from "./support";
export class DaYuAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "dayu",
    name: "大鱼号",
    icon: "https://image.uc.cn/s/uae/g/1v/images/index/favicon.ico",
    homepage: "https://mp.dayu.com/dashboard/account/profile",
    capabilities: ["article", "draft", "image_upload"],
  };
  preprocessConfig: PreprocessConfig = { outputFormat: "html" };
  cacheMeta: Record<string, string> | null = null;
  uploadedImages: Array<{
    org_url: string;
    url: string;
  }> = [];
  HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: "*://mp.dayu.com/*",
      headers: {
        Origin: "https://mp.dayu.com",
        Referer: "https://mp.dayu.com/",
      },
      resourceTypes: ["xmlhttprequest"],
    },
    {
      urlFilter: "*://ns.dayu.com/*",
      headers: {
        Origin: "https://mp.dayu.com",
        Referer: "https://mp.dayu.com/",
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];
  async checkAuth(): Promise<AuthResult> {
    var e, t;
    try {
      const s = await (
          await this.runtime.fetch("https://mp.dayu.com/dashboard/index", {
            method: "GET",
            credentials: "include",
          })
        ).text(),
        n = "var globalConfig = ",
        i = s.indexOf(n);
      if (i === -1) return { isAuthenticated: !1 };
      const a = s.substring(i + n.length, s.indexOf("var G = {", i)),
        u = this.parseGlobalConfig(a);
      return !u || !u.utoken
        ? { isAuthenticated: !1 }
        : ((this.cacheMeta = {
            utoken: u.utoken,
            uploadSign: u.nsImageUploadSign,
            uid: u.wmid,
            title: u.weMediaName,
            avatar:
              ((e = u.wmAvator) == null ? void 0 : e.indexOf("http")) > -1
                ? u.wmAvator
                : ((t = u.wmAvator) == null
                    ? void 0
                    : t.replace("//", "https://")) || "",
          }),
          {
            isAuthenticated: !0,
            userId: this.cacheMeta!.uid,
            username: this.cacheMeta!.title,
            avatar: this.cacheMeta!.avatar,
          });
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        dayuLogger.debug("checkAuth: not logged in -", r),
        { isAuthenticated: !1, error: r.message }
      );
    }
  }
  parseGlobalConfig(e: string) {
    try {
      let t = e.trim();
      t.endsWith(";") && (t = t.slice(0, -1));
      const r = t
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]");
      return JSON.parse(r);
    } catch {
      const t: Record<string, string> = {},
        r = {
          utoken: /utoken['":\s]+['"]([^'"]+)['"]/,
          nsImageUploadSign: /nsImageUploadSign['":\s]+['"]([^'"]+)['"]/,
          wmid: /wmid['":\s]+['"]([^'"]+)['"]/,
          weMediaName: /weMediaName['":\s]+['"]([^'"]+)['"]/,
          wmAvator: /wmAvator['":\s]+['"]([^'"]+)['"]/,
        };
      for (const [s, n] of Object.entries(r)) {
        const i = e.match(n);
        i && (t[s] = i[1]);
      }
      return Object.keys(t).length > 0 ? t : null;
    }
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      var h;
      if (
        (dayuLogger.info("Starting publish..."),
        (this.uploadedImages = []),
        !this.cacheMeta && !(await this.checkAuth()).isAuthenticated)
      )
        throw new Error("请先登录大鱼号");
      let r = e.html || "";
      r = await this.processImages(r, (d) => this.uploadImageByUrl(d), {
        skipPatterns: ["dayu.com", "uc.cn"],
        onProgress: t == null ? void 0 : t.onImageProgress,
      });
      const s =
          this.uploadedImages.length > 0 ? this.uploadedImages[0].url : "",
        n = new URLSearchParams();
      (n.append("title", e.title),
        n.append("content", r),
        n.append("author", this.cacheMeta!.title),
        n.append("coverImg", s),
        n.append("article_type", "1"),
        n.append("utoken", this.cacheMeta!.utoken),
        n.append("cover_from", "auto"));
      const a = await (
        await this.runtime.fetch("https://mp.dayu.com/dashboard/save-draft", {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            utoken: this.cacheMeta!.utoken,
          },
          body: n,
        })
      ).json();
      if ((dayuLogger.debug("Save response:", a), a.error))
        throw new Error(a.error);
      if (!((h = a.data) != null && h._id)) throw new Error("保存草稿失败");
      const u = a.data._id,
        l = `https://mp.dayu.com/dashboard/article/write?draft_id=${u}`;
      return this.createResult(!0, {
        postId: u,
        postUrl: l,
        draftOnly: (t == null ? void 0 : t.draftOnly) ?? !0,
      });
    }).catch((r) => this.createResult(!1, { error: r.message }));
  }
  async uploadImageByUrl(e: string) {
    var h, d;
    if (!this.cacheMeta) throw new Error("未登录");
    const t = await fetch(e);
    if (!t.ok) throw new Error("图片下载失败: " + e);
    const r = await t.blob(),
      s = `https://ns.dayu.com/article/imageUpload?appid=website&fromMaterial=0&wmid=${this.cacheMeta!.uid}&wmname=${encodeURIComponent(this.cacheMeta!.title)}&sign=${this.cacheMeta!.uploadSign}`,
      n = new FormData(),
      i = `${Date.now()}.jpg`;
    (n.append("upfile", r, i),
      n.append("type", r.type || "image/jpeg"),
      n.append("id", "WU_FILE_1"),
      n.append("fileid", `uploadm-${Math.floor(Math.random() * 1e6)}`),
      n.append("name", i),
      n.append("lastModifiedDate", new Date().toString()),
      n.append("size", String(r.size)));
    const u = await (
      await this.runtime.fetch(s, {
        method: "POST",
        credentials: "include",
        body: n,
      })
    ).json();
    if (
      (dayuLogger.debug("Image upload response:", u),
      !((d = (h = u.data) == null ? void 0 : h.imgInfo) != null && d.url))
    )
      throw new Error("图片上传失败");
    const l = { org_url: u.data.imgInfo.org_url, url: u.data.imgInfo.url };
    return (this.uploadedImages.push(l), { url: l.url });
  }
}
