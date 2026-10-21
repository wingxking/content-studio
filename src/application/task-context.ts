import { z } from "zod";
import { dbRequest, dbRpc } from "../core/database.ts";
import { getTask, getTaskRun, taskWorkspaceId } from "../core/tasks.ts";
import { supabaseVideoRepository } from "../core/video.ts";
import { getAsset } from "../core/assets.ts";
import { knowledgeStore } from "../core/knowledge.ts";
import {
  safeRuntimeError,
  safeRuntimePhase,
} from "../core/runtime-overview.ts";
import { contentPage, articleDetail } from "./workspace.ts";
import {
  captureInputSchema,
  captureSchema,
  resourceSchema,
  taskContextSchema,
  taskIndexItemSchema,
  taskRefSchema,
  deliveryListItemSchema,
  type TaskRef,
} from "../contracts/workbench.ts";

const indexInput = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().max(200).default(""),
  archived: z.enum(["true", "false"]).default("false"),
  kind: z.enum(["content", "discovery", "video", "article"]).optional(),
  tag: z.string().max(60).optional(),
});
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });
function decode(value?: string) {
  return value
    ? cursorSchema.parse(
        JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      )
    : null;
}
function paged<T extends { id: string; createdAt: string }>(
  items: T[],
  limit: number,
) {
  const selected = items.slice(0, limit);
  const last = selected.at(-1);
  return {
    items: selected,
    nextCursor:
      items.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              at: new Date(last.createdAt).toISOString(),
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}
export async function taskIndex(value: unknown) {
  const input = indexInput.parse(value);
  const cursor = decode(input.cursor);
  return paged(
    z
      .array(taskIndexItemSchema)
      .parse(
        await dbRpc("studio_task_index", {
          p_workspace: await taskWorkspaceId(),
          p_limit: input.limit + 1,
          p_before: cursor?.at ?? null,
          p_before_id: cursor?.id ?? null,
          p_search: input.search,
          p_archived: input.archived === "true",
          p_kind: input.kind ?? null,
          p_tag: input.tag ?? null,
        }),
      ),
    input.limit,
  );
}
export async function deliveryPage(value: unknown) {
  const input = z
    .object({
      view: z
        .enum(["pending", "drafts", "history", "calendar", "all"])
        .default("pending"),
      cursor: z.string().max(400).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    })
    .parse(value);
  const after = decode(input.cursor);
  const rows = z
    .array(deliveryListItemSchema)
    .parse(
      await dbRpc("studio_delivery_page", {
        p_workspace: await taskWorkspaceId(),
        p_view: input.view,
        p_before: after?.at ?? null,
        p_before_id: after?.id ?? null,
        p_limit: 51,
        p_from: input.from ?? null,
        p_to: input.to ?? null,
      }),
    );
  return paged(
    rows.map((row) => {
      if (row.remoteUrl) {
        try {
          const url = new URL(row.remoteUrl);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            /token|secret|password|signature|authorization/iu.test(url.search)
          )
            row.remoteUrl = null;
        } catch {
          row.remoteUrl = null;
        }
      }
      return row;
    }),
    50,
  );
}
const episodeRow = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  status: z.string(),
  created_at: z.string(),
  draft_id: z.uuid().nullable(),
  task_snapshot: z.object({ title: z.string() }),
});
export async function taskContext(value: unknown, query: unknown = {}) {
  const ref = taskRefSchema.parse(value);
  const input = z
    .object({
      episode: z.uuid().optional(),
      cursor: z.string().max(400).optional(),
    })
    .parse(query);
  const workspace = await taskWorkspaceId();
  const metadata = z
    .array(
      z.object({
        tags: z.array(z.string()),
        archived_at: z.string().nullable(),
      }),
    )
    .parse(
      await dbRequest(
        `studio_task_presentation?workspace_id=eq.${workspace}&kind=eq.${ref.kind}&subject_id=eq.${ref.id}&limit=1`,
      ),
    )[0];
  let title: string;
  let status: string;
  let plan = null;
  let episodes: z.infer<typeof taskContextSchema>["episodes"] = [];
  let nextCursor: string | null = null;
  if (ref.kind === "plan") {
    plan = await getTask(ref.id);
    title = plan.title;
    status = plan.enabled ? "enabled" : "paused";
    const cursor = decode(input.cursor);
    const filter = cursor
      ? `&or=(created_at.lt.${encodeURIComponent(cursor.at)},and(created_at.eq.${encodeURIComponent(cursor.at)},id.lt.${cursor.id}))`
      : "";
    const rows = z.array(episodeRow).parse(
      await dbRequest(
        `studio_task_runs?workspace_id=eq.${workspace}&task_id=eq.${ref.id}&refresh_draft_id=is.null&select=id,task_id,status,created_at,draft_id,task_snapshot:task_snapshot->title&order=created_at.desc,id.desc&limit=21${filter}`,
      ).then((rows) =>
        z
          .array(z.record(z.string(), z.unknown()))
          .parse(rows)
          .map((row) => ({
            ...row,
            task_snapshot:
              typeof row.task_snapshot === "string"
                ? { title: row.task_snapshot }
                : row.task_snapshot,
          })),
      ),
    );
    const page = paged(
      rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        title: row.task_snapshot.title,
        status: row.status,
        createdAt: row.created_at,
        draftId: row.draft_id,
      })),
      20,
    );
    episodes = page.items;
    nextCursor = page.nextCursor;
    if (input.episode && !episodes.some((item) => item.id === input.episode)) {
      const run = await getTaskRun(input.episode);
      if (run.taskId !== ref.id)
        throw new Error("This execution does not belong to the selected task.");
      if (run.refreshTarget) {
        const origin = z
          .array(z.object({ origin_run_id: z.uuid() }))
          .parse(
            await dbRequest(
              `studio_article_origins?workspace_id=eq.${workspace}&draft_id=eq.${run.refreshTarget.draftId}&task_id=eq.${ref.id}&limit=1`,
            ),
          )[0];
        if (!origin) throw new Error("Original episode not found.");
        return taskContext(ref, { ...input, episode: origin.origin_run_id });
      }
      episodes.unshift({
        id: run.id,
        taskId: run.taskId,
        title: run.taskSnapshot.title,
        status: run.status,
        createdAt: run.createdAt,
        draftId: run.draftId,
      });
    }
  } else if (ref.kind === "video") {
    const project = await supabaseVideoRepository.get(ref.id);
    title = project.brief.topic;
    status = project.status;
    episodes = [
      {
        id: project.id,
        taskId: project.id,
        title,
        status,
        createdAt: project.createdAt,
        draftId: null,
      },
    ];
  } else {
    const { draft } = await articleDetail(ref.id);
    title = draft.title;
    status = "standalone";
    episodes = [
      {
        id: draft.id,
        taskId: draft.id,
        title,
        status,
        createdAt: draft.createdAt,
        draftId: draft.id,
      },
    ];
  }
  if (
    input.episode &&
    !episodes.some((episode) => episode.id === input.episode)
  )
    throw new Error("This episode does not belong to the selected task.");
  const related =
    ref.kind === "plan"
      ? z
          .array(
            z.object({
              child_task_id: z.uuid(),
              parent_run_id: z.uuid(),
              question_index: z.number().int().nullable(),
              relation: z.string(),
            }),
          )
          .parse(
            await dbRequest(
              `studio_task_links?workspace_id=eq.${workspace}&parent_task_id=eq.${ref.id}&limit=100`,
            ),
          )
          .map((link) => ({
            childTaskId: link.child_task_id,
            parentRunId: link.parent_run_id,
            questionIndex: link.question_index,
            relation: link.relation,
          }))
      : [];
  return taskContextSchema.parse({
    ref,
    title,
    status,
    plan,
    episodes,
    nextCursor,
    selectedEpisodeId: input.episode ?? episodes[0]?.id ?? null,
    tags: metadata?.tags ?? [],
    archivedAt: metadata?.archived_at ?? null,
    related,
  });
}
export async function contextActivity(ref: TaskRef, episodeId: string) {
  const context = await taskContext(ref, { episode: episodeId });
  const workspace = await taskWorkspaceId();
  const episode = context.episodes.find(
    (item) => item.id === context.selectedEpisodeId,
  );
  const events: {
    id: string;
    kind: string;
    status: string;
    at: string;
    detail: string | null;
  }[] = [];
  if (ref.kind === "plan" && episode) {
    const rows = z
      .array(
        z.object({
          id: z.uuid(),
          status: z.string(),
          phase: z.string(),
          error: z.string().nullable(),
          created_at: z.string(),
          refresh_draft_id: z.uuid().nullable(),
        }),
      )
      .parse(
        await dbRequest(
          `studio_task_runs?workspace_id=eq.${workspace}&task_id=eq.${ref.id}&or=(id.eq.${episode.id}${episode.draftId ? `,refresh_draft_id.eq.${episode.draftId}` : ""})&select=id,status,phase,error,created_at,refresh_draft_id&order=created_at.desc&limit=50`,
        ),
      );
    events.push(
      ...rows.map((row) => ({
        id: row.id,
        kind: row.refresh_draft_id ? "重新调研" : "生产执行",
        status: row.status,
        at: row.created_at,
        detail: row.error
          ? safeRuntimeError(row.error)
          : safeRuntimePhase(row.phase, row.status),
      })),
    );
  }
  const content = await contextContent(ref, episodeId);
  const ids = content.items.map((item) => item.id);
  if (ids.length) {
    const rows = z
      .array(
        z.object({
          id: z.uuid(),
          kind: z.string(),
          status: z.string(),
          phase: z.string(),
          error: z.string().nullable(),
          created_at: z.string(),
        }),
      )
      .parse(
        await dbRequest(
          `studio_operations?workspace_id=eq.${workspace}&draft_id=in.(${ids.join(",")})&select=id,kind,status,phase,error,created_at&order=created_at.desc&limit=100`,
        ),
      );
    events.push(
      ...rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        at: row.created_at,
        detail: row.error
          ? safeRuntimeError(row.error)
          : safeRuntimePhase(row.phase, row.status),
      })),
    );
  }
  return { events: events.sort((a, b) => b.at.localeCompare(a.at)) };
}
export async function contextContent(
  ref: TaskRef,
  episodeId?: string,
  cursor?: string,
) {
  const context = await taskContext(ref, { episode: episodeId });
  if (ref.kind === "plan")
    return context.selectedEpisodeId
      ? contentPage({
          taskId: ref.id,
          runId: context.selectedEpisodeId,
          cursor,
        })
      : { items: [], nextCursor: null };
  if (ref.kind === "video") return { items: [], nextCursor: null };
  const { draft } = await articleDetail(ref.id);
  return {
    items: [
      {
        id: draft.id,
        kind: "article" as const,
        title: draft.title,
        revision: draft.revision,
        platforms: draft.variants.map((variant) => variant.platform),
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
        status: "generated",
        taskId: null,
        runId: null,
      },
    ],
    nextCursor: null,
  };
}
export async function resolveContent(id: string) {
  const workspace = await taskWorkspaceId();
  const origin = z
    .array(z.object({ task_id: z.uuid(), origin_run_id: z.uuid() }))
    .parse(
      await dbRequest(
        `studio_article_origins?workspace_id=eq.${workspace}&draft_id=eq.${z.uuid().parse(id)}&limit=1`,
      ),
    )[0];
  if (origin)
    return {
      ref: { kind: "plan" as const, id: origin.task_id },
      episode: origin.origin_run_id,
    };
  await articleDetail(id);
  return { ref: { kind: "article" as const, id }, episode: id };
}
export async function contextResources(ref: TaskRef, episodeId?: string) {
  await taskContext(ref, { episode: episodeId });
  const workspace = await taskWorkspaceId();
  const scope = episodeId
    ? `&or=(episode_id.is.null,episode_id.eq.${episodeId})`
    : "&episode_id=is.null";
  const links = z
    .array(resourceSchema)
    .parse(
      await dbRequest(
        `studio_task_resources?workspace_id=eq.${workspace}&task_kind=eq.${ref.kind}&task_id=eq.${ref.id}${scope}&order=created_at.desc&limit=100`,
      ),
    );
  const ids = links
    .filter((link) => link.resource_kind === "capture")
    .map((link) => link.resource_id);
  const captures = ids.length
    ? z
        .array(captureSchema)
        .parse(
          await dbRequest(
            `studio_library_entries?workspace_id=eq.${workspace}&id=in.(${ids.join(",")})`,
          ),
        )
    : [];
  const resources = await Promise.all(links.map(async link => {
    if (link.resource_kind === "capture") { const capture = captures.find(item => item.id === link.resource_id); return { id: link.resource_id, kind: link.resource_kind, name: capture?.title ?? "网页资料不可用", ...(capture ? { url: capture.url } : {}) }; }
    try {
      if (link.resource_kind === "asset") { const asset = await getAsset(link.resource_id); return { id: asset.id, kind: link.resource_kind, name: asset.name, mime: asset.mime, url: asset.url }; }
      const source = await knowledgeStore().get(link.resource_id);
      return { id: source.id, kind: link.resource_kind, name: source.name };
    } catch { return { id: link.resource_id, kind: link.resource_kind, name: "资料暂不可用，请检查原文件" }; }
  }));
  return { links, captures, resources };
}
export async function library(value: unknown) {
  const input = z
    .object({ cursor: z.string().max(400).optional() })
    .parse(value);
  const cursor = decode(input.cursor);
  const workspace = await taskWorkspaceId();
  const filter = cursor
    ? `&or=(created_at.lt.${encodeURIComponent(cursor.at)},and(created_at.eq.${encodeURIComponent(cursor.at)},id.lt.${cursor.id}))`
    : "";
  const entries = z
    .array(captureSchema)
    .parse(
      await dbRequest(
        `studio_library_entries?workspace_id=eq.${workspace}&order=created_at.desc,id.desc&limit=51${filter}`,
      ),
    );
  const page = paged(
    entries.map((entry) => ({ ...entry, createdAt: entry.created_at })),
    50,
  );
  const ids = page.items.map((entry) => entry.id);
  const links = ids.length
    ? z
        .array(resourceSchema)
        .parse(
          await dbRequest(
            `studio_task_resources?workspace_id=eq.${workspace}&resource_kind=eq.capture&resource_id=in.(${ids.join(",")})&limit=1000`,
          ),
        )
    : [];
  return { entries: page.items, links, nextCursor: page.nextCursor };
}
export async function linkResource(value: unknown) {
  const input = z
    .object({
      task: taskRefSchema,
      episodeId: z.uuid().optional(),
      kind: z.enum(["capture", "asset", "knowledge"]),
      id: z.uuid(),
    })
    .strict()
    .parse(value);
  await taskContext(input.task, { episode: input.episodeId });
  const workspace = await taskWorkspaceId();
  if (input.kind === "asset") await getAsset(input.id);
  else if (input.kind === "knowledge") await knowledgeStore().get(input.id);
  else if (
    !z
      .array(captureSchema)
      .parse(
        await dbRequest(
          `studio_library_entries?workspace_id=eq.${workspace}&id=eq.${input.id}&limit=1`,
        ),
      )[0]
  )
    throw new Error("Resource not found.");
  await dbRequest(
    "studio_task_resources?on_conflict=workspace_id,task_kind,task_id,episode_id,resource_kind,resource_id",
    {
      method: "POST",
      prefer: "resolution=ignore-duplicates",
      body: {
        workspace_id: workspace,
        task_kind: input.task.kind,
        task_id: input.task.id,
        episode_id: input.episodeId ?? null,
        resource_kind: input.kind,
        resource_id: input.id,
      },
    },
  );
  return { saved: true };
}
export async function unlinkResource(id: string) {
  const workspace = await taskWorkspaceId();
  const row = z
    .array(resourceSchema)
    .parse(
      await dbRequest(
        `studio_task_resources?workspace_id=eq.${workspace}&id=eq.${z.uuid().parse(id)}&limit=1`,
      ),
    )[0];
  if (!row) throw new Error("Resource link not found.");
  await taskContext(
    { kind: row.task_kind, id: row.task_id },
    { episode: row.episode_id ?? undefined },
  );
  await dbRequest(
    `studio_task_resources?workspace_id=eq.${workspace}&id=eq.${row.id}`,
    { method: "DELETE" },
  );
  return { saved: true };
}
export async function captureResource(value: unknown) {
  const input = captureInputSchema.parse(value);
  const workspace = await taskWorkspaceId();
  if (input.task) await taskContext(input.task, { episode: input.episodeId });
  await dbRequest("studio_library_entries?on_conflict=id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates",
    body: {
      id: input.commandId,
      workspace_id: workspace,
      title: input.title,
      url: input.url,
      excerpt: input.excerpt,
    },
  });
  const capture = z
    .array(captureSchema)
    .parse(
      await dbRequest(
        `studio_library_entries?workspace_id=eq.${workspace}&id=eq.${input.commandId}&limit=1`,
      ),
    )[0];
  if (
    !capture ||
    capture.title !== input.title ||
    capture.url !== input.url ||
    capture.excerpt !== input.excerpt
  )
    throw new Error("Capture command changed.");
  if (input.task)
    await linkResource({
      task: input.task,
      episodeId: input.episodeId,
      kind: "capture",
      id: capture.id,
    });
  return capture;
}
export async function updatePresentation(ref: TaskRef, value: unknown) {
  const input = z
    .object({
      tags: z.array(z.string().trim().min(1).max(60)).max(12),
      archived: z.boolean(),
    })
    .strict()
    .parse(value);
  const context = await taskContext(ref);
  if (input.archived) {
    if (context.plan?.enabled)
      throw new Error("Pause this plan before archiving it.");
    if (
      context.episodes.some((episode) =>
        ["queued", "researching", "generating", "rendering"].includes(
          episode.status,
        ),
      )
    )
      throw new Error("Finish or cancel active work before archiving.");
    if (
      !z
        .boolean()
        .parse(
          await dbRpc("studio_task_can_archive", {
            p_workspace: await taskWorkspaceId(),
            p_kind: ref.kind,
            p_id: ref.id,
          }),
        )
    )
      throw new Error(
        "Resolve active work and pending deliveries before archiving.",
      );
  }
  await dbRequest(
    "studio_task_presentation?on_conflict=workspace_id,kind,subject_id",
    {
      method: "POST",
      prefer: "resolution=merge-duplicates",
      body: {
        workspace_id: await taskWorkspaceId(),
        kind: ref.kind,
        subject_id: ref.id,
        tags: [...new Set(input.tags)],
        archived_at: input.archived ? new Date().toISOString() : null,
      },
    },
  );
  return { saved: true };
}
