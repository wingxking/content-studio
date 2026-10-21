/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import type {
  Article,
  AuthResult,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PublishOptions } from "../types";
import {
  XHS_CREATOR_ORIGIN,
  XHS_EDITOR_URL,
  XHS_MAX_TEXT_LENGTH,
  markdownToXhsDocument,
  xhsLogger,
} from "./support";
export class XiaohongshuAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "xiaohongshu",
    name: "小红书",
    icon: "https://www.xiaohongshu.com/favicon.ico",
    homepage: XHS_EDITOR_URL,
    capabilities: ["article", "draft", "image_upload"],
  };
  userId: string | null = null;
  async setupHeaderRules() {
    await this.addHeaderRules([
      {
        urlFilter: "*://creator.xiaohongshu.com/*",
        headers: {
          Origin: "https://creator.xiaohongshu.com",
          Referer: XHS_EDITOR_URL,
        },
        resourceTypes: ["xmlhttprequest"],
      },
      {
        urlFilter: "*://ros-upload.xiaohongshu.com/*",
        headers: {
          Origin: "https://creator.xiaohongshu.com",
          Referer: "https://creator.xiaohongshu.com/",
        },
        resourceTypes: ["xmlhttprequest"],
      },
    ]);
  }
  async ensureXHSTab() {
    if (!this.runtime.tabs)
      throw new Error("小红书发布需要浏览器 tabs API 支持");
    const e = await this.runtime.tabs.query(
      "https://creator.xiaohongshu.com/*",
    );
    if (e.length > 0 && e[0].id) return e[0].id;
    xhsLogger.info("No existing XHS creator tab found, creating new one...");
    const t = await this.runtime.tabs.create(XHS_EDITOR_URL, !1);
    return (
      await this.runtime.tabs.waitForLoad(t.id, 3e4),
      xhsLogger.info("New XHS creator tab created and loaded:", t.id),
      t.id
    );
  }
  async checkAuth(): Promise<AuthResult> {
    try {
      await this.setupHeaderRules();
      const t = await (
        await this.runtime.fetch(`${XHS_CREATOR_ORIGIN}/api/galaxy/user/info`, {
          credentials: "include",
          headers: { Accept: "application/json, text/plain, */*" },
        })
      ).json();
      return (
        await this.clearHeaderRules(),
        t.success && t.data
          ? ((this.userId = t.data.userId),
            xhsLogger.info("XHS auth success:", t.data.userName),
            {
              isAuthenticated: !0,
              userId: this.userId!,
              username: t.data.userName,
              avatar: t.data.userAvatar,
            })
          : { isAuthenticated: !1, error: "未登录小红书创作者平台" }
      );
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        await this.clearHeaderRules(),
        xhsLogger.error("checkAuth error:", e),
        { isAuthenticated: !1, error: e.message }
      );
    }
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    await this.setupHeaderRules();
    try {
      xhsLogger.info("Starting publish to Xiaohongshu...");
      const r = e.markdown || "",
        s = this.getPlainTextLength(r);
      if (s > XHS_MAX_TEXT_LENGTH)
        throw new Error(
          `文章字数超出小红书限制：当前 ${s} 字，最多 ${XHS_MAX_TEXT_LENGTH} 字`,
        );
      if (!this.runtime.tabs)
        throw new Error("小红书发布需要浏览器 tabs API 支持");
      const n = await this.ensureXHSTab(),
        i = await markdownToXhsDocument(
          r,
          async (l) => {
            var d, m, f;
            const h = await this.uploadImageByUrl(l);
            return {
              url: h.url,
              width: ((d = h.attrs) == null ? void 0 : d.width) || 0,
              height: ((m = h.attrs) == null ? void 0 : m.height) || 0,
              fileId: (f = h.attrs) == null ? void 0 : f.fileId,
            };
          },
          t == null ? void 0 : t.onImageProgress,
        ),
        a = this.generateUUID();
      if (!this.userId && !(await this.checkAuth()).isAuthenticated)
        throw new Error("请先登录小红书创作者平台");
      xhsLogger.info("userId before save:", this.userId);
      const u = await this.runtime.tabs.executeScript(
        n,
        async (l, h, d, m) => {
          const f = new Promise<{ success: boolean; error?: string }>((w) => {
              setTimeout(
                () => w({ success: !1, error: "IndexedDB timeout (10s)" }),
                1e4,
              );
            }),
            p = new Promise<{ success: boolean; error?: string }>((w) => {
              try {
                const _ = indexedDB.open("draft-database-v1");
                ((_.onerror = (y) => {
                  var T;
                  w({
                    success: !1,
                    error:
                      "IndexedDB open error: " +
                      ((T = (y.target as IDBOpenDBRequest).error) == null
                        ? void 0
                        : T.message),
                  });
                }),
                  (_.onsuccess = () => {
                    try {
                      const y = _.result,
                        T = window.location.href,
                        P = Array.from(y.objectStoreNames);
                      if (!y.objectStoreNames.contains("article-draft")) {
                        (y.close(),
                          w({
                            success: !1,
                            error: `article-draft store not found. URL: ${T}, stores: ${P.join(", ")}`,
                          }));
                        return;
                      }
                      const A = y.transaction(["article-draft"], "readwrite"),
                        S = A.objectStore("article-draft"),
                        v = {
                          content: {
                            contextStore: {
                              liveContext: { time: 0, title: "" },
                              previewAuditContext: {
                                status: 0,
                                detail: {
                                  hasLimit: !0,
                                  remainingCalls: 0,
                                  taskId: "",
                                  taskType: "1",
                                  status: 0,
                                  taskResultInfo: {
                                    detectionStatus: 1,
                                    optimizationPoints: [],
                                  },
                                },
                                isChange: !1,
                              },
                              coverContext: {
                                coverUrl: "",
                                cover: {
                                  width: 0,
                                  height: 0,
                                  fileid: "",
                                  frame: {
                                    ts: 0,
                                    isUserSelect: !1,
                                    isUpload: !1,
                                  },
                                  stickers: { version: 2, neptune: [] },
                                  fonts: [],
                                  coverTemplateId: "",
                                  extra_info_json: "",
                                },
                                templateBlob: null,
                                rate: 0,
                                recommendCoverIdx: -1,
                              },
                              goodsContext: {
                                goodsInfo: {},
                                goodsPreviewDetail: [],
                              },
                              bizRelationContext: { bizRelation: [] },
                              recommendCovers: [],
                            },
                            draftStore: {
                              descInnerHTML: "",
                              descLength: 0,
                              video: {
                                width: 0,
                                height: 0,
                                fileid: "",
                                fsize: 0,
                                duration: 0,
                                videoId: "",
                                videoMarks: [],
                                timelines: [],
                                frame: { ts: 0, userSelect: !1 },
                                transcodeVideoFileId: "",
                                coverInfo: {},
                              },
                              videoInfo: null,
                              audioInfo: null,
                              videoMeta: "",
                              audioMeta: "",
                              cover: {
                                width: 0,
                                height: 0,
                                fileid: "",
                                frame: {
                                  ts: 0,
                                  isUserSelect: !1,
                                  isUpload: !1,
                                },
                                stickers: { neptune: [], version: 2 },
                                fonts: [],
                              },
                              chapters: [],
                              markers: [],
                              needTranscode: !1,
                              imgList: [],
                              colorGroup: null,
                              title: h,
                              desc: "",
                              ats: [],
                              hashTag: [],
                            },
                            settingStore: {
                              privacyInfo: { opType: 1, type: 0, userIds: [] },
                              collectionId: "",
                              orderId: "",
                              brandAccountId: "",
                              noteSketch: { id: "", name: "" },
                              original: !1,
                              originalDateStamp: "",
                              coProduceBind: { enable: !0 },
                              noteCopyBind: { copyable: !0 },
                              coOrderId: "",
                              interactionPermissionBind: {
                                commentPermission: 0,
                              },
                              fileRelate: {
                                fileId: "",
                                docId: "",
                                docName: "",
                                docShowName: "",
                                docType: "",
                                docSize: 0,
                              },
                            },
                            articleStore: {
                              articleContent: "",
                              summeryContent: "",
                              orderPattern: "",
                              richJson: d,
                              articleTitle: h,
                              articleEditorMode: 0,
                              authorAndSummaryTemp: {
                                author: "",
                                summary: "",
                                readingStats: "",
                              },
                              selectedThemeId: 6,
                              selectedColorIndexMap: {},
                              blob2Map: {},
                              coverSetting: {
                                styleType: 0,
                                showAuthor: !0,
                                showReadingStats: !0,
                                showSummery: !0,
                              },
                              editPageSource: "import",
                              schemaCopy: {},
                              url2FileIdMap: {},
                            },
                            shortDraftStore: {
                              isShort: !0,
                              editStatus: 0,
                              textCardList: [
                                {
                                  createTime: Date.now(),
                                  text: "",
                                  originText: "",
                                  length: 0,
                                  image: "",
                                  imageFileId: "",
                                  isManualInsert: !1,
                                },
                              ],
                              coverList: [],
                              currentCoverIdx: 0,
                              cacheData: {},
                            },
                            publishStore: {
                              publishType: 1,
                              imageNoteOrigin: 0,
                              systemId: "web",
                              step: 0,
                              uploadState: 2,
                              status: 0,
                              codec: "unknown",
                            },
                          },
                          draftId: l,
                          uid: m,
                          timeStamp: Date.now(),
                        },
                        U = S.put(v);
                      ((U.onsuccess = () => {
                        (y.close(),
                          w({ success: !0, error: `saved with uid: ${m}` }));
                      }),
                        (U.onerror = () => {
                          var k;
                          (y.close(),
                            w({
                              success: !1,
                              error:
                                "put error: " +
                                ((k = U.error) == null ? void 0 : k.message),
                            }));
                        }),
                        (A.onerror = () => {
                          var k;
                          (y.close(),
                            w({
                              success: !1,
                              error:
                                "transaction error: " +
                                ((k = A.error) == null ? void 0 : k.message),
                            }));
                        }));
                    } catch (caughtError) {
                      const y =
                        caughtError instanceof Error
                          ? caughtError
                          : new Error(String(caughtError));
                      w({ success: !1, error: "db error: " + y.message });
                    }
                  }));
              } catch (caughtError) {
                const _ =
                  caughtError instanceof Error
                    ? caughtError
                    : new Error(String(caughtError));
                w({ success: !1, error: "open error: " + _.message });
              }
            });
          return Promise.race([p, f]);
        },
        [a, e.title, i, this.userId],
      );
      if (!(u != null && u.success))
        throw new Error((u == null ? void 0 : u.error) || "保存草稿失败");
      return (
        xhsLogger.info(
          "Draft saved to IndexedDB:",
          a,
          "debug:",
          u == null ? void 0 : u.error,
        ),
        await this.clearHeaderRules(),
        this.createResult(!0, {
          postId: a,
          postUrl: XHS_EDITOR_URL,
          draftOnly: !0,
          message: "请到「草稿箱 → 长文笔记」查看",
        })
      );
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        await this.clearHeaderRules(),
        xhsLogger.error("Publish failed:", r),
        this.createResult(!1, { error: r.message })
      );
    }
  }
  async uploadImageByUrl(e: string) {
    if (!this.runtime.tabs)
      throw new Error("小红书图片上传需要浏览器 tabs API 支持");
    const t = await this.ensureXHSTab();
    let r,
      s,
      n = 0,
      i = 0;
    if (e.startsWith("data:")) {
      const l = e.match(/^data:([^;]+);base64,(.+)$/);
      if (!l) throw new Error("Invalid data URI");
      ((s = l[1]), (r = l[2]));
      try {
        const h = atob(r),
          d = new Uint8Array(h.length);
        for (let p = 0; p < h.length; p++) d[p] = h.charCodeAt(p);
        const m = new Blob([d], { type: s }),
          f = await createImageBitmap(m);
        ((n = f.width), (i = f.height), f.close());
      } catch (caughtError) {
        const h =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        xhsLogger.warn("Failed to get image dimensions from data URI:", h);
      }
    } else {
      const h = await (await fetch(e)).blob();
      s = h.type || "image/jpeg";
      try {
        const p = await createImageBitmap(h);
        ((n = p.width), (i = p.height), p.close());
      } catch (caughtError) {
        const p =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        xhsLogger.warn("Failed to get image dimensions:", p);
      }
      const d = await h.arrayBuffer(),
        m = new Uint8Array(d);
      let f = "";
      for (let p = 0; p < m.length; p++) f += String.fromCharCode(m[p]);
      r = btoa(f);
    }
    const a = await this.runtime.tabs.executeScript(
      t,
      async (l, h) => {
        var d, m, f;
        try {
          const p =
              "/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web",
            w = window;
          let _: Record<string, string> = {
            Accept: "application/json, text/plain, */*",
          };
          if (typeof w._webmsxyw == "function") {
            const I = w._webmsxyw(p);
            I &&
              ((_["X-s"] = I["X-s"]),
              (_["X-t"] = I["X-t"]),
              (_["X-s-common"] = I["X-s-common"]));
          }
          const T = await (
            await fetch("https://creator.xiaohongshu.com" + p, {
              method: "GET",
              credentials: "include",
              headers: _,
            })
          ).json();
          if (
            !T.success ||
            !(
              (m = (d = T.data) == null ? void 0 : d.uploadTempPermits) !=
                null && m[0]
            )
          )
            return {
              success: !1,
              error: "获取上传凭证失败: " + JSON.stringify(T),
            };
          const P =
              T.data.uploadTempPermits.find(
                (I: { uploadAddr: string }) =>
                  I.uploadAddr === "ros-upload.xiaohongshu.com",
              ) || T.data.uploadTempPermits[0],
            A = (f = P.fileIds) == null ? void 0 : f[0];
          if (!A) return { success: !1, error: "获取 fileId 失败" };
          const S = atob(l),
            v = new Uint8Array(S.length);
          for (let I = 0; I < S.length; I++) v[I] = S.charCodeAt(I);
          const U = new Blob([v], { type: h }),
            k = `https://${P.uploadAddr}/${A}`,
            O = await fetch(k, {
              method: "PUT",
              headers: {
                Authorization: P.token,
                "Content-Type": h,
                "x-cos-security-token": P.token,
              },
              body: U,
            });
          if (!O.ok)
            return {
              success: !1,
              error: `上传失败: ${O.status} ${O.statusText}`,
            };
          const b = O.headers.get("x-ros-preview-url");
          return { success: !0, fileId: A, previewUrl: b };
        } catch (caughtError) {
          const p =
            caughtError instanceof Error
              ? caughtError
              : new Error(String(caughtError));
          return { success: !1, error: p.message };
        }
      },
      [r, s],
    );
    if (!(a != null && a.success) || !a.fileId)
      throw new Error((a == null ? void 0 : a.error) || "图片上传失败");
    return (
      xhsLogger.debug("Image uploaded:", a.fileId),
      {
        url: a.previewUrl || `https://ros-preview.xhscdn.com/${a.fileId}`,
        attrs: { fileId: a.fileId, width: n, height: i },
      }
    );
  }
  generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (e) => {
      const t = (Math.random() * 16) | 0;
      return (e === "x" ? t : (t & 3) | 8).toString(16);
    });
  }
  getPlainTextLength(e: string) {
    let t = e;
    return (
      /<[^>]+>/.test(e)
        ? (t = e
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#(\d+);/g, (r, s) =>
              String.fromCharCode(parseInt(s, 10)),
            ))
        : (t = e
            .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/`[^`]+`/g, "")
            .replace(/^#{1,6}\s+/gm, "")
            .replace(/(\*\*|__)(.*?)\1/g, "$2")
            .replace(/(\*|_)(.*?)\1/g, "$2")
            .replace(/~~(.*?)~~/g, "$1")
            .replace(/^[\-*+]\s+/gm, "")
            .replace(/^\d+\.\s+/gm, "")
            .replace(/^>\s*/gm, "")
            .replace(/^[-*_]{3,}\s*$/gm, "")),
      t.replace(/\s+/g, " ").trim().length
    );
  }
}
