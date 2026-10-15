import { markAccountDispatch } from './account-execution.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readDraftBridgeConfig, saveDraftBridgeConfig, draftBridgeConfigSchema } from './draft-bridge-config.ts';
import { mutateState, readState } from './store.ts';
import { type Account, type Job, type Platform } from './model.ts';
import { publishingEcosystem } from './publishing-ecosystem.ts';

export const nativeDraftPlatforms = ['wechat', 'zhihu', 'bilibili'] as const;
export const nativeDraftPlatformSchema = z.enum(nativeDraftPlatforms);
export function sameDraftAccount(job: Job, account: Account): boolean {
  if (job.accountId === account.id) return true;
  const previous = job.snapshot?.account;
  if (account.provider === 'postiz' && previous?.provider === 'postiz' && previous.platform === account.platform && account.integrationId && previous.integrationId === account.integrationId) return true;
  return account.provider === 'native' && previous?.provider === 'native' && previous.platform === account.platform && Boolean(account.draftConnection?.userId) && previous.draftConnection?.userId === account.draftConnection?.userId;
}
export function adapterPlatform(platform: Platform): string {
  const target = nativeDraftPlatformSchema.parse(platform);
  return target === 'wechat' ? 'weixin' : target;
}
const bridgePort = (): number => z.coerce.number().int().min(1024).max(65535).parse(process.env.STUDIO_DRAFT_BRIDGE_PORT ?? 19527);
function bridgeBase(): string {
  const url = new URL(process.env.STUDIO_DRAFT_BRIDGE_URL ?? 'http://127.0.0.1:8915');
  if (!['127.0.0.1', 'localhost', 'draft-bridge'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the local Docker draft bridge.');
  return url.origin;
}
export async function draftBridgeRequest(method: 'checkAuth' | 'syncArticle', params: unknown, signal?: AbortSignal): Promise<unknown> {
  const config = await readDraftBridgeConfig();
  if (!config) throw new Error('Configure the browser draft companion in Accounts first.');
  const timeout = AbortSignal.timeout(method === 'syncArticle' ? 13 * 60_000 : 35_000);
  if (method === 'syncArticle') await markAccountDispatch();
  const response = await fetch(`${bridgeBase()}/request`, { method: 'POST', headers: { Authorization: `Bearer ${config.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error('The draft companion could not complete the request. Check the connection and inspect the platform draft box before retrying a save.');
  return z.object({ result: z.unknown() }).parse(await response.json()).result;
}
const authSchema = z.object({ isAuthenticated: z.boolean(), userId: z.union([z.string(), z.number()]).transform(String).optional(), username: z.string().max(200).optional(), error: z.string().optional() });
export type DraftAccountIdentity = { platform: z.infer<typeof nativeDraftPlatformSchema>; isAuthenticated: boolean; userId?: string; username?: string; error?: string; errorCode?: 'timeout' | 'check_failed' };
function unavailableIdentity(platform: DraftAccountIdentity['platform'], error: unknown): DraftAccountIdentity {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const timeout = /timeout|timed[\s_-]*out|超时/iu.test(message);
  return { platform, isAuthenticated: false, errorCode: timeout ? 'timeout' : 'check_failed', error: timeout ? '平台身份核对超时。请保持扩展连接后重试；当前尚未确认登录状态。' : '平台身份核对暂不可用。请检查扩展连接后重试；当前尚未确认登录状态。' };
}
export async function draftAccountIdentity(platform: Platform): Promise<DraftAccountIdentity> {
  const selected = nativeDraftPlatformSchema.parse(platform);
  try {
    const result = authSchema.parse(await draftBridgeRequest('checkAuth', { platform: adapterPlatform(selected) }));
    if (result.error?.trim()) return unavailableIdentity(selected, result.error);
    const { error: _error, ...identity } = result;
    return { platform: selected, ...identity };
  } catch (error) { return unavailableIdentity(selected, error); }
}
export async function draftBridgeStatus() {
  const config = await readDraftBridgeConfig();
  let connected = false;
  if (config) try {
    const response = await fetch(`${bridgeBase()}/status`, { headers: { Authorization: `Bearer ${config.serviceKey}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (response.ok) connected = z.object({ connected: z.boolean() }).parse(await response.json()).connected;
  } catch { /* An optional disconnected companion does not block the studio. */ }
  return { configured: Boolean(config), connected, extensionId: config?.extensionId ?? null, bridgePort: bridgePort() };
}
export async function draftConnectorStatus(selectedPlatform?: z.infer<typeof nativeDraftPlatformSchema>) {
  const platforms = selectedPlatform === undefined ? nativeDraftPlatforms : [nativeDraftPlatformSchema.parse(selectedPlatform)];
  const bridge = await draftBridgeStatus();
  const accounts: DraftAccountIdentity[] = [];
  // The upstream extension serializes requests, including authentication reads.
  if (bridge.connected) for (const platform of platforms) {
    try { accounts.push(await draftAccountIdentity(platform)); }
    catch { accounts.push(unavailableIdentity(platform, null)); }
  }
  return { bridge, accounts, ecosystem: publishingEcosystem() };
}
export async function draftBridgeConnectionUrl(): Promise<{ connectionUrl: string }> {
  const config = await readDraftBridgeConfig(); if (!config) throw new Error('Configure the companion first.');
  return { connectionUrl: `ws://127.0.0.1:${bridgePort()}/connect?key=${config.pairingKey}` };
}
export async function configureDraftBridge(value: unknown) {
  const input = draftBridgeConfigSchema.pick({ extensionId: true, extensionToken: true }).parse(value);
  if ((await readState()).jobs.some(job => job.deliveryAction === 'save_draft' && job.status === 'submitting')) throw new Error('Wait for the active draft save before changing the companion.');
  await saveDraftBridgeConfig({ ...input, pairingKey: randomBytes(32).toString('base64url'), serviceKey: randomBytes(32).toString('base64url') });
  return draftBridgeConnectionUrl();
}
export const bindDraftAccountSchema = z.object({ expectedUserId: z.string().min(1).max(200), permissionConfirmed: z.literal(true) });
export async function bindDraftAccount(platform: Platform, input: z.infer<typeof bindDraftAccountSchema>, accountId?: string): Promise<Account> {
  const permission = bindDraftAccountSchema.parse(input);
  const config = await readDraftBridgeConfig(); if (!config) throw new Error('Configure the companion first.');
  const identity = await draftAccountIdentity(platform);
  if (identity.error) throw new Error(identity.error);
  if (!identity.isAuthenticated || identity.userId !== permission.expectedUserId) throw new Error('The signed-in platform identity changed. Refresh connections and choose the actual account.');
  return mutateState(state => {
    let account = accountId ? state.accounts.find(item => item.id === accountId) : state.accounts.find(item => item.platform === platform && item.draftConnection?.userId === identity.userId);
    if (accountId && (!account || account.platform !== platform || account.provider !== 'native')) throw new Error('Select a native account for this platform.');
    if (state.accounts.some(other => other.id !== account?.id && other.provider === 'native' && other.platform === platform && other.draftConnection?.userId === identity.userId)) throw new Error('This platform identity is already bound to another account. Use that existing account.');
    const existingId = account?.id;
    if (existingId && state.jobs.some(job => job.accountId === existingId && ['submitting', 'needs_reconciliation'].includes(job.status))) throw new Error('Resolve the active or uncertain delivery before rebinding this account.');
    if (state.jobs.some(job => job.snapshot?.account.platform === platform && job.snapshot.account.draftConnection?.userId === identity.userId && ['submitting', 'needs_reconciliation'].includes(job.status))) throw new Error('Resolve the existing delivery for this platform identity before rebinding it.');
    if (!account) { account = { id: randomUUID(), platform, label: identity.username || `${platform} ${identity.userId}`, provider: 'native', integrationId: '', status: 'connected', note: 'Browser companion draft connection; public publishing remains a separate action.', verifiedAt: null }; state.accounts.push(account); }
    account.draftConnection = { adapter: 'wechatsync', userId: permission.expectedUserId, extensionId: config.extensionId, checkedAt: new Date().toISOString(), permissionConfirmed: true };
    account.physicalIdentity = { id: permission.expectedUserId, verification: 'browser', verifiedAt: account.draftConnection.checkedAt };
    account.status = 'connected'; account.verifiedAt = account.draftConnection.checkedAt;
    return account;
  });
}
export async function verifyDraftAccount(account: Account): Promise<void> {
  const config = await readDraftBridgeConfig(); const connection = account.draftConnection;
  if (account.provider !== 'native' || account.status !== 'connected' || !connection?.permissionConfirmed || !config || connection.extensionId !== config.extensionId) throw new Error('Connect and confirm this native draft account first.');
  const identity = await draftAccountIdentity(account.platform);
  if (identity.error) throw new Error(identity.error);
  if (!identity.isAuthenticated || identity.userId !== connection.userId) throw new Error('The browser account differs from the reviewed target. Restore the selected platform login before saving.');
}
