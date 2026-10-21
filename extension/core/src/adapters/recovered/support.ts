import type {
  ContainerMarkdownNode,
  ContentCapabilities,
  ConversionContext,
  ConversionOptions,
  HeadingMarkdownNode,
  ImageMarkdownNode,
  ListMarkdownNode,
  MarkdownNode,
  ProseMirrorNode,
} from "./types";
/** Shared constants and content converters recovered from the supplied bundle. */
import { createLogger as N } from "../../lib/logger";
export const dayuLogger = N("DaYu");
export const douyinLogger = N("Douyin");
export const DOUYIN_IMAGE_SERVICE_ID = "jm8ajry58r";
export const DOUYIN_APP_ID = "1128";
export function createDouyinDraftId() {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let o = "";
  for (let e = 0; e < 8; e++) o += c[Math.floor(Math.random() * c.length)];
  return o + Date.now().toString();
}
export const jianshuLogger = N("Jianshu");
export const neteaseLogger = N("Netease");
export const smzdmLogger = N("Smzdm");
export function isWafChallenge(c: string): boolean {
  return c.includes("probe.js") || c.includes("var buid");
}
export function waitWithJitter(c: number): Promise<void> {
  const o = Math.floor(Math.random() * 500);
  return new Promise((e) => setTimeout(e, c + o));
}
export const SMZDM_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "sec-ch-ua":
    '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};
export const toutiaoLogger = N("Toutiao");
export const xLogger = N("X");
export const X_OPERATIONS: Record<string, string> = {
  createDraft: "ArticleEntityDraftCreate",
  updateTitle: "ArticleEntityUpdateTitle",
  updateContent: "ArticleEntityUpdateContent",
};
export const X_FALLBACK_QUERY_IDS: Record<string, string> = {
  createDraft: "t5-e2kJcCqqJ_MsZ0c07Rg",
  updateTitle: "5wp_YbfxSfYJTiLWb4tYnA",
  updateContent: "IzVdegTuct9uoXRK5L93Qg",
};
export const X_DISCOVERY_URLS = [
  "https://x.com/?lang=en",
  "https://x.com/explore",
  "https://x.com/compose/articles",
];
export const X_BUNDLE_PATTERN =
  /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9.-]+\.js/g;
