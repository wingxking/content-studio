// Explicit isolated database/HTTP/worker acceptance. No real model or platform credentials.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { dbRequest, dbRpc } from "../src/core/database.ts";
import { readState, mutateState } from "../src/core/store.ts";
import { configureTaskRuntime, getTaskRun } from "../src/core/tasks.ts";
import { runWorkerOnce } from "../src/server/worker.ts";
import { approveDraft, preparePublication } from "../src/core/pipeline.ts";
import { saveDraftBridgeConfig } from "../src/core/draft-bridge-config.ts";
import {
  taskContextSchema,
  taskIndexSchema,
  batchReceiptSchema,
  preflightSchema,
  resourcesSchema,
  librarySchema,
} from "../src/contracts/workbench.ts";
import { taskSchema, taskRunSchema } from "../src/core/task-model.ts";

if (!process.argv.includes("--confirm-isolated-database"))
  throw new Error("Use --confirm-isolated-database.");
if (new URL(process.env.SUPABASE_URL ?? "").hostname !== "kong")
  throw new Error("Use the existing isolated local Supabase network.");
const workspace = randomUUID();
const root = await mkdtemp(join(tmpdir(), "studio-workbench-"));
const environment = { ...process.env };
process.env.STUDIO_WORKSPACE_ID = workspace;
process.env.STUDIO_DATA_DIR = root;
process.env.STUDIO_LOCALFS_DIR = join(root, "localfs");
process.env.CODEX_HOME = join(root, "models");
process.env.STUDIO_DRAFT_BRIDGE_CONFIG = join(root, "bridge.json");
process.env.STUDIO_PUBLIC_ORIGIN = "http://127.0.0.1:14410";
process.env.STUDIO_LISTEN_HOST = "0.0.0.0";
process.env.PORT = "14311";
process.env.STUDIO_COMPANION_API_URL = "http://127.0.0.1:14311";
process.env.NODE_ENV = "production";
process.env.STUDIO_WORKER_ROLE = "all";
delete process.env.STUDIO_MODEL_EXECUTOR_URL;
delete process.env.POSTIZ_API_KEY;
await mkdir(process.env.CODEX_HOME);
await writeFile(
  join(process.env.CODEX_HOME, "studio-models.json"),
  JSON.stringify({
    models: [
      {
        slug: "workbench-fixture",
        display_name: "Fixture model",
        description: "No model execution",
      },
    ],
  }),
);
let api: ChildProcess | undefined;
let worker: ChildProcess | undefined;
let restarts = 0;
let workerLogs = "";
const source = {
  title: "Synthetic software reference",
  url: "https://example.com/reference",
  excerpt:
    "Fixture: immutable software revisions retain their original evidence.",
};
configureTaskRuntime({
  resolveImagePaths: async () => [],
  research: async () => ({ sources: [source], warnings: [] }),
  generateMaster: async () => ({
    title: "Workbench software fixture",
    body: "Keep the original software revision and review each account.",
  }),
  adaptMaster: async () => ({
    platform: "zhihu",
    format: "article",
    title: "Workbench software fixture",
    text: `Keep the original revision. ${source.url}`,
    tags: ["software"],
    mediaPaths: [],
  }),
});
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  await ended;
  clearTimeout(timeout);
}
async function startApi() {
  api = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  api.stderr?.on("data", () => {});
  for (let i = 0; i < 100; i++) {
    if (api.exitCode !== null) throw new Error("Fixture API exited early.");
    if (
      await fetch("http://127.0.0.1:14311/healthz").then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await delay(100);
  }
  throw new Error("Fixture API did not start.");
}
async function call(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  expected = 200,
) {
  const response = await fetch(`http://127.0.0.1:14311/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${JSON.stringify(data)}`,
  );
  return data;
}
async function startWorker() {
  worker = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/worker.ts"],
    {
      env: {
        ...process.env,
        STUDIO_WORKER_ROLE: "delivery",
        STUDIO_WORKER_HEALTH_PORT: "14312",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout?.on("data", (chunk) => {
    workerLogs += String(chunk);
  });
  worker.stderr?.on("data", () => {});
}
async function settle(batchId: string) {
  for (let i = 0; i < 150; i++) {
    const receipt = batchReceiptSchema.parse(
      await call(`workspace/delivery-batches/${batchId}`),
    );
    if (!receipt.counts.pending) return receipt;
    await delay(100);
  }
  throw new Error(
    `Fixture batch did not finish; worker exit=${worker?.exitCode}, events=${workerLogs.slice(-600)}`,
  );
}
try {
  const companionKey = randomUUID();
  await saveDraftBridgeConfig({extensionId: "a".repeat(32), extensionToken: randomUUID(), pairingKey: randomUUID(), serviceKey: companionKey});
  await mutateState((state) => {
    state.paused = true;
    state.accounts.push({
      id: randomUUID(),
      platform: "zhihu",
      label: "Isolated creator",
      provider: "native",
      integrationId: "fixture-only",
      status: "connected",
      note: "No real login or publication permission.",
      verifiedAt: null,
    });
  });
  await startApi();
  const internalUrl = "http://127.0.0.1:14311/internal/companion/status";
  const companionHeaders = {Authorization: `Bearer ${companionKey}`, "Content-Type": "application/json"};
  const internal = await fetch(internalUrl, {method:"POST", headers:companionHeaders, body:"{}"});
  assert.equal(internal.status,200);
  assert.equal(z.object({workbenchOrigin:z.string()}).parse(await internal.json()).workbenchOrigin,"http://127.0.0.1:14410");
  for (const headers of [{...companionHeaders,Origin:"http://127.0.0.1:14410"},{"Content-Type":"application/json"}]) {
    assert.equal((await fetch(internalUrl,{method:"POST",headers,body:"{}"})).status,403);
  }
  const wrongHost = await new Promise<number | undefined>((resolve,reject) => {
    const req = httpRequest(internalUrl,{method:"POST",headers:{...companionHeaders,Host:"unrelated.invalid"}},response => { response.resume(); resolve(response.statusCode); });
    req.once("error",reject); req.end("{}");
  });
  assert.equal(wrongHost,403);
  const config = {
    title: "Workbench acceptance",
    prompt: "Explain immutable software revisions from supplied evidence.",
    model: "workbench-fixture",
    platforms: ["zhihu"],
    kind: "content",
    pipelineVersion: 1,
    topicOrigin: "editorial",
    sources: [source],
    enabled: false,
    frequency: { type: "once", time: "09:00", timezone: "Asia/Singapore" },
  };
  const task = taskSchema.parse(
    await call("tasks", { ...config, commandId: randomUUID() }),
  );
  const run = taskRunSchema.parse(
    await call(`tasks/${task.id}/run`, { commandId: randomUUID() }),
  );
  for (let i = 0; i < 8; i++) {
    await runWorkerOnce();
    if ((await getTaskRun(run.id)).status === "succeeded") break;
  }
  const completed = await getTaskRun(run.id);
  assert.equal(completed.status, "succeeded");
  assert(completed.draftId);
  const header = taskContextSchema.parse(
    await call(`workspace/task-context/plan/${task.id}`),
  );
  assert.equal(header.selectedEpisodeId, run.id);
  assert.equal(header.episodes.length, 1);
  const item = header.episodes[0]!;
  assert.equal(item.draftId, completed.draftId);
  const originalSnapshot = JSON.stringify(completed.taskSnapshot);
  await dbRequest("studio_task_runs", {
    method: "POST",
    body: {
      id: randomUUID(),
      workspace_id: workspace,
      task_id: task.id,
      slot: "fixture:refresh",
      task_snapshot: completed.taskSnapshot,
      status: "succeeded",
      draft_id: completed.draftId,
      refresh_draft_id: completed.draftId,
      refresh_revision: 1,
      refresh_reason: "review_requested",
    },
  });
  const unchanged = taskContextSchema.parse(
    await call(`workspace/task-context/plan/${task.id}`),
  );
  assert.equal(unchanged.episodes.length, 1);
  assert.equal(unchanged.episodes[0]?.id, run.id);
  const clone = z
    .object({ task: taskSchema })
    .parse(
      await call(
        `workspace/runs/${run.id}/clone-task`,
        { commandId: randomUUID(), runNow: false },
        "POST",
        201,
      ),
    );
  const index = taskIndexSchema.parse(await call("workspace/task-index"));
  assert.equal(index.items.length, 2);
  assert(index.items.some((item) => item.id === clone.task.id));
  await call(
    `workspace/task-context/plan/${clone.task.id}?episode=${run.id}`,
    undefined,
    "GET",
    400,
  );
  await call("workspace/captures", { commandId: randomUUID(), title: "Task resource before first episode", url: "https://example.com/before", excerpt: "Reusable fixture", task: { kind: "plan", id: clone.task.id } }, "POST", 201);
  const beforeEpisode = resourcesSchema.parse(await call(`workspace/task-context/plan/${clone.task.id}/resources`));
  assert.equal(beforeEpisode.links.length, 1);
  assert.equal(beforeEpisode.resources[0]?.name, "Task resource before first episode");
  const captureId = randomUUID();
  const capture = {
    commandId: captureId,
    title: "Collected fixture reference",
    url: "https://example.com/collected",
    excerpt: "A synthetic collected reference.",
    task: { kind: "plan", id: task.id },
    episodeId: run.id,
  };
  await call("workspace/captures", capture, "POST", 201);
  await call("workspace/captures", capture, "POST", 201);
  const resources = resourcesSchema.parse(
    await call(
      `workspace/task-context/plan/${task.id}/episodes/${run.id}/resources`,
    ),
  );
  assert.equal(resources.captures.length, 1);
  assert.equal(resources.links.length, 1);
  assert.equal(
    librarySchema.parse(await call("workspace/library")).entries.length,
    2,
  );
  await call(
    "workspace/captures",
    {
      ...capture,
      commandId: randomUUID(),
      url: "https://example.com/?access_token=fixture",
    },
    "POST",
    400,
  );
  assert.equal(
    JSON.stringify((await getTaskRun(run.id)).taskSnapshot),
    originalSnapshot,
  );
  const account = (await readState()).accounts[0]!;
  const blockedAccount = { ...account, id: randomUUID(), label: "Second isolated creator", integrationId: "fixture-two" };
  await mutateState(state => { state.accounts.push(blockedAccount); });
  const intents = (["publish", "manual_handoff"] as const).map((action) => ({
    subjectKind: "article",
    articleId: completed.draftId,
    expectedRevision: 1,
    accountId: action === "publish" ? blockedAccount.id : account.id,
    action,
  }));
  const checks = preflightSchema.parse(
    await call("workspace/deliveries/preflight", { items: intents }),
  );
  assert.equal(
    checks.items.find((item) => item.intent.action === "publish")?.eligible,
    false,
  );
  assert.equal(
    checks.items.find((item) => item.intent.action === "manual_handoff")
      ?.eligible,
    true,
  );
  const items = checks.items.map((item) => ({
    ...item.intent,
    fingerprint: item.fingerprint,
  }));
  await call("workspace/delivery-batches", { commandId: randomUUID(), items: items.map(item => ({...item, accountId: account.id})) }, "POST", 400);
  const commandId = randomUUID();
  const queued = batchReceiptSchema.parse(
    await call("workspace/delivery-batches", { commandId, items }, "POST", 202),
  );
  assert.equal(queued.counts.pending, 2);
  assert.equal(
    batchReceiptSchema.parse(
      await call(
        "workspace/delivery-batches",
        { commandId, items },
        "POST",
        202,
      ),
    ).id,
    queued.id,
  );
  await call(
    "workspace/delivery-batches",
    { commandId, items: items.slice(0, 1) },
    "POST",
    409,
  );
  await startWorker();
  const first = await settle(queued.id);
  assert.equal(first.counts.accepted, 1);
  assert.equal(first.counts.blocked, 1);
  assert(
    first.items.some((item) => item.deliveryStatus === "awaiting_operator"),
  );
  await stop(worker);
  worker = undefined;
  const secondChecks = preflightSchema.parse(
    await call("workspace/deliveries/preflight", { items: [intents[1]] }),
  );
  const replayItems = secondChecks.items.map((item) => ({
    ...item.intent,
    fingerprint: item.fingerprint,
  }));
  const recovering = batchReceiptSchema.parse(
    await call(
      "workspace/delivery-batches",
      { commandId: randomUUID(), items: replayItems },
      "POST",
      202,
    ),
  );
  const claim = z
    .object({
      msgId: z.number(),
      token: z.string().uuid(),
      message: z.object({
        id: z.string().uuid(),
        type: z.literal("delivery_batch_item"),
      }),
    })
    .parse(
      await dbRpc("studio_claim_role_work", {
        p_workspace: workspace,
        p_role: "delivery",
      }),
    );
  await approveDraft(completed.draftId, 1);
  const existing = await preparePublication({
    draftId: completed.draftId,
    accountId: account.id,
    expectedRevision: 1,
    automatic: false,
    jobId: claim.message.id,
  });
  await dbRpc("studio_bind_batch_job", {
    p_workspace: workspace,
    p_item: claim.message.id,
    p_job: existing.id,
    p_token: claim.token,
  });
  await dbRpc("studio_fail_role_work", {
    p_workspace: workspace,
    p_msg: claim.msgId,
    p_token: claim.token,
    p_error: "Synthetic interruption after durable binding",
  });
  await stop(api);
  await startApi();
  restarts++;
  await startWorker();
  const recovered = await settle(recovering.id);
  assert.equal(recovered.counts.accepted, 1);
  assert.equal(recovered.items[0]?.jobId, existing.id);
  await stop(worker);
  worker = undefined;
  await stop(api);
  await startApi();
  restarts++;
  assert.deepEqual(
    batchReceiptSchema.parse(
      await call(`workspace/delivery-batches/${queued.id}`),
    ),
    first,
  );
  const state = await readState();
  assert.equal(state.jobs.length, 1);
  assert(
    state.jobs.every(
      (job) => job.attempts === 0 && !job.remoteId && !job.remoteUrl,
    ),
  );
  await call(
    `workspace/task-context/plan/${task.id}/presentation`,
    { tags: ["fixture"], archived: true },
    "POST",
    400,
  );
  await call(`jobs/${existing.id}/cancel`, {});
  await assert.rejects(preparePublication({draftId:completed.draftId,accountId:account.id,expectedRevision:1,automatic:false,jobId:existing.id}),/Delivery command changed/u);
  assert.equal((await readState()).jobs.length,1);
  await call(`workspace/task-context/plan/${task.id}/presentation`, {
    tags: ["fixture"],
    archived: true,
  });
  assert.equal(
    taskIndexSchema.parse(await call("workspace/task-index")).items.length,
    1,
  );
  await call(`workspace/task-context/plan/${task.id}/presentation`, {
    tags: ["fixture"],
    archived: false,
  });
  await dbRequest("studio_task_runs", {
    method: "POST",
    body: Array.from({ length: 1000 }, (_, index) => ({
      id: randomUUID(),
      workspace_id: workspace,
      task_id: clone.task.id,
      slot: `fixture:performance:${index}`,
      task_snapshot: clone.task,
      status: "succeeded",
      created_at: new Date(Date.now() - index * 1000).toISOString(),
    })),
  });
  const paginated = taskContextSchema.parse(
    await call(`workspace/task-context/plan/${clone.task.id}`),
  );
  assert.equal(paginated.episodes.length, 20);
  assert(paginated.nextCursor);
  assert(JSON.stringify(paginated).length < 250000);
  const scheduledIntent={...intents[1],scheduledAt:"2026-12-15T10:00:00.000Z",timezone:"Asia/Singapore"};
  const scheduledCheck=preflightSchema.parse(await call("workspace/deliveries/preflight",{items:[scheduledIntent]})).items[0]!;
  assert(scheduledCheck.eligible);
  const scheduledBatch=batchReceiptSchema.parse(await call("workspace/delivery-batches",{commandId:randomUUID(),items:[{...scheduledCheck.intent,fingerprint:scheduledCheck.fingerprint}]},"POST",202));
  await startWorker();const scheduledReceipt=await settle(scheduledBatch.id);await stop(worker);worker=undefined;
  assert.equal(scheduledReceipt.counts.accepted,1);assert.equal(scheduledReceipt.items[0]?.target?.scheduledAt,scheduledIntent.scheduledAt);
  assert.equal(scheduledReceipt.items[0]?.target?.accountLabel,account.label);assert.equal(scheduledReceipt.items[0]?.deliveryStatus,"awaiting_operator");
  assert.equal((await readState()).jobs.find(job=>job.id===scheduledReceipt.items[0]?.jobId)?.attempts,0);
  // Over fifty deliveries must remain visible in the aggregate and daily cursor pages.
  await mutateState(current => {
    const template=current.jobs[0]!;
    for(let index=0;index<82;index++) current.jobs.push({...structuredClone(template),id:randomUUID(),status:index===81 ? "awaiting_operator":"scheduled",scheduledAt:"2026-12-15T10:00:00.000Z",createdAt:new Date(Date.now()+index).toISOString(),attempts:0});
  });
  const month = z.object({total:z.number(),days:z.array(z.object({date:z.string(),total:z.number()}))}).parse(await call("workspace/delivery-calendar?month=2026-12"));
  assert.equal(month.total,83);assert.equal(month.days[0]?.total,83);
  const dailySchema=z.object({items:z.array(z.object({id:z.uuid()})),nextCursor:z.string().nullable()});
  const daily=dailySchema.parse(await call("workspace/delivery-calendar/day?month=2026-12&day=2026-12-15"));
  assert.equal(daily.items.length,50);assert(daily.nextCursor);
  const nextDay=dailySchema.parse(await call(`workspace/delivery-calendar/day?month=2026-12&day=2026-12-15&cursor=${encodeURIComponent(daily.nextCursor)}`));
  assert.equal(nextDay.items.length,33);assert.equal(new Set([...daily.items,...nextDay.items].map(item=>item.id)).size,83);
  const logs=z.object({items:z.array(z.object({requestId:z.uuid().optional()}))}).parse(await call("runtime/logs"));assert(logs.items.length>0);
  const started = performance.now();
  for (let i = 0; i < 5; i++) await call("workspace/task-index");
  const mean = (performance.now() - started) / 5;
  assert(mean < 1000);
  console.log(
    JSON.stringify({
      workbenchAcceptance: true,
      workspace,
      taskId: task.id,
      runId: run.id,
      articleId: completed.draftId,
      batchId: queued.id,
      stableEpisodes: true,
      captureReplay: true,
      batchReplay: true,
      apiRestarts: restarts,
      noDuplicateDelivery: true,
      platformRequests: 0,
      indexMeanMs: Math.round(mean),
      fixtureEpisodes: 1000,
    }),
  );
  if (process.argv.includes("--interactive")) {
    console.log(
      JSON.stringify({
        interactiveFixtureReady: true,
        origin: "http://127.0.0.1:14410",
        workspace,
        taskId: task.id,
        runId: run.id,
        articleId: completed.draftId,
        batchId: queued.id,
      }),
    );
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  }
} finally {
  await stop(worker);
  await stop(api);
  for (let i = 0; i < 40; i++) {
    const claim = z
      .object({ msgId: z.number(), token: z.string().uuid() })
      .nullable()
      .parse(
        await dbRpc("studio_claim_role_work", {
          p_workspace: workspace,
          p_role: "all",
        }),
      );
    if (!claim) break;
    await dbRpc("studio_ack_work", {
      p_workspace: workspace,
      p_msg: claim.msgId,
      p_token: claim.token,
    });
  }
  for (const table of [
    "studio_task_links",
    "studio_article_origins",
    "studio_task_resources",
    "studio_task_presentation",
    "studio_library_entries",
    "studio_delivery_batch_items",
    "studio_delivery_batches",
    "studio_discovery_promotions",
    "studio_run_events",
    "studio_task_runs",
    "studio_tasks",
    "studio_video_projects",
    "studio_operations",
    "studio_revisions",
    "studio_editor_state",
    "studio_account_execution_leases",
    "studio_queue_leases",
    "studio_article_commands",
    "content_studio_workspaces",
  ])
    await dbRequest(
      `${table}?${table === "content_studio_workspaces" ? "id" : "workspace_id"}=eq.${workspace}`,
      { method: "DELETE" },
    );
  await rm(root, { recursive: true, force: true });
  process.env = environment;
}
