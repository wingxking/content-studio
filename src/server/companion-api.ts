import { companionVersion } from "../contracts/studio-ui.ts";
import { timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { readDraftBridgeConfig } from "../core/draft-bridge-config.ts";
import {
  draftAccountIdentity,
  nativeDraftPlatformSchema,
} from "../core/draft-connectors.ts";
import { readState } from "../core/store.ts";
import { queueRemoteDraft } from "../core/remote-drafts.ts";
import {
  taskIndex,
  taskContext,
  captureResource,
  deliveryPage,
} from "../application/task-context.ts";
import { companionMethods, companionProtocol } from "../contracts/studio-ui.ts";
import { taskRefSchema } from "../contracts/workbench.ts";

export function companionPublicOrigin(): string {
  const url = new URL(
    process.env.STUDIO_PUBLIC_ORIGIN ?? "http://127.0.0.1:4310",
  );
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Configure the public workbench origin.");
  return url.origin;
}
export const companionApi = Router();
companionApi.use(async (req, res, next) => {
  const config = await readDraftBridgeConfig();
  const token = req.headers.authorization ?? "";
  const expected = config ? `Bearer ${config.serviceKey}` : "";
  const internal = new URL(
    process.env.STUDIO_COMPANION_API_URL ?? "http://api:4310",
  );
  if (
    !config ||
    req.headers.origin !== undefined ||
    req.headers.host !== internal.host ||
    Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  ) {
    res.status(403).json({ error: "Companion authorization required." });
    return;
  }
  next();
});
companionApi.use(express.json({ limit: "256kb", strict: true }));
companionApi.post("/:method", async (req, res) => {
  const method = z.enum(companionMethods).parse(req.params.method);
  if (method === "status") {
    res.json({
      protocol: companionProtocol,
      version: 1,
      workbenchOrigin: companionPublicOrigin(),
      methods: companionMethods,
      extensionRelease: { version: companionVersion, downloadPath: "/downloads/content-studio-extension.zip", notes: "连接恢复、采集恢复、待处理与更新提示", minCompanionProtocolVersion: 1 },
    });
    return;
  }
  if (method === "tasks.list") {
    res.json(await taskIndex(req.body));
    return;
  }
  if (method === "tasks.get") {
    const context = await taskContext(taskRefSchema.parse(req.body));
    const { plan: _plan, ...publicContext } = context;
    res.json(publicContext);
    return;
  }
  if (method === "capture.create") {
    res.json(await captureResource(req.body));
    return;
  }
  if (method === "deliveries.list") {
    res.json(await deliveryPage({ ...z.object({ cursor: z.string().max(400).optional() }).parse(req.body), view: "drafts" }));
    return;
  }
  const state = await readState();
  if (method === "accounts.list") {
    res.json({
      accounts: state.accounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        label: account.label,
        status: account.status,
        boundUserId: account.draftConnection?.userId ?? null,
        boundExtensionId: account.draftConnection?.extensionId ?? null,
      })),
    });
    return;
  }
  if (method === "accounts.check") {
    const { accountId } = z
      .object({ accountId: z.uuid() })
      .strict()
      .parse(req.body);
    const account = state.accounts.find((item) => item.id === accountId);
    if (
      !account ||
      !nativeDraftPlatformSchema.safeParse(account.platform).success
    )
      throw new Error("请在工作台检查此平台的官方授权。");
    const identity = await draftAccountIdentity(account.platform);
    res.json({
      accountId,
      isAuthenticated: identity.isAuthenticated,
      userId: identity.userId ?? null,
      username: identity.username ?? null,
      matched: Boolean(
        identity.isAuthenticated &&
        identity.userId === account.draftConnection?.userId,
      ),
      error: identity.error ?? null,
    });
    return;
  }
  const { jobId } = z.object({ jobId: z.uuid() }).strict().parse(req.body);
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job || job.deliveryAction !== "save_draft")
    throw new Error("请选择工作台已确认的草稿任务。");
  const result = await queueRemoteDraft(job.id);
  res.json({ id: result.id, status: result.status });
});
