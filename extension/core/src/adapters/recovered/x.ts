import type { QueryIdCache } from "./types";
/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */
import { markdownToDraft as Lt } from "markdown-draft-js";
import { parseMarkdownImages as xe } from "../../lib/markdown-images";
import type {
  Article,
  AuthResult,
  PlatformMeta,
  SyncResult,
} from "../../types";
import { CodeAdapter } from "../code-adapter";
import type { PublishOptions } from "../types";
import {
  X_BUNDLE_PATTERN,
  X_DISCOVERY_URLS,
  X_FALLBACK_QUERY_IDS,
  X_FEATURES,
  X_OPERATION_PATTERNS,
  X_OPERATIONS,
  X_QUERY_CACHE_KEY,
  X_QUERY_CACHE_TTL,
  X_WEB_BEARER,
  xLogger,
} from "./support";
import type { XUser } from "./types";
export class XAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: "x",
    name: "X (Twitter)",
    icon: "https://abs.twimg.com/favicons/twitter.3.ico",
    homepage: "https://x.com/compose/articles",
    capabilities: ["article", "draft", "image_upload"],
  };
  userInfo: XUser | null = null;
  csrfToken: string | null = null;
  xpForwardedFor: { str: string; expiryTimeMillis: number } | null = null;
  queryIdRefreshInProgress: Promise<void> | null = null;
  async getQueryIdCache() {
    try {
      return await this.runtime.storage.get<QueryIdCache>(X_QUERY_CACHE_KEY);
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        xLogger.debug("Failed to get query ID cache from storage:", e),
        null
      );
    }
  }
  async setQueryIdCache(e: QueryIdCache) {
    try {
      await this.runtime.storage.set(X_QUERY_CACHE_KEY, e);
    } catch (caughtError) {
      const t =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      xLogger.debug("Failed to save query ID cache to storage:", t);
    }
  }
  async getQueryId(e: keyof typeof X_OPERATIONS) {
    const t = await this.getQueryIdCache();
    if (t && Date.now() - t.fetchedAt < t.ttlMs) {
      const s = X_OPERATIONS[e],
        n = t.ids[s];
      if (n) return (xLogger.debug(`Using cached query ID for ${e}: ${n}`), n);
    }
    try {
      await this.refreshQueryIds();
      const r = await this.getQueryIdCache(),
        s = X_OPERATIONS[e],
        n = r == null ? void 0 : r.ids[s];
      if (n)
        return (xLogger.debug(`Using refreshed query ID for ${e}: ${n}`), n);
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      xLogger.warn("Failed to refresh query IDs:", r);
    }
    return (
      xLogger.debug(
        `Using fallback query ID for ${e}: ${X_FALLBACK_QUERY_IDS[e]}`,
      ),
      X_FALLBACK_QUERY_IDS[e]
    );
  }
  async refreshQueryIds(e = !1) {
    if (this.queryIdRefreshInProgress) return this.queryIdRefreshInProgress;
    if (!e) {
      const t = await this.getQueryIdCache();
      if (t && Date.now() - t.fetchedAt < t.ttlMs) {
        xLogger.debug("Query ID cache still fresh, skipping refresh");
        return;
      }
    }
    this.queryIdRefreshInProgress = this.doRefreshQueryIds();
    try {
      await this.queryIdRefreshInProgress;
    } finally {
      this.queryIdRefreshInProgress = null;
    }
  }
  async doRefreshQueryIds() {
    xLogger.info("Refreshing X Query IDs from JS bundles...");
    try {
      const e = await this.discoverBundles();
      if ((xLogger.debug(`Discovered ${e.length} bundles`), e.length === 0))
        throw new Error("No JS bundles found");
      const t = new Set(Object.values(X_OPERATIONS)),
        r = await this.extractQueryIdsFromBundles(e, t);
      if (
        (xLogger.debug("Discovered query IDs:", Object.fromEntries(r)),
        r.size === 0)
      )
        throw new Error("No query IDs extracted from bundles");
      const s = {
        ids: Object.fromEntries(r),
        fetchedAt: Date.now(),
        ttlMs: X_QUERY_CACHE_TTL,
      };
      (await this.setQueryIdCache(s),
        xLogger.info(`Refreshed ${r.size} query IDs`));
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      throw (xLogger.error("Failed to refresh query IDs:", e), e);
    }
  }
  async discoverBundles() {
    const e = new Set<string>();
    for (const t of X_DISCOVERY_URLS)
      try {
        xLogger.debug(`Fetching discovery page: ${t}`);
        const n = (
          await (await this.runtime.fetch(t, { credentials: "include" })).text()
        ).matchAll(X_BUNDLE_PATTERN);
        for (const i of n) e.add(i[0]);
      } catch (caughtError) {
        const r =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        xLogger.debug(`Failed to fetch ${t}:`, r);
      }
    return Array.from(e);
  }
  async extractQueryIdsFromBundles(e: string[], t: Set<string>) {
    const r = new Map(),
      s = 4;
    for (let n = 0; n < e.length && !(r.size >= t.size); n += s) {
      const i = e.slice(n, n + s);
      await Promise.all(
        i.map(async (a) => {
          if (!(r.size >= t.size))
            try {
              const l = await (await this.runtime.fetch(a)).text();
              this.extractOperationsFromJs(l, t, r);
            } catch (caughtError) {
              const u =
                caughtError instanceof Error
                  ? caughtError
                  : new Error(String(caughtError));
              xLogger.debug(`Failed to fetch bundle ${a}:`, u);
            }
        }),
      );
    }
    return r;
  }
  extractOperationsFromJs(e: string, t: Set<string>, r: Map<string, string>) {
    for (const s of X_OPERATION_PATTERNS) {
      s.regex.lastIndex = 0;
      let n;
      for (; (n = s.regex.exec(e)) !== null; ) {
        const i = n[s.operationGroup],
          a = n[s.queryIdGroup];
        if (
          !(!i || !a) &&
          t.has(i) &&
          !r.has(i) &&
          /^[a-zA-Z0-9_-]+$/.test(a) &&
          (r.set(i, a), xLogger.debug(`Found ${i}: ${a}`), r.size >= t.size)
        )
          return;
      }
    }
  }
  async graphqlRequest(
    e: keyof typeof X_OPERATIONS,
    t: Record<string, unknown>,
    r?: { retry404?: boolean },
  ) {
    const s = async () => {
        const i = await this.getQueryId(e),
          a = X_OPERATIONS[e],
          u = await this.getCommonHeaders(),
          l = await this.runtime.fetch(
            `https://x.com/i/api/graphql/${i}/${a}`,
            {
              method: "POST",
              credentials: "include",
              headers: { ...u, "content-type": "application/json" },
              body: JSON.stringify({
                variables: t,
                features: X_FEATURES,
                queryId: i,
              }),
            },
          );
        return { data: await l.json(), status: l.status };
      },
      n = await s();
    return n.status === 404 && (r == null ? void 0 : r.retry404) !== !1
      ? (xLogger.warn(`Got 404 for ${e}, refreshing query IDs and retrying...`),
        await this.refreshQueryIds(!0),
        (await s()).data)
      : n.data;
  }
  async getCsrfToken() {
    var e, t;
    if (this.csrfToken) return this.csrfToken;
    try {
      const r = await ((t = (e = this.runtime).getCookie) == null
        ? void 0
        : t.call(e, "https://x.com", "ct0"));
      if (r)
        return (
          (this.csrfToken = r),
          xLogger.debug("Got CSRF token from cookie API"),
          this.csrfToken
        );
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      xLogger.debug("Cookie API failed:", r);
    }
    if (this.runtime.tabs)
      try {
        const r = await this.ensureXTab(),
          s = await this.runtime.tabs.executeScript(r, async () => {
            try {
              const n = document.cookie.split(";");
              for (const i of n) {
                const [a, u] = i.trim().split("=");
                if (a === "ct0" && u) return { success: !0, token: u };
              }
              return { success: !1, error: "ct0 cookie not found" };
            } catch (caughtError) {
              const n =
                caughtError instanceof Error
                  ? caughtError
                  : new Error(String(caughtError));
              return { success: !1, error: n.message };
            }
          }, []);
        if (s != null && s.success && s.token)
          return (
            (this.csrfToken = s.token),
            xLogger.debug("Got CSRF token from executeScript"),
            this.csrfToken
          );
        xLogger.debug(
          "executeScript failed to get ct0:",
          s == null ? void 0 : s.error,
        );
      } catch (caughtError) {
        const r =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        xLogger.debug("executeScript error:", r);
      }
    throw new Error("请先登录 X (Twitter)");
  }
  async ensureXTab() {
    if (!this.runtime.tabs) throw new Error("X 发布需要浏览器 tabs API 支持");
    const e = await this.runtime.tabs.query("https://x.com/*");
    if (e.length > 0 && e[0].id) return e[0].id;
    xLogger.info("No existing X tab found, creating new one...");
    const t = await this.runtime.tabs.create(
      "https://x.com/compose/articles",
      !1,
    );
    return (
      await this.runtime.tabs.waitForLoad(t.id, 3e4),
      xLogger.info("New X tab created and loaded:", t.id),
      t.id
    );
  }
  async getXPForwardedFor() {
    if (
      this.xpForwardedFor &&
      Date.now() < this.xpForwardedFor.expiryTimeMillis
    )
      return (
        xLogger.debug("Using cached XP forwarded-for"),
        this.xpForwardedFor.str
      );
    if (!this.runtime.tabs)
      return (
        xLogger.warn("tabs API not available, skipping XP forwarded-for"),
        ""
      );
    try {
      const e = await this.ensureXTab();
      xLogger.debug("Getting XP forwarded-for from tab:", e);
      const t = await this.runtime.tabs.executeScript(e, async () => {
        try {
          const r = window.XPForwardedForSDK;
          return !r || typeof r.getForwardedForStr != "function"
            ? { success: !1, error: "XPForwardedForSDK not found" }
            : { success: !0, data: await r.getForwardedForStr() };
        } catch (caughtError) {
          const r =
            caughtError instanceof Error
              ? caughtError
              : new Error(String(caughtError));
          return { success: !1, error: r.message };
        }
      }, []);
      return !t || !t.success || !t.data
        ? (xLogger.warn(
            "Failed to get XP forwarded-for:",
            t == null ? void 0 : t.error,
          ),
          "")
        : ((this.xpForwardedFor = {
            str: t.data.str,
            expiryTimeMillis: parseInt(t.data.expiryTimeMillis, 10),
          }),
          xLogger.debug(
            "Got XP forwarded-for, expires at:",
            new Date(this.xpForwardedFor.expiryTimeMillis),
          ),
          this.xpForwardedFor.str);
    } catch (caughtError) {
      const e =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (xLogger.warn("Error getting XP forwarded-for:", e), "");
    }
  }
  generateTransactionId() {
    const e = Date.now().toString(36),
      t = Math.random().toString(36).substring(2, 15);
    return `${e}${t}`;
  }
  async getCommonHeaders() {
    const [e, t] = await Promise.all([
        this.getCsrfToken(),
        this.getXPForwardedFor(),
      ]),
      s: Record<string, string> = {
        authorization: `Bearer ${X_WEB_BEARER.replace(/=/g, "%3D")}`,
        "x-csrf-token": e,
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "en",
        "x-client-transaction-id": this.generateTransactionId(),
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
      };
    return (t && (s["x-xp-forwarded-for"] = t), s);
  }
  async setupHeaderRules() {
    this.headerRuleIds.length > 0 ||
      (await this.addHeaderRules([
        {
          urlFilter: "*://x.com/i/api/*",
          headers: {
            Origin: "https://x.com",
            Referer: "https://x.com/compose/articles",
          },
          resourceTypes: ["xmlhttprequest"],
        },
        {
          urlFilter: "*://upload.x.com/*",
          headers: { Origin: "https://x.com", Referer: "https://x.com/" },
          resourceTypes: ["xmlhttprequest"],
        },
      ]));
  }
  async checkAuth(): Promise<AuthResult> {
    var e, t;
    try {
      await this.setupHeaderRules();
      const s = await (
        await this.runtime.fetch("https://x.com/home", {
          credentials: "include",
        })
      ).text();
      xLogger.debug("Fetched x.com/home, length:", s.length);
      const n = s.indexOf("window.__INITIAL_STATE__=");
      if (n === -1)
        return (
          xLogger.debug("Failed to find __INITIAL_STATE__"),
          await this.clearHeaderRules(),
          { isAuthenticated: !1 }
        );
      const i = s.indexOf("{", n);
      if (i === -1)
        return (
          xLogger.debug("Failed to find JSON start"),
          await this.clearHeaderRules(),
          { isAuthenticated: !1 }
        );
      let a = 0,
        u = i;
      for (let w = i; w < s.length; w++)
        if ((s[w] === "{" ? a++ : s[w] === "}" && a--, a === 0)) {
          u = w + 1;
          break;
        }
      const l = s.slice(i, u);
      xLogger.debug("Extracted JSON length:", l.length);
      let h;
      try {
        h = JSON.parse(l);
      } catch (caughtError) {
        const w =
          caughtError instanceof Error
            ? caughtError
            : new Error(String(caughtError));
        return (
          xLogger.debug("Failed to parse __INITIAL_STATE__:", w),
          await this.clearHeaderRules(),
          { isAuthenticated: !1 }
        );
      }
      const d =
        (t = (e = h.entities) == null ? void 0 : e.users) == null
          ? void 0
          : t.entities;
      if (!d)
        return (
          xLogger.debug("No user entities found in state"),
          await this.clearHeaderRules(),
          { isAuthenticated: !1 }
        );
      const m = Object.keys(d);
      if (m.length === 0)
        return (
          xLogger.debug("No user IDs found"),
          await this.clearHeaderRules(),
          { isAuthenticated: !1 }
        );
      const f = m[0],
        p = d[f];
      return p
        ? ((this.userInfo = {
            userId: p.id_str,
            username: p.screen_name,
            name: p.name,
            avatar: p.profile_image_url_https,
          }),
          xLogger.info("X auth success:", this.userInfo.username),
          await this.clearHeaderRules(),
          {
            isAuthenticated: !0,
            userId: this.userInfo.userId,
            username: this.userInfo.username,
            avatar: this.userInfo.avatar,
          })
        : (await this.clearHeaderRules(), { isAuthenticated: !1 });
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        await this.clearHeaderRules(),
        xLogger.error("checkAuth error:", r),
        { isAuthenticated: !1, error: r.message }
      );
    }
  }
  async publish(e: Article, t?: PublishOptions): Promise<SyncResult> {
    await this.setupHeaderRules();
    try {
      xLogger.info("Starting publish to X...");
      const r = await this.createDraft();
      (xLogger.debug("Created draft:", r),
        await this.updateTitle(r, e.title),
        xLogger.debug("Updated title"));
      const s = await this.markdownToDraftContent(
        e.markdown,
        t == null ? void 0 : t.onImageProgress,
      );
      (xLogger.debug("Converted content to Draft.js format"),
        await this.updateContent(r, s),
        xLogger.debug("Updated content"));
      const n = `https://x.com/compose/articles/edit/${r}`;
      return (
        await this.clearHeaderRules(),
        this.createResult(!0, {
          postId: r,
          postUrl: n,
          draftOnly: (t == null ? void 0 : t.draftOnly) ?? !0,
        })
      );
    } catch (caughtError) {
      const r =
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError));
      return (
        await this.clearHeaderRules(),
        xLogger.error("Publish failed:", r),
        this.createResult(!1, { error: r.message })
      );
    }
  }
  async createDraft() {
    var r, s, n, i, a;
    const e = await this.graphqlRequest("createDraft", {
      content_state: { blocks: [], entity_map: [] },
      title: "",
    });
    if ((r = e.errors) != null && r.length)
      throw new Error(e.errors[0].message);
    const t =
      (a =
        (i =
          (n = (s = e.data) == null ? void 0 : s.articleentity_create_draft) ==
          null
            ? void 0
            : n.article_entity_results) == null
          ? void 0
          : i.result) == null
        ? void 0
        : a.rest_id;
    if (!t) throw new Error("创建草稿失败");
    return t;
  }
  async updateTitle(e: string, t: string) {
    var s;
    const r = await this.graphqlRequest("updateTitle", {
      articleEntityId: e,
      title: t,
    });
    if ((s = r.errors) != null && s.length)
      throw new Error(r.errors[0].message);
  }
  async updateContent(e: string, t: Record<string, unknown>) {
    var s;
    const r = await this.graphqlRequest("updateContent", {
      content_state: t,
      article_entity: e,
    });
    if ((s = r.errors) != null && s.length)
      throw new Error(r.errors[0].message);
  }
  async uploadImageByUrl(e: string) {
    let t, r;
    if (e.startsWith("data:")) {
      const p = e.match(/^data:([^;]+);base64,(.+)$/);
      if (!p) throw new Error("Invalid data URI");
      r = p[1];
      const w = atob(p[2]),
        _ = new Uint8Array(w.length);
      for (let y = 0; y < w.length; y++) _[y] = w.charCodeAt(y);
      t = new Blob([_], { type: r });
    } else ((t = await (await fetch(e)).blob()), (r = t.type || "image/jpeg"));
    const s = await this.getCommonHeaders(),
      n = `https://upload.x.com/i/media/upload.json?command=INIT&total_bytes=${t.size}&media_type=${encodeURIComponent(r)}&media_category=tweet_image`,
      a = await (
        await this.runtime.fetch(n, {
          method: "POST",
          credentials: "include",
          headers: { ...s, "content-length": "0" },
        })
      ).json();
    if (!a.media_id_string) throw new Error(a.error || "图片上传初始化失败");
    const u = a.media_id_string;
    xLogger.debug("Media INIT complete, mediaId:", u);
    const l = new FormData();
    l.append("media", t, "image.jpg");
    const h = `https://upload.x.com/i/media/upload.json?command=APPEND&media_id=${u}&segment_index=0`;
    (await this.runtime.fetch(h, {
      method: "POST",
      credentials: "include",
      headers: s,
      body: l,
    }),
      xLogger.debug("Media APPEND complete"));
    const d = `https://upload.x.com/i/media/upload.json?command=FINALIZE&media_id=${u}`,
      f = await (
        await this.runtime.fetch(d, {
          method: "POST",
          credentials: "include",
          headers: { ...s, "content-length": "0" },
        })
      ).json();
    if (!f.media_id_string) throw new Error(f.error || "图片上传完成失败");
    return (
      xLogger.debug("Media FINALIZE complete"),
      { url: u, attrs: { "media-id": u } }
    );
  }
  generateBlockKey() {
    const e = "abcdefghijklmnopqrstuvwxyz0123456789";
    let t = "";
    for (let r = 0; r < 5; r++)
      t += e.charAt(Math.floor(Math.random() * e.length));
    return t;
  }
  generateUUID() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (e) => {
      const t = (Math.random() * 16) | 0;
      return (e === "x" ? t : (t & 3) | 8).toString(16);
    });
  }
  convertInlineStyle(e: string) {
    return (
      {
        BOLD: "Bold",
        bold: "Bold",
        ITALIC: "Italic",
        italic: "Italic",
        STRIKETHROUGH: "Strikethrough",
        strikethrough: "Strikethrough",
      }[e] || null
    );
  }
  async markdownToDraftContent(
    e: string,
    t?: (current: number, total: number) => void,
  ) {
    var p, w, _;
    const r = [];
    let s = 0,
      n = e;
    for (const y of xe(e)) {
      const T = `

[XIMG_PLACEHOLDER_${s}]

`;
      (r.push({
        placeholder: `[XIMG_PLACEHOLDER_${s}]`,
        src: y.src,
        alt: y.alt || "",
      }),
        (n = n.replace(y.full, T)),
        s++);
    }
    const i = new Map();
    let a = 0;
    for (const { src: y } of r)
      if (!i.has(y)) {
        (a++, t == null || t(a, r.length));
        try {
          xLogger.debug(
            `Uploading image ${a}/${r.length}: ${y.substring(0, 50)}...`,
          );
          const T = await this.uploadImageByUrl(y);
          (i.set(y, T.url),
            xLogger.debug(`Uploaded image ${a}, mediaId: ${T.url}`),
            await this.delay(500));
        } catch (caughtError) {
          const T =
            caughtError instanceof Error
              ? caughtError
              : new Error(String(caughtError));
          xLogger.error("Failed to upload image:", T);
        }
      }
    const u = Lt(n),
      l = [],
      h = [];
    let d = 1;
    const m = new Map();
    let f = 0;
    for (const [y, T] of Object.entries(u.entityMap)) {
      const P = parseInt(y, 10),
        A = T.type.toUpperCase();
      if (A === "IMAGE") {
        const S = ((p = T.data) == null ? void 0 : p.src) || "",
          v = i.get(S);
        if (v) {
          const U = f++;
          (m.set(P, U),
            h.push({
              key: String(U),
              value: {
                type: "MEDIA",
                mutability: "Immutable",
                data: {
                  entity_key: this.generateUUID(),
                  media_items: [
                    {
                      local_media_id: d++,
                      media_category: "DraftTweetImage",
                      media_id: v,
                    },
                  ],
                },
              },
            }));
        }
      } else if (A === "LINK") {
        const S = f++;
        (m.set(P, S),
          h.push({
            key: String(S),
            value: {
              type: "LINK",
              mutability: "Mutable",
              data: {
                url:
                  ((w = T.data) == null ? void 0 : w.url) ||
                  ((_ = T.data) == null ? void 0 : _.href) ||
                  "",
              },
            },
          }));
      }
    }
    for (const y of u.blocks) {
      const T = y.key || this.generateBlockKey(),
        P = y.text.match(/^\[XIMG_PLACEHOLDER_(\d+)\]$/);
      if (P) {
        const k = parseInt(P[1], 10),
          O = r[k];
        if (O) {
          const b = i.get(O.src);
          if (b) {
            const I = f++;
            (h.push({
              key: String(I),
              value: {
                type: "MEDIA",
                mutability: "Immutable",
                data: {
                  entity_key: this.generateUUID(),
                  media_items: [
                    {
                      local_media_id: d++,
                      media_category: "DraftTweetImage",
                      media_id: b,
                    },
                  ],
                },
              },
            }),
              l.push({
                key: T,
                type: "atomic",
                text: " ",
                data: {},
                entity_ranges: [{ key: I, offset: 0, length: 1 }],
                inline_style_ranges: [],
              }));
            continue;
          }
        }
        continue;
      }
      let A = "unstyled";
      const S = y.type;
      if (S === "header-one" || S === "header-two") A = S;
      else if (
        S === "header-three" ||
        S === "header-four" ||
        S === "header-five" ||
        S === "header-six"
      )
        A = "header-two";
      else if (S === "blockquote") A = "blockquote";
      else if (S === "unordered-list-item") A = "unordered-list-item";
      else if (S === "ordered-list-item") A = "ordered-list-item";
      else if (S === "code-block") {
        const k = f++;
        (h.push({
          key: String(k),
          value: {
            type: "MARKDOWN",
            mutability: "Mutable",
            data: { markdown: "```\n" + y.text + "\n```" },
          },
        }),
          l.push({
            key: T,
            type: "atomic",
            text: " ",
            data: {},
            entity_ranges: [{ key: k, offset: 0, length: 1 }],
            inline_style_ranges: [],
          }));
        continue;
      } else if (
        S === "hr" ||
        S === "horizontal-rule" ||
        (S === "unstyled" && /^(-{3,}|\*{3,}|_{3,})$/.test(y.text.trim()))
      ) {
        const k = f++;
        (h.push({
          key: String(k),
          value: { type: "DIVIDER", mutability: "Immutable", data: {} },
        }),
          l.push({
            key: T,
            type: "atomic",
            text: " ",
            data: {},
            entity_ranges: [{ key: k, offset: 0, length: 1 }],
            inline_style_ranges: [],
          }));
        continue;
      } else if (S === "unstyled" && /^\$\$[\s\S]+\$\$$/.test(y.text.trim())) {
        const k = y.text.trim().slice(2, -2).trim(),
          O = f++;
        (h.push({
          key: String(O),
          value: { type: "LATEX", mutability: "Immutable", data: {} },
        }),
          l.push({
            key: T,
            type: "atomic",
            text: k,
            data: {},
            entity_ranges: [{ key: O, offset: 0, length: k.length }],
            inline_style_ranges: [],
          }));
        continue;
      } else S === "atomic" ? (A = "atomic") : (A = "unstyled");
      const v = [];
      if (y.entityRanges)
        for (const k of y.entityRanges) {
          const O = m.get(k.key);
          O !== void 0 &&
            v.push({ key: O, offset: k.offset, length: k.length });
        }
      const U = [];
      if (y.inlineStyleRanges)
        for (const k of y.inlineStyleRanges) {
          const O = this.convertInlineStyle(k.style);
          O && U.push({ style: O, offset: k.offset, length: k.length });
        }
      l.push({
        key: T,
        type: A,
        text: y.text || "",
        data: y.data || {},
        entity_ranges: v,
        inline_style_ranges: U,
      });
    }
    return (
      l.length === 0 &&
        l.push({
          key: this.generateBlockKey(),
          type: "unstyled",
          text: "",
          data: {},
          entity_ranges: [],
          inline_style_ranges: [],
        }),
      { blocks: l, entity_map: h }
    );
  }
}
