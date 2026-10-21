export const companionVersion = "2.0.13";
export const studioTabs = [
  { id: "content", label: "内容" },
  { id: "resources", label: "资料" },
  { id: "publish", label: "发布" },
  { id: "activity", label: "记录" },
] as const;
export const companionTabs = [
  { id: "capture", label: "采集" },
  { id: "tasks", label: "待处理" },
  { id: "accounts", label: "账号" },
] as const;
export const companionProtocol = "content-studio-companion-ui";
export const companionMethods = [
  "status",
  "tasks.list",
  "tasks.get",
  "capture.create",
  "accounts.list",
  "accounts.check",
  "drafts.run",
  "deliveries.list",
] as const;
export type CompanionMethod = (typeof companionMethods)[number];
export function deliveryLabel(
  status: string | null,
  draftOnly = false,
): string {
  const labels: Record<string, string> = {
    pending: "处理中",
    accepted: "已受理",
    blocked: "需处理",
    failed: "失败",
    scheduled: draftOnly ? "待同步草稿" : "待定时发布",
    submitting: "提交中",
    queued: "平台已接收 · 待确认",
    published: "已发布",
    draft_saved: "草稿已保存 · 未公开",
    awaiting_operator: "待人工操作",
    needs_reconciliation: "需对账",
    cancelled: "已取消",
    delivered: "待平台确认",
  };
  return status ? (labels[status] ?? status) : "尚未交付";
}
