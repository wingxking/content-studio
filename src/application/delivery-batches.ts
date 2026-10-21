import { z } from "zod";
import {
  batchInputSchema,
  batchReceiptSchema,
  type BatchReceipt,
} from "../contracts/workbench.ts";
import { dbRequest, dbRpc } from "../core/database.ts";
import { taskWorkspaceId } from "../core/tasks.ts";
import { readState } from "../core/store.ts";
import {
  deliveryFingerprint,
  deliveryPreflight,
  intentKey,
  DeliveryInputError,
  safeDeliveryError,
} from "../core/delivery-preflight.ts";
import { publishDraft } from "../core/delivery.ts";
import {
  prepareRemoteDrafts,
  queueRemoteDraft,
} from "../core/remote-drafts.ts";
import { preparePublication, approveDraft } from "../core/pipeline.ts";
import { prepareVideoTargetPublication } from "../core/video-delivery.ts";
import { createOperation, createVideoOperation } from "../core/editor.ts";

const itemRow = z.object({
  id: z.uuid(),
  input: batchInputSchema.shape.items.element,
  status: z.enum(["pending", "accepted", "blocked", "failed"]),
  job_id: z.uuid().nullable(),
  error: z.string().nullable(),
});
export async function deliveryBatch(id: string): Promise<BatchReceipt> {
  const workspace = await taskWorkspaceId();
  const batchId = z.uuid().parse(id);
  const rows = z
    .array(z.object({ id: z.uuid(), created_at: z.string() }))
    .parse(
      await dbRequest(
        `studio_delivery_batches?workspace_id=eq.${workspace}&id=eq.${batchId}&limit=1`,
      ),
    );
  if (!rows[0]) throw new Error("Publication batch not found.");
  const [raw, state] = await Promise.all([
    dbRequest(
      `studio_delivery_batch_items?workspace_id=eq.${workspace}&batch_id=eq.${batchId}&order=created_at.asc,id.asc`,
    ),
    readState(),
  ]);
  const items = z
    .array(itemRow)
    .parse(raw)
    .map((item) => {
      const job = state.jobs.find((job) => job.id === item.job_id);
      const account = job?.snapshot?.account ?? state.accounts.find(account => account.id === item.input.accountId);
      return {
        id: item.id,
        input: item.input,
        status: item.status,
        jobId: item.job_id,
        error: item.error,
        deliveryStatus: job?.status ?? null,
        remoteUrl: job?.remoteUrl ?? null,
        target: account ? { platform: account.platform, accountLabel: account.label, title: job?.snapshot?.variant.title ?? "待创建交付", scheduledAt: job?.scheduledAt ?? item.input.scheduledAt ?? null } : null,
      };
    });
  const counts = { pending: 0, accepted: 0, blocked: 0, failed: 0 };
  for (const item of items) counts[item.status]++;
  return batchReceiptSchema.parse({
    id: batchId,
    createdAt: rows[0].created_at,
    items,
    counts,
  });
}
export async function createDeliveryBatch(value: unknown) {
  const input = batchInputSchema.parse(value);
  const keys = input.items.map(item => `${item.subjectKind}:${item.articleId ?? item.videoId}:${item.accountId}`);
  if (new Set(keys).size !== keys.length)
    throw new Error("每篇内容的每个账号只能选择一种交付方式。");
  const items = [...input.items].sort((a, b) =>
    intentKey(a).localeCompare(intentKey(b)),
  );
  await dbRpc("studio_create_delivery_batch", {
    p_workspace: await taskWorkspaceId(),
    p_id: input.commandId,
    p_hash: deliveryFingerprint(items),
    p_items: items,
  });
  return deliveryBatch(input.commandId);
}
export async function processDeliveryBatchItem(
  id: string,
  signal: AbortSignal,
  token: string,
): Promise<void> {
  signal.throwIfAborted();
  const workspace = await taskWorkspaceId();
  const item = z
    .array(itemRow)
    .parse(
      await dbRequest(
        `studio_delivery_batch_items?workspace_id=eq.${workspace}&id=eq.${z.uuid().parse(id)}&limit=1`,
      ),
    )[0];
  if (!item || item.status !== "pending") return;
  const recovered = (await readState()).jobs.find((job) => job.id === item.id);
  let jobId = item.job_id ?? recovered?.id ?? null;
  let error: string | null = null;
  try {
    if (!jobId) {
      const { fingerprint: _fingerprint, ...intent } = item.input;
      const check = (await deliveryPreflight({ items: [intent] })).items[0];
      if (!check?.eligible || check.fingerprint !== item.input.fingerprint)
        throw new DeliveryInputError(
          check?.reasons.join(" ") ||
            "内容、媒体或账号已变化，请重新检查后提交。",
        );
      signal.throwIfAborted();
      const input = item.input;
      if (input.subjectKind === "video") {
        const job = await prepareVideoTargetPublication(
          input.videoId!,
          input.targetId!,
          {
            expectedRevision: input.expectedRevision,
            expectedTargetRevision: input.expectedTargetRevision,
            automatic: input.action === "publish",
          },
          { jobId: item.id },
        );
        jobId = job.id;
      } else if (input.action === "manual_handoff") {
        await approveDraft(input.articleId!, input.expectedRevision);
        jobId = (
          await preparePublication({
            draftId: input.articleId!,
            accountId: input.accountId,
            expectedRevision: input.expectedRevision,
            automatic: false,
            scheduledAt: input.scheduledAt,
            jobId: item.id,
          })
        ).id;
      } else {
        const jobs =
          input.action === "save_draft"
            ? await prepareRemoteDrafts(
                input.articleId!,
                {
                  expectedRevision: input.expectedRevision,
                  accountIds: [input.accountId],
                },
                { jobId: item.id },
              )
            : await publishDraft(
                input.articleId!,
                {
                  expectedRevision: input.expectedRevision,
                  accountIds: [input.accountId],
                },
                { jobId: item.id, queue: false, scheduledAt: input.scheduledAt },
              );
        jobId = jobs[0]?.id ?? null;
      }
      if (!jobId) throw new Error("交付任务未创建，请检查目标。");
    }
    await dbRpc("studio_bind_batch_job", {
      p_workspace: workspace,
      p_item: id,
      p_job: jobId,
      p_token: token,
    });
    const job = (await readState()).jobs.find((job) => job.id === jobId);
    if (!job) throw new Error("交付任务暂不可用，请稍后检查。");
    if (job.status === "failed") throw new Error(job.error ?? "交付预检失败。");
    signal.throwIfAborted();
    if (item.input.action === "save_draft") await queueRemoteDraft(job.id);
    else if (
      item.input.action === "publish" &&
      Date.parse(job.scheduledAt) <= Date.now() &&
      ["scheduled", "awaiting_operator"].includes(job.status)
    ) {
      if (item.input.subjectKind === "video")
        await createVideoOperation(item.input.videoId!, "publish", {
          jobId: job.id,
          expectedRevision: item.input.expectedRevision,
        });
      else
        await createOperation(item.input.articleId!, "publish", {
          jobId: job.id,
          expectedRevision: item.input.expectedRevision,
        });
    }
  } catch (failure) {
    signal.throwIfAborted();
    error = safeDeliveryError(failure);
  }
  await dbRpc("studio_finish_batch_item", {
    p_workspace: workspace,
    p_item: id,
    p_token: token,
    p_job: jobId,
    p_error: error,
  });
}
