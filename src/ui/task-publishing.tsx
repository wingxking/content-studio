import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Account, Draft, Job } from "../core/model.ts";
import {
  batchMessage,
  batchReceiptSchema,
  preflightSchema,
  type BatchReceipt,
  type DeliveryIntent,
} from "../contracts/workbench.ts";
import { deliveryLabel } from "../contracts/studio-ui.ts";
import { readWorkspace, writeWorkspace } from "../client/workspace.ts";
import { useCommandIds, useHasUnsavedChanges } from "./workspace-hooks.tsx";
import { errorMessage, labels, type RunAction } from "./api.ts";
import { JobPanel } from "./publish-panel.tsx";

export function BatchReceiptPanel({ id }: { id: string }) {
  const receipt = useQuery({
    queryKey: ["workspace", "delivery-batch", id],
    queryFn: ({ signal }) =>
      readWorkspace(`delivery-batches/${id}`, batchReceiptSchema, signal),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (item) =>
          item.status === "pending" ||
          ["scheduled", "submitting", "queued"].includes(
            item.deliveryStatus ?? "",
          ),
      )
        ? 4000
        : false,
    refetchOnWindowFocus: true,
  });
  if (receipt.error)
    return (
      <p role="alert">
        {errorMessage(receipt.error)}{" "}
        <button onClick={() => void receipt.refetch()}>重新读取回执</button>
      </p>
    );
  return receipt.data ? (
    <BatchResults receipt={receipt.data} />
  ) : (
    <p role="status">正在恢复批次回执…</p>
  );
}
export function BatchResults({ receipt }: { receipt: BatchReceipt }) {
  const blocked = receipt.counts.pending === 0 && receipt.counts.accepted === 0;
  return (
    <section className="note-card" aria-label="批次回执">
      <h3>本次操作结果</h3>
      <p
        role={blocked ? "alert" : "status"}
        className={blocked ? "inline-error" : ""}
      >
        {batchMessage(receipt)}
      </p>
      {receipt.items.map((item) => (
        <p key={item.id}>
          {item.target ? `${labels[item.target.platform as keyof typeof labels] ?? item.target.platform} · ${item.target.accountLabel} · ${item.target.title} · ` : "历史目标 · "}
          {item.input.action === "publish" ? "公开提交" : item.input.action === "save_draft" ? "平台草稿" : "人工待办"} · {item.input.subjectKind === "video" ? "视频" : "文章"} r
          {item.input.expectedRevision} ·{" "}
          {deliveryLabel(
            item.deliveryStatus ?? item.status,
            item.input.action === "save_draft",
          )}
          {item.target?.scheduledAt ? ` · ${new Date(item.target.scheduledAt).toLocaleString("zh-CN", { timeZone: item.input.timezone ?? "Asia/Singapore" })}（${item.input.timezone ?? "Asia/Singapore"}）` : ""}
          {item.error ? `：${item.error}` : ""}
          {item.remoteUrl ? (
            <>
              {" "}
              ·{" "}
              <a href={item.remoteUrl} target="_blank" rel="noreferrer">
                查看平台结果 ↗
              </a>
            </>
          ) : null}
        </p>
      ))}
      <small>已受理表示交付任务已创建；公开发布以远端确认结果为准。</small>
    </section>
  );
}
export function TaskPublishing({
  draft,
  accounts,
  jobs,
  action,
  busy,
  batchId,
  onBatch,
}: {
  draft: Draft;
  accounts: Account[];
  jobs: Job[];
  action: RunAction;
  busy: boolean;
  batchId?: string | null;
  onBatch: (id: string) => void;
}) {
  const commands = useCommandIds();
  const dirty = useHasUnsavedChanges();
  const [selected, setSelected] = useState<string[]>([]);
  const [modes, setModes] = useState<Record<string, DeliveryIntent["action"]>>({});
  const [timing, setTiming] = useState("now");
  const [schedule, setSchedule] = useState("");
  const scheduledAt = timing === "later" && schedule && Number.isFinite(Date.parse(`${schedule}+08:00`)) ? new Date(`${schedule}+08:00`).toISOString() : undefined;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const compatible = accounts.filter((account) =>
    draft.variants.some((variant) => variant.platform === account.platform),
  );
  const intents: DeliveryIntent[] = compatible.flatMap((account) =>
    (["publish", "save_draft", "manual_handoff"] as const).map((action) => ({
      subjectKind: "article" as const,
      articleId: draft.id,
      expectedRevision: draft.revision,
      accountId: account.id,
      action,
      ...(scheduledAt && action !== "save_draft" ? { scheduledAt, timezone: "Asia/Singapore" } : {}),
    })),
  );
  const check = useQuery({
    queryKey: [
      "workspace",
      "preflight",
      draft.id,
      draft.revision,
      scheduledAt,
      compatible.map((account) => account.id).join(","),
    ],
    queryFn: () =>
      writeWorkspace(
        "deliveries/preflight",
        { items: intents },
        preflightSchema,
      ),
    enabled: intents.length > 0,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const chosenMode = (accountId: string): DeliveryIntent["action"] => modes[accountId] ?? "manual_handoff";
  const hasTimedTargets = selected.some((accountId) => chosenMode(accountId) !== "save_draft");
  const chosen = check.data?.items.filter(item => selected.includes(item.intent.accountId) && item.intent.action === chosenMode(item.intent.accountId)) ?? [];
  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      if (hasTimedTargets && timing === "later" && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) throw new Error("请选择未来的计划时间。平台草稿仍会立即同步。");
      const prior = new Map(
        check.data?.items.map((item) => [
          `${item.intent.accountId}:${item.intent.action}`,
          item.fingerprint,
        ]),
      );
      const fresh = await check.refetch();
      if (!fresh.data || fresh.error)
        throw fresh.error ?? new Error("请重新检查目标账号。");
      if (
        fresh.data.items.some(
          (item) =>
            selected.includes(item.intent.accountId) &&
            item.intent.action === chosenMode(item.intent.accountId) &&
            prior.get(`${item.intent.accountId}:${item.intent.action}`) !== item.fingerprint,
        )
      )
        throw new Error("内容或账号已变化，预检已更新。请重新审阅后再提交。");
      const currentTargets = fresh.data.items.filter(item => selected.includes(item.intent.accountId) && item.intent.action === chosenMode(item.intent.accountId));
      if (currentTargets.length !== selected.length || currentTargets.some(item => !item.eligible)) throw new Error("所选目标中仍有未就绪项，请处理原因或取消勾选后确认；本次未提交任何目标。");
      const items = fresh.data.items
        .filter(
          (item) =>
            item.eligible &&
            item.intent.action === chosenMode(item.intent.accountId) &&
            selected.includes(item.intent.accountId),
        )
        .map((item) => ({ ...item.intent, fingerprint: item.fingerprint }));
      if (!items.length)
        throw new Error("所选账号当前没有可执行目标，请处理下方原因。");
      const receipt = await writeWorkspace(
        "delivery-batches",
        { commandId: commands(JSON.stringify(items)), items },
        batchReceiptSchema,
      );
      onBatch(receipt.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section>
      <h2>审核当前修订与目标账号</h2>
      <p>
        {draft.title} · r{draft.revision}
      </p>
      <details>
        <summary>预览本次平台稿</summary>
        {draft.variants.map((variant) => (
          <details key={variant.platform}>
            <summary>
              {labels[variant.platform]} · {variant.title}
            </summary>
            <pre className="content-preview">{variant.text}</pre>
          </details>
        ))}
      </details>
      {dirty ? (
        <p role="status" className="inline-error">
          有未保存的修改，请回到内容标签保存后再检查交付。
        </p>
      ) : null}
      {error || check.error ? (
        <p role="alert" className="inline-error">
          {error || errorMessage(check.error)}
        </p>
      ) : null}
      {!compatible.length ? (
        <p>
          连接与当前平台稿匹配的账号后即可交付。
          <a href="/settings/accounts">连接账号 →</a>
        </p>
      ) : null}
      {compatible.map((account) => {
        const options =
          check.data?.items.filter(
            (item) => item.intent.accountId === account.id,
          ) ?? [];
        return (
          <article className="target-row" key={account.id}>
            <label className="inline-check">
              <input
                type="checkbox"
                disabled={busy || submitting}
                checked={selected.includes(account.id)}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(account.id)
                      ? current.filter((id) => id !== account.id)
                      : [...current, account.id],
                  )
                }
              />
              <strong>
                {labels[account.platform]} · {account.label}
              </strong>
            </label>
            <label>本次方式<select disabled={busy || submitting} value={chosenMode(account.id)} onChange={event => setModes(current => ({ ...current, [account.id]: event.target.value as DeliveryIntent["action"] }))}>
              <option value="manual_handoff">人工发布待办</option><option value="save_draft">保存平台草稿</option><option value="publish">系统公开提交</option>
            </select></label>
            {options.filter(item => item.intent.action === chosenMode(account.id)).map(item => <p key={item.intent.action}><span className={`badge ${item.eligible ? "blue" : "amber"}`}>{item.eligible ? "可确认" : "需处理"}</span> {item.eligible ? item.nextAction : item.reasons.join(" ")} {!item.eligible ? item.issues.map(issue => issue.nextAction).filter((value,index,array) => array.indexOf(value) === index).join(" ") : ""}</p>)}
            {!options.length ? <p>正在检查具体版本与账号…</p> : null}
          </article>
        );
      })}
      <fieldset className="note-card" disabled={busy || submitting}><legend>安排时间</legend><label>文章公开提交 / 人工待办<select value={timing} onChange={event => setTiming(event.target.value)}><option value="now">立即处理</option><option value="later">指定时间</option></select></label>{timing === "later" && hasTimedTargets ? <label>计划时间 · Asia/Singapore（UTC+8）<input type="datetime-local" value={schedule} onChange={event => setSchedule(event.target.value)} /></label> : null}<p className="hint">平台草稿立即同步；人工待办的时间表示计划处理时间，届时仍需你在平台完成发布。</p></fieldset>
      <p>本次选择 {selected.length} 个目标：公开提交 {chosen.filter(item => item.intent.action === "publish").length} 个，平台草稿 {chosen.filter(item => item.intent.action === "save_draft").length} 个，人工待办 {chosen.filter(item => item.intent.action === "manual_handoff").length} 个。</p>
      <div className="job-actions"><button disabled={check.isFetching || submitting} onClick={() => void check.refetch()}>重新检查</button><button className="primary" disabled={busy || dirty || submitting || check.isFetching || !selected.length || chosen.length !== selected.length || chosen.some(item => !item.eligible) || (hasTimedTargets && timing === "later" && !scheduledAt)} onClick={() => void submit()}>{submitting ? "正在确认…" : `确认 ${selected.length} 个目标`}</button></div>
      <p className="hint">确认前请检查对应平台稿。任何所选目标未就绪时整批不提交，不会自动改成其他方式。</p>
      {batchId ? <BatchReceiptPanel id={batchId} /> : null}
      <h3>交付记录与平台回执</h3>
      {jobs.length ? (
        jobs.map((job) => (
          <div id={`delivery-${job.id}`} tabIndex={-1} key={job.id}><JobPanel
            job={job}
            title={job.snapshot?.variant.title ?? draft.title}
            account={accounts.find((account) => account.id === job.accountId)}
            busy={busy || submitting}
            action={action}
          /></div>
        ))
      ) : (
        <p>当前内容尚无交付记录。</p>
      )}
    </section>
  );
}
