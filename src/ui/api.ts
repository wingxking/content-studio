import type { Platform } from '../core/model.ts';

export type RunAction = (task: () => Promise<unknown>, message: string) => Promise<void>;
export type Asset = { id: string; name: string; mime: string; bytes: number; createdAt: string; url: string };
export type CodexModel = { id: string; name: string; description: string };
export type DownloadFile = { name: string; url: string };
export const labels: Record<Platform, string> = { xiaohongshu: '小红书', reddit: 'Reddit', x: 'X', wechat: '微信公众号', tiktok: 'TikTok', bilibili: '哔哩哔哩', youtube: 'YouTube', kuaishou: '快手', douyin: '抖音', instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook' };
const statuses: Record<string, string> = { queued: '已排队', researching: '研究来源中', generating: '生成稿件中', succeeded: '已完成', failed: '失败', cancelled: '已取消', running: '执行中', scheduled: '等待执行', submitting: '提交中', awaiting_operator: '等待人工操作', needs_reconciliation: '需要核验结果', published: '已公开发布并记录', delivered: '已上传 · 非公开', needs_login: '需要登录', connected: '已核验账号', blocked: '权限或验证受阻' };
export const statusLabel = (status: string) => statuses[status] ?? status;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请查看错误并重试。';
export const request = async <T,>(path: string, body?: unknown, method = 'POST'): Promise<T> => {
  const response = await fetch(`/api/${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : '请求失败');
  return data as T;
};
export const uploadAsset = async (file: File): Promise<{ path: string; asset: Asset }> => {
  const response = await fetch('/api/assets', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file });
  const data = await response.json() as { path?: string; asset?: Asset; error?: string };
  if (!response.ok || !data.path || !data.asset) throw new Error(data.error ?? '素材上传失败');
  return { path: data.path, asset: data.asset };
};
