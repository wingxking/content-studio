import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BatchResults } from "../src/ui/task-publishing.tsx";
import {
  batchInputSchema,
  batchMessage,
  deliveryIntentSchema,
  taskHref,
  type BatchReceipt,
} from "../src/contracts/workbench.ts";
import { deliveryLabel } from "../src/contracts/studio-ui.ts";
import {
  taskDeliveryTargets,
  hasAutomaticDelivery,
} from "../src/contracts/task-automation.ts";
import {
  deliveryFingerprint,
  deliveryPreflight,
} from "../src/core/delivery-preflight.ts";
import { createDraft, addAccount, approveDraft, preparePublication, cancelJob } from "../src/core/pipeline.ts";
import { readState, mutateState } from "../src/core/store.ts";
import { taskInputSchema } from "../src/core/task-model.ts";
import { newTaskInput } from "../src/ui/task-panel.tsx";

test("all-blocked batch feedback cannot imply successful submission or publication", () => {
  const input = deliveryIntentSchema.parse({
    articleId: randomUUID(),
    expectedRevision: 1,
    accountId: randomUUID(),
    action: "publish",
  });
  const receipt: BatchReceipt = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    items: [
      {
        id: randomUUID(),
        input: { ...input, fingerprint: "a".repeat(64) },
        status: "blocked",
        jobId: null,
        error: "账号需登录",
        deliveryStatus: null,
        remoteUrl: null,
        target: null,
      },
    ],
    counts: { pending: 0, accepted: 0, blocked: 1, failed: 0 },
  };
  const html = renderToStaticMarkup(createElement(BatchResults, { receipt }));
  assert.match(html, /role="alert"/u);
  assert.match(html, /已受理 0 项/u);
  assert.doesNotMatch(html, /alert success|发布成功|已提交所选/u);
  assert.match(batchMessage(receipt), /需处理 1 项/u);
});
test("delivery state labels distinguish platform drafts, queue acceptance and confirmed publication", () => {
  assert.equal(deliveryLabel("draft_saved", true), "草稿已保存 · 未公开");
  assert.equal(deliveryLabel("scheduled", true), "待同步草稿");
  assert.equal(deliveryLabel("queued"), "平台已接收 · 待确认");
  assert.equal(deliveryLabel("published"), "已发布");
});
test("task links retain stable domain identity and episode context", () => {
  const id = randomUUID();
  const episode = randomUUID();
  assert.equal(
    taskHref({ kind: "plan", id }, "publish", episode),
    `/tasks/plan/${id}/publish?episode=${episode}`,
  );
  assert.equal(taskHref({ kind: "video", id }), `/tasks/video/${id}/overview`);
});
test("mixed per-account modes preserve legacy normalization and evidence-publication gate", () => {
  const first = randomUUID();
  const second = randomUUID();
  assert.deepEqual(
    taskDeliveryTargets({
      mode: "manual",
      accountIds: [first],
      publicationTime: "18:00",
      dayOffset: 0,
      authorized: false,
    }),
    [{ accountId: first, mode: "review" }],
  );
  const value = newTaskInput("content");
  value.title = "Software";
  value.prompt = "Explain software revisions";
  value.model = "fixture-model";
  value.delivery = {
    version: 2,
    targets: [
      { accountId: first, mode: "draft" },
      { accountId: second, mode: "review" },
    ],
    publicationTime: "18:00",
    dayOffset: 0,
    authorized: false,
  };
  assert.doesNotThrow(() => taskInputSchema.parse(value));
  assert.equal(hasAutomaticDelivery(value.delivery), false);
  value.delivery.targets[1]!.mode = "automatic";
  assert.equal(hasAutomaticDelivery(value.delivery), true);
  assert.throws(() => taskInputSchema.parse(value), /human publication/u);
});
test("batch contracts reject ambiguous subjects, changed target shapes and overlarge batches", () => {
  const intent = {
    articleId: randomUUID(),
    expectedRevision: 1,
    accountId: randomUUID(),
    action: "publish",
  };
  assert.throws(() =>
    deliveryIntentSchema.parse({ ...intent, videoId: randomUUID() }),
  );
  assert.throws(() =>
    deliveryIntentSchema.parse({ ...intent, subjectKind: "video" }),
  );
  assert.throws(() =>
    batchInputSchema.parse({
      commandId: randomUUID(),
      items: Array.from({ length: 101 }, () => ({
        ...intent,
        fingerprint: "a".repeat(64),
      })),
    }),
  );
  assert.equal(
    deliveryFingerprint({ b: 2, a: 1 }),
    deliveryFingerprint({ a: 1, b: 2 }),
  );
});
test("preflight is read-only, blocks unsupported public delivery and binds account identity without binding approval metadata", async () => {
  const environment = { ...process.env };
  const native = globalThis.fetch;
  const root = await mkdtemp(join(tmpdir(), "studio-preflight-"));
  try {
    process.env.STUDIO_DATA_DIR = root;
    delete process.env.STUDIO_WORKSPACE_ID;
    delete process.env.STUDIO_CONTAINER;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.STUDIO_MODEL_EXECUTOR_URL;
    globalThis.fetch = async () => {
      throw new Error(
        "No network access is allowed during this fixture preflight.",
      );
    };
    const draft = await createDraft(
      {
        topic: "Software snapshots",
        audience: "Developers",
        angle: "Stable revisions",
        sources: [
          {
            title: "Fixture",
            url: "https://example.com",
            excerpt: "Synthetic reference.",
          },
        ],
        platforms: ["zhihu"],
      },
      {
        title: "Software snapshots",
        body: "Save stable revisions.",
        variants: [
          {
            platform: "zhihu",
            format: "article",
            title: "Software snapshots",
            text: "Save stable revisions.",
            tags: [],
            mediaPaths: [],
          },
        ],
      },
    );
    const account = await addAccount({
      platform: "zhihu",
      label: "Fixture creator",
      provider: "native",
      integrationId: "fixture-one",
      status: "connected",
      note: "fixture",
      verifiedAt: null,
    });
    const input = {
      subjectKind: "article",
      articleId: draft.id,
      expectedRevision: 1,
      accountId: account.id,
      action: "manual_handoff",
    };
    await mutateState((state) => {
      state.paused = false;
    });
    const before = JSON.stringify(await readState());
    const first = await deliveryPreflight({
      items: [input, { ...input, action: "publish" }],
    });
    assert.equal(JSON.stringify(await readState()), before);
    assert.equal(first.items[0]?.eligible, true);
    assert.equal(first.items[1]?.eligible, false);
    assert.match(first.items[1]?.reasons.join("") ?? "", /人工发布/u);
    await approveDraft(draft.id, 1);
    const approved = await deliveryPreflight({ items: [input] });
    assert.equal(approved.items[0]?.fingerprint, first.items[0]?.fingerprint);
    await mutateState((state) => {
      state.accounts[0]!.integrationId = "fixture-two";
    });
    const changed = await deliveryPreflight({ items: [input] });
    assert.notEqual(changed.items[0]?.fingerprint, first.items[0]?.fingerprint);
    assert.equal((await readState()).jobs.length, 0);
  } finally {
    process.env = { ...environment };
    globalThis.fetch = native;
    await rm(root, { recursive: true, force: true });
  }
});

