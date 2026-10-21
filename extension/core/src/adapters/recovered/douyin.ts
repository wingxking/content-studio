import type { ImageXUploadAddress } from "./types";
/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import { crc32 as qt, signAWS4 as Ve } from "../../lib/aws4";
import type {
  Article,
  AuthResult,
  HeaderRule,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PreprocessConfig, PublishOptions } from "../types";
import {
  createDouyinDraftId,
  DOUYIN_APP_ID,
  DOUYIN_IMAGE_SERVICE_ID,
  douyinLogger,
} from "./support";
import type { ImageXCredentials } from "./types";
export class DouyinAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "douyin",
    name: "抖音图文",
    icon: "https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico",
    homepage: "https://creator.douyin.com",
    capabilities: ["article", "draft", "image_upload"],
  };
  preprocessConfig: PreprocessConfig = { outputFormat: "markdown" };
  cachedSTS: ImageXCredentials | null = null;
  stsExpiry = 0;
  HEADER_RULES: HeaderRule[] = [
    {
      urlFilter: "*://imagex.bytedanceapi.com/*",
      headers: {
        Origin: "https://creator.douyin.com",
        Referer: "https://creator.douyin.com/",
      },
      resourceTypes: ["xmlhttprequest"],
    },
    {
      urlFilter: "*://tos-hl-x.snssdk.com/*",
      headers: {
        Origin: "https://creator.douyin.com",
        Referer: "https://creator.douyin.com/",
      },
      resourceTypes: ["xmlhttprequest"],
    },
  ];
  async checkAuth(): Promise<AuthResult> {
    try {
      const t = (await this.runtime.cookies.get(".douyin.com")).find(
        (r) => r.name === "passport_assist_user",
      );
      return t != null && t.value
        ? { isAuthenticated: !0 }
        : { isAuthenticated: !1 };
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        douyinLogger.debug("checkAuth: not logged in -", e),
        { isAuthenticated: !1, error: e.message }
      );
    }
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      douyinLogger.info("Starting publish...");
      let r = e.markdown || "";
      const s: Array<{
        key: string;
        value: { url: string; width: number; height: number };
      }> = [];
      r = await this.processImages(
        r,
        async (d) => {
          const m = await this.uploadImageFull(d);
          return (m.imageInfo && s.push(m.imageInfo), { url: m.storeUri });
        },
        {
          skipPatterns: [
            "douyin.com",
            "snssdk.com",
            "byteimg.com",
            "bytedanceapi.com",
            "jm8ajry58r",
          ],
          onProgress: t == null ? void 0 : t.onImageProgress,
        },
      );
      let n = !1;
      r.length > 8e3 &&
        ((r = r.slice(0, 8e3)),
        (n = !0),
        douyinLogger.warn("Content truncated to 8000 chars for Douyin limit"));
      const i = createDouyinDraftId(),
        a = Math.floor(Date.now() / 1e3),
        u = {
          item: {
            common: {
              draft: {
                title: e.title,
                description: "",
                long_article: r,
                image_info: s,
                head_poster: "",
                text_extra: "[]",
                visibility_type: 0,
                timing: 0,
                creation_id: i,
                init_timestamp: a,
                req_type: 0,
              },
            },
            cover: {},
          },
        },
        l = await this.executeInDouyinTab(
          `https://creator.douyin.com/web/api/media/aweme/draft?aid=${DOUYIN_APP_ID}`,
          "POST",
          u,
        );
      if (l.status_code !== 0) throw new Error(l.status_msg || "保存草稿失败");
      douyinLogger.info("Draft saved successfully");
      const h = `https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=${i}&init_timestamp=${a}`;
      return this.createResult(!0, {
        postUrl: h,
        draftOnly: (t == null ? void 0 : t.draftOnly) ?? !0,
        message: n ? "内容已截断至 8000 字（抖音图文字数限制）" : void 0,
      });
    }).catch((r) => this.createResult(!1, { error: r.message }));
  }
  async ensureDouyinTab() {
    if (!this.runtime.tabs) throw new Error("抖音发布需要浏览器 tabs API 支持");
    const e = await this.runtime.tabs.query("https://creator.douyin.com/*");
    if (e.length > 0 && e[0].id) return e[0].id;
    douyinLogger.info("No existing tab found, creating new one...");
    const t = await this.runtime.tabs.create(
      "https://creator.douyin.com/creator-micro/content/post/article",
      !1,
    );
    return (
      await this.runtime.tabs.waitForLoad(t.id, 3e4),
      douyinLogger.info("New tab created and loaded:", t.id),
      t.id
    );
  }
  async executeInDouyinTab(e: string, t: string, r?: Record<string, unknown>) {
    if (!this.runtime.tabs) throw new Error("抖音发布需要浏览器 tabs API 支持");
    const s = await this.ensureDouyinTab();
    douyinLogger.debug("Using tab:", s, "for", t, e.substring(0, 80));
    const n = await this.runtime.tabs.executeScript(
      s,
      async (i, a, u) => {
        try {
          const l: RequestInit = { method: a, credentials: "include" };
          return (
            u &&
              ((l.headers = { "Content-Type": "application/json" }),
              (l.body = u)),
            { success: !0, data: await (await fetch(i, l)).json() }
          );
        } catch (caughtError) {
          const l =
            caughtError instanceof Error
              ? caughtError
              : new Error(String(caughtError));
          return { success: !1, error: l.message };
        }
      },
      [e, t, r ? JSON.stringify(r) : null] as [string, string, string | null],
    );
    if (!n || !n.success)
      throw new Error((n == null ? void 0 : n.error) || "请求失败");
    return n.data;
  }
  async getSTSCredentials() {
    if (this.cachedSTS && Date.now() < this.stsExpiry - 6e4)
      return this.cachedSTS!;
    const e = await this.executeInDouyinTab(
      `https://creator.douyin.com/web/api/media/upload/auth/v5/?aid=${DOUYIN_APP_ID}`,
      "GET",
    );
    if (e.status_code !== 0 || !e.auth) throw new Error("获取上传凭证失败");
    const t = JSON.parse(e.auth);
    if (!t.AccessKeyID || !t.SecretAccessKey) throw new Error("上传凭证无效");
    return (
      (this.cachedSTS = t),
      (this.stsExpiry = new Date(t.ExpiredTime).getTime()),
      douyinLogger.debug("Got STS credentials, expires:", t.ExpiredTime),
      this.cachedSTS!
    );
  }
  async uploadImageFull(e: string) {
    var h, d;
    let t;
    if (e.startsWith("data:")) t = await fetch(e).then((m) => m.blob());
    else {
      const m = await this.runtime.fetch(e, { method: "GET" });
      if (!m.ok)
        return (
          douyinLogger.warn("Failed to download image:", m.status),
          { storeUri: e }
        );
      t = await m.blob();
    }
    const r = await this.getSTSCredentials(),
      s = await this.applyImageUpload(r),
      n = (h = s.StoreInfos[0]) == null ? void 0 : h.StoreUri;
    if (!n) throw new Error("No store URI in upload address");
    (douyinLogger.debug("Apply upload success, storeUri:", n),
      await this.uploadToTOS(s, t));
    const a =
        (d = (await this.commitImageUpload(r, s.SessionKey)).PluginResult) ==
        null
          ? void 0
          : d[0],
      u = await this.getImagePreviewUrl(n),
      l = {
        key: n,
        value: {
          url: u,
          width: (a == null ? void 0 : a.ImageWidth) || 0,
          height: (a == null ? void 0 : a.ImageHeight) || 0,
        },
      };
    return (
      douyinLogger.debug(
        "Image uploaded:",
        n,
        `(${l.value.width}x${l.value.height})`,
      ),
      { storeUri: n, imageInfo: l }
    );
  }
  async uploadImageByUrl(e: string) {
    try {
      return { url: (await this.uploadImageFull(e)).storeUri };
    } catch (caughtError) {
      const t =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (douyinLogger.warn("Failed to upload image:", e, t), { url: e });
    }
  }
  async applyImageUpload(e: ImageXCredentials) {
    var i;
    const t = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${DOUYIN_IMAGE_SERVICE_ID}`,
      r = await Ve({
        method: "GET",
        url: t,
        accessKeyId: e.AccessKeyID,
        secretAccessKey: e.SecretAccessKey,
        securityToken: e.SessionToken,
        region: "cn-north-1",
        service: "imagex",
      }),
      n = await (
        await this.runtime.fetch(t, {
          method: "GET",
          headers: { ...r.headers },
        })
      ).json();
    if (!((i = n.Result) != null && i.UploadAddress))
      throw new Error("Failed to apply image upload");
    return n.Result.UploadAddress;
  }
  async uploadToTOS(e: ImageXUploadAddress, t: Blob) {
    const r = e.StoreInfos[0],
      s = e.UploadHosts[0];
    if (!r || !s) throw new Error("Invalid upload address");
    const n = `https://${s}/${r.StoreUri}`,
      i = await t.arrayBuffer(),
      a = new Uint8Array(i),
      u = qt(a);
    douyinLogger.debug("Uploading to TOS:", n, "size:", t.size, "crc32:", u);
    const l = await this.runtime.fetch(n, {
      method: "PUT",
      headers: {
        Authorization: r.Auth,
        "Content-Type": t.type || "application/octet-stream",
        "Content-CRC32": u,
      },
      body: t,
    });
    if (!l.ok) {
      const h = await l.text();
      throw new Error(`TOS upload failed: ${l.status} ${h}`);
    }
    douyinLogger.debug("TOS upload success");
  }
  async commitImageUpload(e: ImageXCredentials, t: string) {
    const r = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${DOUYIN_IMAGE_SERVICE_ID}`,
      s = JSON.stringify({ SessionKey: t }),
      n = await Ve({
        method: "POST",
        url: r,
        accessKeyId: e.AccessKeyID,
        secretAccessKey: e.SecretAccessKey,
        securityToken: e.SessionToken,
        region: "cn-north-1",
        service: "imagex",
        body: s,
      }),
      a = await (
        await this.runtime.fetch(r, {
          method: "POST",
          headers: { ...n.headers, "Content-Type": "application/json" },
          body: s,
        })
      ).json();
    if (!a.Result) throw new Error("Failed to commit image upload");
    return a.Result;
  }
  async getImagePreviewUrl(e: string) {
    var s, n;
    const r =
      (n =
        (s = (
          await this.executeInDouyinTab(
            `https://creator.douyin.com/aweme/v1/creator/get/url/?uri=${encodeURIComponent(e)}&aid=${DOUYIN_APP_ID}`,
            "GET",
          )
        ).url) == null
          ? void 0
          : s.url_list) == null
        ? void 0
        : n[0];
    if (!r) throw new Error("获取图片预览 URL 失败");
    return r;
  }
}
