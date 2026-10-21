import { createHash } from "node:crypto";
import { z } from "zod";
import {
  deliveryIntentSchema,
  type DeliveryIntent,
} from "../contracts/workbench.ts";
import { readState } from "./store.ts";
import { assertExistingPublicationAction, draftHash } from "./pipeline.ts";
import {
  publishingCapability,
  validateLaunchVariant,
} from "./publishing-capabilities.ts";
import { assertAutomatedPublishingAllowed } from "./publishing-policy.ts";
import { validateDraftRoute } from "./remote-drafts.ts";
import { draftBridgeStatus, sameDraftAccount, assertDraftJournalReady } from "./draft-connectors.ts";
import { accountIdentityHash } from "./task-automation.ts";
import { draftQuality } from "./quality.ts";
import { qualityExpiresAt } from "../contracts/research.ts";
import { taskWorkspaceId } from "./tasks.ts";
import { expectedYouTubeChannelId } from "./youtube.ts";
import {
  getIndependentVideoProject,
  isCurrentVideoRender,
  videoTargets,
} from "./video.ts";
import { videoFileHash } from "./video-tools.ts";
import { validatePostizVariant } from "./postiz.ts";
import { DeliveryInputError, deliveryIssue, type DeliveryIssue } from "./delivery-errors.ts";
import { assertPublicationAction } from "./publication-intent.ts";
import { hasYouTubeUploadJournal } from "./publication-journal.ts";

export { DeliveryInputError } from "./delivery-errors.ts";
export function safeDeliveryError(error: unknown): string {
  return deliveryIssue(error).message;
}