test("replaying a cancelled stable delivery command never creates duplicate job identities", async () => {
  const environment = {...process.env};
  const root = await mkdtemp(join(tmpdir(), "studio-cancel-replay-"));
  try {
    process.env.STUDIO_DATA_DIR = root;
    for (const key of ["STUDIO_WORKSPACE_ID", "STUDIO_CONTAINER", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "STUDIO_MODEL_EXECUTOR_URL"]) delete process.env[key];
    const draft = await createDraft({topic:"Software revisions",audience:"Developers",angle:"Stable snapshots",sources:[{title:"Synthetic reference",url:"https://example.com/fixture",excerpt:"A software fixture."}],platforms:["zhihu"]},{title:"Software revisions",body:"Keep a stable snapshot.",variants:[{platform:"zhihu",format:"article",title:"Software revisions",text:"Keep a stable snapshot.",tags:[],mediaPaths:[]}]});
    const account = await addAccount({platform:"zhihu",label:"Fixture",provider:"native",integrationId:"fixture-only",status:"connected",note:"No real account",verifiedAt:null});
    await approveDraft(draft.id,1);
    const command = {draftId:draft.id,accountId:account.id,expectedRevision:1,automatic:false,jobId:randomUUID()};
    const first = await preparePublication(command);
    assert.equal((await preparePublication(command)).id,first.id);
    await cancelJob(first.id);
    await assert.rejects(preparePublication(command),/Delivery command changed/u);
    const jobs = (await readState()).jobs;
    assert.equal(jobs.length,1);
    assert.equal(jobs[0]?.status,"cancelled");
  } finally {
    process.env = environment;
    await rm(root,{recursive:true,force:true});
  }
});
