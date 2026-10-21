export interface ImageXCredentials {
  AccessKeyID: string;
  SecretAccessKey: string;
  SessionToken: string;
  ExpiredTime: string;
}

export interface ImageXUploadAddress {
  StoreInfos: Array<{ StoreUri: string; Auth: string }>;
  UploadHosts: string[];
  SessionKey: string;
}

export interface NeteaseAccount {
  tid: string;
  tname: string;
  icon: string;
  realUserId?: string;
}

export interface XUser {
  userId: string;
  username: string;
  name: string;
  avatar: string;
}

export interface QueryIdCache {
  ids: Record<string, string>;
  fetchedAt: number;
  ttlMs: number;
}

export interface DraftEntity {
  type: string;
  mutability: string;
  data: Record<string, unknown>;
}

export interface DraftBlock {
  key: string;
  type: string;
  text: string;
  depth: number;
  data: Record<string, unknown>;
  blockEntities?: Record<string, DraftEntity>;
  entityRanges: Array<{ key: number; offset: number; length: number }>;
  inlineStyleRanges: Array<{ style: string; offset: number; length: number }>;
}

export interface DraftState {
  blocks: DraftBlock[];
  entityMap: Record<string, DraftEntity>;
}

export interface ContainerMarkdownNode {
  type:
    | "root"
    | "paragraph"
    | "blockquote"
    | "listItem"
    | "table"
    | "tableRow"
    | "tableCell"
    | "strong"
    | "emphasis"
    | "delete";
  children: MarkdownNode[];
}
export interface HeadingMarkdownNode {
  type: "heading";
  depth: number;
  children: MarkdownNode[];
}
export interface ListMarkdownNode {
  type: "list";
  ordered: boolean;
  start?: number;
  children: MarkdownNode[];
}
export interface ImageMarkdownNode {
  type: "image";
  url: string;
  alt?: string;
}
export type MarkdownNode =
  | ContainerMarkdownNode
  | HeadingMarkdownNode
  | ListMarkdownNode
  | ImageMarkdownNode
  | { type: "text" | "inlineCode" | "code"; value: string; lang?: string }
  | { type: "link"; url: string; children: MarkdownNode[] }
  | { type: "break" | "thematicBreak" };
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProseMirrorNode {
  type: string;
  attrs?: Record<string, JsonValue>;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, string | number> }>;
  content?: ProseMirrorNode[];
}

export interface UploadedImage {
  url: string;
  width: number;
  height: number;
  fileId?: string;
}

export interface ContentCapabilities {
  id: string;
  outputFormat: string;
  maxHeadingLevel: number;
  supportNestedList: boolean;
  supportTable: boolean;
  supportCodeBlock: boolean;
  supportInlineCode: boolean;
  supportLink: boolean;
  supportImage: boolean;
  supportBlockquote: boolean;
  supportHorizontalRule: boolean;
  supportBold: boolean;
  supportItalic: boolean;
  supportStrikethrough: boolean;
  supportHighlight: boolean;
  supportLatex: boolean;
}

export interface ConversionOptions {
  platform: string;
  uploadImage?: (src: string) => Promise<UploadedImage>;
  onImageProgress?: (current: number, total: number) => void;
}

export interface ConversionContext {
  capabilities: ContentCapabilities;
  uploadImage?: (src: string) => Promise<UploadedImage>;
  onImageProgress?: (current: number, total: number) => void;
  uploadedImages: Map<string, UploadedImage>;
  imageQueue: Array<{ src: string; alt: string }>;
}
