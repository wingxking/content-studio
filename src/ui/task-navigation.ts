import { taskHref, type TaskRef } from "../contracts/workbench.ts";

export type TaskContentLocation = {
  episodeId?: string | null;
  articleId?: string | null;
  jobId?: string | null;
};

/** Preserve the exact content and delivery selected in cross-task views. */
export function taskContentHref(
  ref: TaskRef,
  tab = "content",
  context: TaskContentLocation = {},
): string {
  const [path, search] = taskHref(ref, tab, context.episodeId).split("?");
  const query = new URLSearchParams(search);
  if (context.articleId) query.set("article", context.articleId);
  if (context.jobId) query.set("job", context.jobId);
  return `${path}${query.size ? `?${query}` : ""}`;
}

export const creationKinds = ["content", "discovery", "video"] as const;
export type CreationKind = (typeof creationKinds)[number];
export function creationKind(value: string | null): CreationKind {
  return creationKinds.find((kind) => kind === value) ?? "content";
}
export function createTaskHref(kind: CreationKind): string {
  return `/tasks/new?type=${kind}`;
}
