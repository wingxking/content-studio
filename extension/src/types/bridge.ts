import type { Article, AuthResult, PlatformMeta } from "../../core/src/types";

export type BridgeArticle = Article & { content: string };
export type BridgePlatform = Pick<
  PlatformMeta,
  "id" | "name" | "icon" | "homepage"
> &
  AuthResult;

export interface LegacyAccount {
  type: string;
  title: string;
  displayName?: string;
  icon?: string;
  avatar?: string;
  uid?: string;
  home?: string;
  supportTypes?: string[];
}

export type MagicCallData = Record<string, unknown> & {
  account?: { type?: string };
  platform?: string;
};