export function deliveryFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Read-only: no approval, source refresh, platform draft, or delivery is created here. */
export async function deliveryPreflight(value: unknown) {
  const intents = z
    .object({ items: z.array(deliveryIntentSchema).min(1).max(100) })
    .parse(value).items;
  const state = await readState();
  const bridge = intents.some((item) => item.action === "save_draft")
    ? await draftBridgeStatus()
    : { connected: false, extensionId: null };
  const hashes = new Map<string, Promise<string>>();
  const items = [];
  let journalCheck: Promise<void> | undefined;
  for (const intent of intents) {
    const reasons: string[] = [];
    const issues: DeliveryIssue[] = [];
    let fingerprint = deliveryFingerprint(intent);
    try {
      const account = state.accounts.find(
        (item) => item.id === intent.accountId,
      );
      if (!account)
        throw new DeliveryInputError("目标账号不存在，请重新选择。");
      if (intent.action === "publish" && state.paused)
        throw new DeliveryInputError(
          "公开发布总开关已暂停，请在设置中核对并恢复后重新检查。",
        );
      if (
        state.jobs.some(
          (job) =>
            sameDraftAccount(job, account) &&
            ["submitting", "needs_reconciliation"].includes(job.status),
        )
      )
        throw new DeliveryInputError(
          "此账号有提交中或结果未知的交付，请先核对已有结果。",
        );
      if (intent.subjectKind === "video") {
        const project = await getIndependentVideoProject(intent.videoId!);
        const target = videoTargets(project).find(
          (item) => item.id === intent.targetId,
        );
        const render = project.renders.find(
          (item) => item.id === target?.renderId,
        );
        if (
          !target ||
          project.revision !== intent.expectedRevision ||
          target.revision !== intent.expectedTargetRevision ||
          target.accountId !== account.id ||
          target.sourceRevision !== project.revision
        )
          throw new DeliveryInputError(
            "视频或平台版本已变化，请保存并重新审阅。",
          );
        if (
          !render ||
          !render.output ||
          render.status !== "succeeded" ||
          !isCurrentVideoRender(project, render)
        )
          throw new DeliveryInputError("请先生成并选择当前修订的已审核成片。");
        const previous = state.jobs.find(job => job.subject?.kind === "video" && job.subject.id === project.id && job.accountId === account.id && job.approvedHash === target.approval?.approvalHash && job.status !== "cancelled");
        if (previous && intent.action !== "save_draft") assertPublicationAction(previous, intent.action === "publish", { journalExists: await hasYouTubeUploadJournal(previous) });
        const actualHash = await videoFileHash(render.output.videoPath);
        if (actualHash !== render.output.hash)
          throw new DeliveryInputError("成片文件发生变化，请重新渲染。");
        fingerprint = deliveryFingerprint({
          intent,
          identity: accountIdentityHash(account),
          target: { ...target, approval: null },
          render: render.inputHash,
          output: actualHash,
        });
        const capability = publishingCapability(
          account.platform,
          "video",
          account,
          { expectedYoutubeChannel: expectedYouTubeChannelId },
        );
        if (intent.action === "save_draft")
          throw new DeliveryInputError(
            "视频当前支持官方上传或手动交付，不支持文章草稿同步。",
          );
        if (
          intent.action === "publish" &&
          (!capability.automatic || !target.deliverySettings.youtube)
        )
          throw new DeliveryInputError(
            "请连接已授权 YouTube 频道并保存可见性与披露设置，或选择手动交付。",
          );
      } else {
        const draft = state.drafts.find((item) => item.id === intent.articleId);
        const variant = draft?.variants.find(
          (item) => item.platform === account.platform,
        );
        if (!draft || draft.revision !== intent.expectedRevision)
          throw new DeliveryInputError("内容修订已变化，请重新保存并审阅。");
        if (draft.adaptationStatus === "pending")
          throw new DeliveryInputError("平台适配尚未完成，请等待或重试适配。");
        if (!variant)
          throw new DeliveryInputError("尚未生成此账号对应的平台版本。");
        // Use the exact pure writer rules before reading/hash-checking media.
        if (intent.action === "publish" && account.provider === "postiz") validatePostizVariant(account, variant);
        if (intent.action === "save_draft") validateDraftRoute(account, variant);
        let hash = hashes.get(draft.id);
        if (!hash) {
          hash = draftHash(draft);
          hashes.set(draft.id, hash);
        }
        fingerprint = deliveryFingerprint({
          intent,
          content: await hash,
          identity: accountIdentityHash(account),
          permission: account.draftConnection,
          status: account.status,
        });
        if (intent.action !== "save_draft") await assertExistingPublicationAction(state.jobs, variant, account, intent.action === "publish");
        if (draft.generationEvidenceRunId) {
          const quality = await draftQuality(await taskWorkspaceId(), draft);
          if (
            quality.required &&
            (!quality.current || quality.report?.status !== "passed")
          )
            throw new DeliveryInputError(
              "当前修订尚未通过证据审校，请重新调研或处理质量问题。",
            );
          if (
            quality.report &&
            Date.now() > Date.parse(qualityExpiresAt(quality.report))
          )
            throw new DeliveryInputError(
              "证据审校已过期，请在任务中重新调研后审阅。",
            );
        }
        try { validateLaunchVariant(variant); } catch { throw new DeliveryInputError("此平台需要完整的产品上线资料，请补充产品网址、名称、简介和首条评论。", "UNSUPPORTED_FORMAT"); }
        const capability = publishingCapability(
          account.platform,
          "article",
          account,
          {
            postizConfigured: Boolean(process.env.POSTIZ_API_KEY),
            expectedYoutubeChannel: expectedYouTubeChannelId,
            draftBridgeConnected: bridge.connected,
            draftBridgeExtensionId: bridge.extensionId,
          },
        );
        if (intent.action === "publish") {
          if (account.status !== "connected") throw new DeliveryInputError("目标账号尚未连接，请先完成登录和权限核验。", "AUTHORIZATION_REQUIRED");
          if (account.provider === "postiz" && (!process.env.POSTIZ_API_KEY || !account.verifiedAt)) throw new DeliveryInputError("请配置 Postiz 授权并核验当前目标账号。", "AUTHORIZATION_REQUIRED");
          try { assertAutomatedPublishingAllowed(draft, account); } catch { throw new DeliveryInputError("当前内容不允许自动公开发布，请核对平台政策并选择人工发布。", "UNSUPPORTED_ACTION"); }
          if (!capability.automatic)
            throw new DeliveryInputError(
              "此目标当前需要平台人工发布，可选择同步草稿或手动交付。",
              "UNSUPPORTED_ACTION",
            );
        }
        if (intent.action === "save_draft") {
          if (account.provider === "native") {
            if (!bridge.connected) throw new DeliveryInputError("草稿桥尚未连接 Chrome 插件，请打开插件并检查连接。", "SERVICE_OFFLINE");
            if (account.draftConnection?.extensionId !== bridge.extensionId) throw new DeliveryInputError("当前插件与账号绑定的身份不一致，请核对连接后重新绑定。", "ACCOUNT_MISMATCH");
            await (journalCheck ??= assertDraftJournalReady());
          } else if (!process.env.POSTIZ_API_KEY) {
            throw new DeliveryInputError("Postiz 连接尚未配置授权，请在服务配置中完成连接。", "AUTHORIZATION_REQUIRED");
          }
          if (!capability.remoteDraft && !capability.providerDraft)
            throw new DeliveryInputError(
              "草稿连接尚未就绪，请检查配对、账号身份和权限。",
              "AUTHORIZATION_REQUIRED",
            );
        }
      }
    } catch (error) {
      const issue = deliveryIssue(error);
      reasons.push(issue.message);
      issues.push(issue);
    }
    items.push({
      intent,
      eligible: reasons.length === 0,
      fingerprint,
      reasons,
      issues,
      nextAction: reasons.length
        ? issues[0]!.nextAction
        : intent.action === "save_draft"
          ? "同步草稿（未公开）"
          : intent.action === "manual_handoff"
            ? "创建手动交付待办"
            : "审核并提交",
    });
  }
  return { checkedAt: new Date().toISOString(), items };
}
export function intentKey(intent: DeliveryIntent): string {
  return `${intent.subjectKind}:${intent.articleId ?? intent.videoId}:${intent.targetId ?? ""}:${intent.accountId}:${intent.action}`;
}