export const X_OPERATION_PATTERNS = [
  {
    regex:
      /e\.exports=\{queryId\s*:\s*["']([^"']+)["']\s*,\s*operationName\s*:\s*["']([^"']+)["']/g,
    queryIdGroup: 1,
    operationGroup: 2,
  },
  {
    regex:
      /e\.exports=\{operationName\s*:\s*["']([^"']+)["']\s*,\s*queryId\s*:\s*["']([^"']+)["']/g,
    operationGroup: 1,
    queryIdGroup: 2,
  },
  {
    regex:
      /operationName\s*[:=]\s*["']([^"']+)["'][\s\S]{0,500}?queryId\s*[:=]\s*["']([^"']+)["']/g,
    operationGroup: 1,
    queryIdGroup: 2,
  },
  {
    regex:
      /queryId\s*[:=]\s*["']([^"']+)["'][\s\S]{0,500}?operationName\s*[:=]\s*["']([^"']+)["']/g,
    queryIdGroup: 1,
    operationGroup: 2,
  },
];
export const X_QUERY_CACHE_TTL = 24 * 60 * 60 * 1e3;
export const X_QUERY_CACHE_KEY = "x_query_id_cache";
export const X_FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: !0,
  responsive_web_profile_redirect_enabled: !1,
  rweb_tipjar_consumption_enabled: !0,
  verified_phone_label_enabled: !1,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: !1,
  responsive_web_graphql_timeline_navigation_enabled: !0,
};
export const X_WEB_BEARER = import.meta.env.VITE_X_WEB_BEARER || "";
export const XHS_CAPABILITIES = {
  id: "xiaohongshu",
  outputFormat: "prosemirror",
  maxHeadingLevel: 3,
  supportNestedList: !1,
  supportTable: !1,
  supportCodeBlock: !1,
  supportInlineCode: !1,
  supportLink: !1,
  supportImage: !0,
  supportBlockquote: !0,
  supportHorizontalRule: !1,
  supportBold: !1,
  supportItalic: !1,
  supportStrikethrough: !1,
  supportHighlight: !0,
  supportLatex: !1,
};
export const JUEJIN_CAPABILITIES = {
  id: "juejin",
  outputFormat: "markdown",
  maxHeadingLevel: 6,
  supportNestedList: !0,
  supportTable: !0,
  supportCodeBlock: !0,
  supportInlineCode: !0,
  supportLink: !0,
  supportImage: !0,
  supportBlockquote: !0,
  supportHorizontalRule: !0,
  supportBold: !0,
  supportItalic: !0,
  supportStrikethrough: !0,
  supportHighlight: !1,
  supportLatex: !0,
};
export const ZHIHU_CAPABILITIES = {
  id: "zhihu",
  outputFormat: "html",
  maxHeadingLevel: 4,
  supportNestedList: !1,
  supportTable: !0,
  supportCodeBlock: !0,
  supportInlineCode: !0,
  supportLink: !1,
  supportImage: !0,
  supportBlockquote: !0,
  supportHorizontalRule: !0,
  supportBold: !0,
  supportItalic: !0,
  supportStrikethrough: !0,
  supportHighlight: !1,
  supportLatex: !0,
};
export const CONTENT_CAPABILITIES: Record<string, ContentCapabilities> = {
  xiaohongshu: XHS_CAPABILITIES,
  juejin: JUEJIN_CAPABILITIES,
  zhihu: ZHIHU_CAPABILITIES,
};
export function getContentCapabilities(
  c: string,
): ContentCapabilities | undefined {
  return CONTENT_CAPABILITIES[c];
}
export const DEFAULT_CONTENT_CAPABILITIES = {
  id: "default",
  outputFormat: "markdown",
  maxHeadingLevel: 6,
  supportNestedList: !0,
  supportTable: !0,
  supportCodeBlock: !0,
  supportInlineCode: !0,
  supportLink: !0,
  supportImage: !0,
  supportBlockquote: !0,
  supportHorizontalRule: !0,
  supportBold: !0,
  supportItalic: !0,
  supportStrikethrough: !0,
  supportHighlight: !0,
  supportLatex: !0,
};
export function parseMarkdownDocument(c: string): ContainerMarkdownNode {
  const o = c.split(`
`),
    e: MarkdownNode[] = [];
  let t = 0;
  for (; t < o.length; ) {
    const r = o[t];
    if (r.trim() === "") {
      t++;
      continue;
    }
    if (r.startsWith("```")) {
      const i = r.slice(3).trim(),
        a = [];
      for (t++; t < o.length && !o[t].startsWith("```"); ) (a.push(o[t]), t++);
      (t++,
        e.push({
          type: "code",
          lang: i || void 0,
          value: a.join(`
`),
        }));
      continue;
    }
    const s = r.match(/^(#{1,6})\s+(.+)$/);
    if (s) {
      (e.push({
        type: "heading",
        depth: s[1].length,
        children: parseMarkdownInline(s[2]),
      }),
        t++);
      continue;
    }
    if (/^[-*_]{3,}\s*$/.test(r)) {
      (e.push({ type: "thematicBreak" }), t++);
      continue;
    }
    if (r.startsWith(">")) {
      const i = [];
      for (
        ;
        t < o.length &&
        (o[t].startsWith(">") ||
          (o[t].trim() !== "" && i.length > 0 && !o[t].match(/^[#\-*\d]/)));
      )
        (i.push(o[t].replace(/^>\s?/, "")), t++);
      e.push({
        type: "blockquote",
        children: parseMarkdownDocument(
          i.join(`
`),
        ).children,
      });
      continue;
    }
    if (/^[\-*+]\s+/.test(r)) {
      const i: MarkdownNode[] = [];
      for (; t < o.length && /^[\-*+]\s+/.test(o[t]); ) {
        const a = o[t].replace(/^[\-*+]\s+/, "");
        (i.push({
          type: "listItem",
          children: [{ type: "paragraph", children: parseMarkdownInline(a) }],
        }),
          t++);
      }
      e.push({ type: "list", ordered: !1, children: i });
      continue;
    }
    if (/^\d+\.\s+/.test(r)) {
      const i: MarkdownNode[] = [],
        a = r.match(/^(\d+)\.\s+/),
        u = a ? parseInt(a[1], 10) : 1;
      for (; t < o.length && /^\d+\.\s+/.test(o[t]); ) {
        const l = o[t].replace(/^\d+\.\s+/, "");
        (i.push({
          type: "listItem",
          children: [{ type: "paragraph", children: parseMarkdownInline(l) }],
        }),
          t++);
      }
      e.push({ type: "list", ordered: !0, start: u, children: i });
      continue;
    }
    if (r.includes("|") && r.trim().startsWith("|")) {
      const i: MarkdownNode[] = [];
      for (; t < o.length && o[t].includes("|"); ) {
        const a = o[t].trim();
        if (/^\|[\s\-:|]+\|$/.test(a)) {
          t++;
          continue;
        }
        const u = a
          .split("|")
          .slice(1, -1)
          .map((l) => l.trim());
        (i.push({
          type: "tableRow",
          children: u.map((l) => ({
            type: "tableCell",
            children: parseMarkdownInline(l),
          })),
        }),
          t++);
      }
      i.length > 0 && e.push({ type: "table", children: i });
      continue;
    }
    const n = [];
    for (
      ;
      t < o.length &&
      o[t].trim() !== "" &&
      !o[t].startsWith("#") &&
      !o[t].startsWith(">") &&
      !o[t].startsWith("```") &&
      !/^[-*+]\s+/.test(o[t]) &&
      !/^\d+\.\s+/.test(o[t]) &&
      !/^[-*_]{3,}\s*$/.test(o[t]) &&
      !(o[t].includes("|") && o[t].trim().startsWith("|"));
    )
      (n.push(o[t]), t++);
    n.length > 0 &&
      e.push({
        type: "paragraph",
        children: parseMarkdownInline(
          n.join(`
`),
        ),
      });
  }
  return { type: "root", children: e };
}
export function parseMarkdownInline(c: string): MarkdownNode[] {
  const o: MarkdownNode[] = [];
  let e = c;
  for (; e.length > 0; ) {
    const t = e.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (t) {
      (o.push({ type: "image", alt: t[1], url: t[2] }),
        (e = e.slice(t[0].length)));
      continue;
    }
    const r = e.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (r) {
      (o.push({
        type: "link",
        url: r[2],
        children: [{ type: "text", value: r[1] }],
      }),
        (e = e.slice(r[0].length)));
      continue;
    }
    const s = e.match(/^(\*\*|__)([^*_]+)\1/);
    if (s) {
      (o.push({ type: "strong", children: [{ type: "text", value: s[2] }] }),
        (e = e.slice(s[0].length)));
      continue;
    }
    const n = e.match(/^(\*|_)([^*_]+)\1/);
    if (n) {
      (o.push({ type: "emphasis", children: [{ type: "text", value: n[2] }] }),
        (e = e.slice(n[0].length)));
      continue;
    }
    const i = e.match(/^~~([^~]+)~~/);
    if (i) {
      (o.push({ type: "delete", children: [{ type: "text", value: i[1] }] }),
        (e = e.slice(i[0].length)));
      continue;
    }
    const a = e.match(/^`([^`]+)`/);
    if (a) {
      (o.push({ type: "inlineCode", value: a[1] }), (e = e.slice(a[0].length)));
      continue;
    }
    if (
      e.startsWith("  \n") ||
      e.startsWith(`
`)
    ) {
      (o.push({ type: "break" }), (e = e.replace(/^(\s*\n|\n)/, "")));
      continue;
    }
    const u = e.search(/[!\[*_~`\n]/);
    if (u === -1) {
      o.push({ type: "text", value: e });
      break;
    } else
      u === 0
        ? (o.push({ type: "text", value: e[0] }), (e = e.slice(1)))
        : (o.push({ type: "text", value: e.slice(0, u) }), (e = e.slice(u)));
  }
  return o;
}
export async function convertDocumentToProseMirror(
  c: ContainerMarkdownNode,
  o: ContentCapabilities,
  e?: Omit<ConversionOptions, "platform">,
): Promise<ProseMirrorNode> {
  var s;
  const t: ConversionContext = {
    capabilities: o,
    uploadImage: e == null ? void 0 : e.uploadImage,
    uploadedImages: new Map(),
    imageQueue: [],
    onImageProgress: e == null ? void 0 : e.onImageProgress,
  };
  if ((collectDocumentImages(c, t), t.uploadImage && t.imageQueue.length > 0)) {
    let n = 0;
    for (const i of t.imageQueue)
      if (!t.uploadedImages.has(i.src))
        try {
          (n++,
            (s = t.onImageProgress) == null ||
              s.call(t, n, t.imageQueue.length));
          const a = await t.uploadImage!(i.src);
          (t.uploadedImages.set(i.src, {
            url: a.url,
            width: a.width || 800,
            height: a.height || 600,
            fileId: a.fileId,
          }),
            await wait(300));
        } catch (a) {
          console.error("Failed to upload image:", i.src, a);
        }
  }
  let r = convertBlockChildren(c.children, t);
  for (; r.length > 0 && isEmptyParagraph(r[0]); ) r.shift();
  return (
    r.length === 0 && r.push({ type: "paragraph", content: [] }),
    (r = r.map(cleanProseMirrorNode)),
    { type: "doc", content: r }
  );
}
export function isEmptyParagraph(c: ProseMirrorNode): boolean {
  return c.type === "paragraph" && (!c.content || c.content.length === 0);
}
export function cleanProseMirrorNode(c: ProseMirrorNode): ProseMirrorNode {
  const o: ProseMirrorNode = { type: c.type };
  if (
    (c.attrs !== void 0 && (o.attrs = c.attrs),
    c.marks !== void 0 &&
      (o.marks = c.marks.map((e) => {
        const t: NonNullable<ProseMirrorNode["marks"]>[number] = {
          type: e.type,
        };
        return (e.attrs !== void 0 && (t.attrs = e.attrs), t);
      })),
    c.content !== void 0)
  ) {
    const e = c.content
      .filter((t) => !(t.type === "text" && (!t.text || t.text === "")))
      .map(cleanProseMirrorNode);
    e.length > 0 && (o.content = e);
  }
  return (c.text !== void 0 && (o.text = c.text), o);
}
export function collectDocumentImages(
  c: MarkdownNode,
  o: ConversionContext,
): void {
  if ("type" in c && c.type === "image") {
    const e = c;
    o.imageQueue.push({ src: e.url, alt: e.alt || "" });
  }
  if ("children" in c && Array.isArray(c.children))
    for (const e of c.children) collectDocumentImages(e, o);
}
export function convertBlockChildren(
  c: MarkdownNode[],
  o: ConversionContext,
): ProseMirrorNode[] {
  const e = [];
  for (const t of c) {
    const r = convertBlock(t, o);
    e.push(...r);
  }
  return e;
}
export function convertBlock(
  c: MarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const { capabilities: e } = o;
  switch (c.type) {
    case "heading":
      return convertHeading(c, o);
    case "paragraph":
      return convertParagraph(c, o);
    case "blockquote":
      return e.supportBlockquote
        ? convertBlockquote(c, o)
        : flattenBlockquote(c, o);
    case "list":
      return convertList(c, o);
    case "listItem":
      return convertListItem(c, o);
    case "table":
      return e.supportTable ? [] : flattenTable(c);
    case "thematicBreak":
      return e.supportHorizontalRule ? [{ type: "horizontalRule" }] : [];
    case "code":
      return e.supportCodeBlock
        ? [
            {
              type: "codeBlock",
              attrs: { language: c.lang || "" },
              content: [{ type: "text", text: c.value }],
            },
          ]
        : [{ type: "paragraph", content: [{ type: "text", text: c.value }] }];
    case "image":
      return e.supportImage
        ? convertImage(c, o)
        : [
            {
              type: "paragraph",
              content: [{ type: "text", text: `[图片: ${c.alt || c.url}]` }],
            },
          ];
    default:
      return [];
  }
}
export function convertHeading(
  c: HeadingMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const { capabilities: e } = o;
  return [
    {
      type: "heading",
      attrs: { level: Math.min(c.depth, e.maxHeadingLevel) },
      content: convertInlineNodes(c.children, o),
    },
  ];
}
export function convertParagraph(
  c: ContainerMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const e = [];
  if (
    c.children.some((s) => s.type === "image") &&
    o.capabilities.supportImage
  ) {
    let s = [];
    for (const n of c.children)
      if (n.type === "image") {
        if (s.length > 0) {
          const a = convertInlineNodes(s, o);
          (a.length > 0 && e.push({ type: "paragraph", content: a }), (s = []));
        }
        const i = convertImage(n, o);
        e.push(...i);
      } else s.push(n);
    if (s.length > 0) {
      const n = convertInlineNodes(s, o);
      n.length > 0 && e.push({ type: "paragraph", content: n });
    }
    return e.length > 0 ? e : [{ type: "paragraph" }];
  }
  const r = convertInlineNodes(c.children, o);
  return r.length === 0
    ? [{ type: "paragraph" }]
    : [{ type: "paragraph", content: r }];
}
export function convertBlockquote(
  c: ContainerMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  return [{ type: "blockquote", content: convertBlockChildren(c.children, o) }];
}
export function flattenBlockquote(
  c: ContainerMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const e = [];
  for (const t of c.children)
    if (t.type === "paragraph") {
      const r = convertInlineNodes(t.children, o);
      (r.unshift({ type: "text", text: "> " }),
        e.push({ type: "paragraph", content: r }));
    }
  return e;
}
export function convertList(
  c: ListMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const e = convertBlockChildren(c.children, o);
  return c.ordered
    ? [
        {
          type: "orderedList",
          attrs: { start: c.start || 1, type: null },
          content: e,
        },
      ]
    : [{ type: "bulletList", content: e }];
}
export function convertListItem(
  c: ContainerMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const { capabilities: e } = o,
    t = [];
  for (const r of c.children)
    if (r.type === "paragraph")
      t.push({ type: "paragraph", content: convertInlineNodes(r.children, o) });
    else if (r.type === "list") {
      if (e.supportNestedList) t.push(...convertList(r, o));
      else
        for (const s of r.children)
          if (s.type === "listItem")
            for (const n of s.children)
              n.type === "paragraph" &&
                t.push({
                  type: "paragraph",
                  content: [
                    { type: "text", text: "  • " },
                    ...convertInlineNodes(n.children, o),
                  ],
                });
    }
  return [
    { type: "listItem", content: t.length > 0 ? t : [{ type: "paragraph" }] },
  ];
}
export function flattenTable(
  c: ContainerMarkdownNode,
  o?: ConversionContext,
): ProseMirrorNode[] {
  const e = [];
  for (const t of c.children) {
    if (t.type !== "tableRow") continue;
    const s = t.children
      .filter((n): n is ContainerMarkdownNode => n.type === "tableCell")
      .map((n) =>
        n.children
          .map((i) =>
            i.type === "text"
              ? i.value
              : "children" in i
                ? i.children
                    .map((a) => ("value" in a ? a.value : "") || "")
                    .join("")
                : "",
          )
          .join(""),
      )
      .join(" | ");
    s.trim() &&
      e.push({ type: "paragraph", content: [{ type: "text", text: s }] });
  }
  return e;
}
export function convertImage(
  c: ImageMarkdownNode,
  o: ConversionContext,
): ProseMirrorNode[] {
  const e = o.uploadedImages.get(c.url),
    t = 410;
  if (e) {
    const r = t,
      s = e.width > 0 ? Math.round((t * e.height) / e.width) : 0;
    return [
      {
        type: "image",
        attrs: {
          imgs: [{ src: e.url, desc: "", percent: 30, width: r, height: s }],
        },
      },
    ];
  }
  return [
    {
      type: "image",
      attrs: {
        imgs: [{ src: c.url, desc: "", percent: 30, width: t, height: 0 }],
      },
    },
  ];
}
export function convertInlineNodes(
  c: MarkdownNode[],
  o: ConversionContext,
): ProseMirrorNode[] {
  const e = [];
  for (const t of c)
    switch (t.type) {
      case "text":
        t.value && e.push({ type: "text", text: t.value });
        break;
      case "strong":
        if (o.capabilities.supportBold) {
          const r = convertInlineNodes(t.children, o);
          for (const s of r)
            s.type === "text" &&
              (s.marks = [...(s.marks || []), { type: "bold" }]);
          e.push(...r);
        } else if (o.capabilities.supportHighlight) {
          const r = convertInlineNodes(t.children, o);
          for (const s of r)
            s.type === "text" &&
              (s.marks = [...(s.marks || []), { type: "highlight" }]);
          e.push(...r);
        } else e.push(...convertInlineNodes(t.children, o));
        break;
      case "emphasis":
        if (o.capabilities.supportItalic) {
          const r = convertInlineNodes(t.children, o);
          for (const s of r)
            s.type === "text" &&
              (s.marks = [...(s.marks || []), { type: "italic" }]);
          e.push(...r);
        } else e.push(...convertInlineNodes(t.children, o));
        break;
      case "delete":
        if (o.capabilities.supportStrikethrough) {
          const r = convertInlineNodes(t.children, o);
          for (const s of r)
            s.type === "text" &&
              (s.marks = [...(s.marks || []), { type: "strike" }]);
          e.push(...r);
        } else e.push(...convertInlineNodes(t.children, o));
        break;
      case "inlineCode":
        o.capabilities.supportInlineCode
          ? e.push({ type: "text", text: t.value, marks: [{ type: "code" }] })
          : e.push({ type: "text", text: t.value });
        break;
      case "link":
        if (o.capabilities.supportLink) {
          const r = convertInlineNodes(t.children, o);
          for (const s of r)
            s.type === "text" &&
              (s.marks = [
                ...(s.marks || []),
                { type: "link", attrs: { href: t.url } },
              ]);
          e.push(...r);
        } else e.push(...convertInlineNodes(t.children, o));
        break;
      case "image":
        break;
      case "break":
        break;
      default:
        "children" in t &&
          Array.isArray(t.children) &&
          e.push(...convertInlineNodes(t.children, o));
    }
  return e;
}
export function wait(c: number): Promise<void> {
  return new Promise((o) => setTimeout(o, c));
}
export async function convertForPlatform(
  c: string,
  o: ConversionOptions,
): Promise<{
  prosemirror: ProseMirrorNode;
}> {
  const e = getContentCapabilities(o.platform) || DEFAULT_CONTENT_CAPABILITIES,
    t = parseMarkdownDocument(c);
  if (e.outputFormat === "prosemirror")
    return {
      prosemirror: await convertDocumentToProseMirror(t, e, {
        uploadImage: o.uploadImage,
        onImageProgress: o.onImageProgress,
      }),
    };
  throw new Error(`Output format "${e.outputFormat}" not implemented yet`);
}
export async function markdownToXhsDocument(
  c: string,
  o: ConversionOptions["uploadImage"],
  e?: ConversionOptions["onImageProgress"],
): Promise<ProseMirrorNode> {
  return (
    await convertForPlatform(c, {
      platform: "xiaohongshu",
      uploadImage: o,
      onImageProgress: e,
    })
  ).prosemirror;
}
export const xhsLogger = N("Xiaohongshu");
export const XHS_EDITOR_URL =
  "https://creator.xiaohongshu.com/publish/publish?from=menu&target=article";
export const XHS_CREATOR_ORIGIN = "https://creator.xiaohongshu.com";
export const XHS_MAX_TEXT_LENGTH = 1e4;
export const yidianLogger = N("Yidian");
