import type { Job } from './model.ts';
import { DeliveryInputError } from './delivery-errors.ts';

/** Reusing a content identity must not silently change the operator's selected delivery action. */
export function assertPublicationAction(previous: Job, automatic: boolean, options: { automation?: Job['automation']; journalExists?: boolean } = {}): void {
  if (['submitting', 'needs_reconciliation'].includes(previous.status) || options.journalExists && !['published', 'delivered'].includes(previous.status))
    throw new DeliveryInputError('相同内容已有提交中或结果未知的交付，请先核对原任务，不能重新选择交付方式。', 'INPUT_INVALID', '打开原交付核对平台结果');
  const safeUnsent = ['scheduled', 'failed'].includes(previous.status) && !previous.providerPostId && !previous.remoteId && !previous.remoteUrl;
  if (previous.automation && !options.automation && safeUnsent) return;
  if (automatic && previous.status === 'awaiting_operator')
    throw new DeliveryInputError('相同内容已有人工发布待办，请先处理或取消原任务，再选择系统公开提交。', 'INPUT_INVALID', '打开原交付处理或取消人工待办');
  if (!automatic && ['scheduled', 'queued'].includes(previous.status))
    throw new DeliveryInputError('相同内容已有系统提交任务，不能将它作为人工待办受理；请先取消未提交任务，已受理的任务需核对平台结果。', 'INPUT_INVALID', '打开原交付取消未提交任务或核对结果');
}
