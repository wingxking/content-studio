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
import { jianshuLogger } from "./support";
export class JianshuAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "jianshu",
    name: "简书",
    icon: "https://www.jianshu.com/favicon.ico",
    homepage: "https://www.jianshu.com",
    capabilities: ["article", "draft", "image_upload", "categories"],
  };
  preprocessConfig: PreprocessConfig = { outputFormat: "html" };
  defaultNotebookId: number | null = null;
  preferredNoteType = "plain";
  HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: "*://www.jianshu.com/*",
      headers: {
        Origin: "https://www.jianshu.com",
        Referer: "https://www.jianshu.com/writer",
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];
  async checkAuth(): Promise<AuthResult> {
    var e;
    try {
      const r = await (
        await this.runtime.fetch(
          "https://www.jianshu.com/settings/basic.json",
          { method: "GET", credentials: "include" },
        )
      ).json();
      return (e = r.data) != null && e.nickname
        ? ((this.preferredNoteType =
            r.data.preferred_note_type === "markdown" ? "markdown" : "plain"),
          jianshuLogger.debug("preferred_note_type:", this.preferredNoteType),
          {
            isAuthenticated: !0,
            username: r.data.nickname,
            avatar: r.data.avatar,
          })
        : { isAuthenticated: !1 };
    } catch (caughtError) {
      const t =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        jianshuLogger.debug("checkAuth: not logged in -", t),
        { isAuthenticated: !1, error: t.message }
      );
    }
  }
  async getNotebooks() {
    return (
      await this.runtime.fetch("https://www.jianshu.com/author/notebooks", {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      })
    ).json();
  }
  async getDefaultNotebookId() {
    if (this.defaultNotebookId) return this.defaultNotebookId;
    const e = await this.getNotebooks();
    if (e.length === 0) throw new Error("没有可用的文集");
    return ((this.defaultNotebookId = e[0].id), this.defaultNotebookId);
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      (jianshuLogger.info("Starting publish..."), await this.checkAuth());
      const r = await this.getDefaultNotebookId(),
        n = await (
          await this.runtime.fetch("https://www.jianshu.com/author/notes", {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              at_bottom: !1,
              notebook_id: r,
              title: e.title,
            }),
          })
        ).json();
      if (!n.id) throw new Error("创建草稿失败");
      const i = n.id;
      jianshuLogger.debug("Draft created:", i);
      let a;
      if (
        (this.preferredNoteType === "markdown"
          ? (a = e.markdown || "")
          : (a = e.html || ""),
        (a = await this.processImages(a, (d) => this.uploadImageByUrl(d), {
          skipPatterns: [
            "jianshu.com",
            "jianshuapi.com",
            "upload-images.jianshu.io",
          ],
          onProgress: t == null ? void 0 : t.onImageProgress,
        })),
        !(
          await (
            await this.runtime.fetch(
              `https://www.jianshu.com/author/notes/${i}`,
              {
                method: "PUT",
                credentials: "include",
                headers: {
                  "Content-Type": "application/json; charset=UTF-8",
                  Accept: "application/json",
                },
                body: JSON.stringify({
                  id: String(i),
                  autosave_control: 1,
                  title: e.title,
                  content: a,
                }),
              },
            )
          ).json()
        ).id)
      )
        throw new Error("更新草稿失败");
      jianshuLogger.debug("Draft updated");
      const h = `https://www.jianshu.com/writer#/notebooks/${r}/notes/${i}`;
      return this.createResult(!0, {
        postId: String(i),
        postUrl: h,
        draftOnly: (t == null ? void 0 : t.draftOnly) ?? !0,
      });
    }).catch((r) => this.createResult(!1, { error: r.message }));
  }
  async getUploadToken(e: string) {
    return (
      await this.runtime.fetch(
        `https://www.jianshu.com/upload_images/token.json?filename=${encodeURIComponent(e)}`,
        {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      )
    ).json();
  }
  async uploadImageByUrl(e: string) {
    var t;
    try {
      const r = await fetch(e);
      if (!r.ok) throw new Error("图片下载失败");
      const s = await r.blob(),
        n =
          ((t = s.type.split("/")[1]) == null
            ? void 0
            : t.replace("jpeg", "jpg")) || "jpg";
      let i = `image_${Date.now()}.${n}`;
      try {
        if (!e.startsWith("data:")) {
          const f = new URL(e).pathname.split("/").pop() || "";
          /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(f) && (i = f);
        }
      } catch {}
      const { token: a, key: u } = await this.getUploadToken(i),
        l = new FormData();
      (l.append("token", a),
        l.append("key", u),
        l.append("file", s, i),
        l.append("x:protocol", "https"));
      const d = await (
        await fetch("https://upload.qiniup.com/", { method: "POST", body: l })
      ).json();
      if ((jianshuLogger.debug("Image upload response:", d), d.url))
        return { url: d.url };
      throw new Error("图片上传失败");
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (jianshuLogger.warn("Failed to upload image:", e, r), { url: e });
    }
  }
}
