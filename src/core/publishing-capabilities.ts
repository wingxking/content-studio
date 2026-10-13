import type { Account, Platform, Variant } from './model.ts';
import { nativeUrls, platformIds } from './model.ts';

export const priorityPlatforms = ['reddit', 'producthunt', 'wechat', 'zhihu', 'xiaohongshu', 'bilibili'] as const;
export type ContentKind = 'article' | 'video';
export type PublishingCapabilityConfig = {
  postizConfigured?: boolean;
  expectedYoutubeChannel?: string;
  draftBridgeConnected?: boolean;
  draftBridgeExtensionId?: string | null;
};
export type PublishingCapability = {
  platform: Platform; accountId: string | null; kind: ContentKind;
  route: 'postiz_api' | 'youtube_api' | 'native';
  automatic: boolean; remoteDraft: boolean; providerDraft: boolean; draftRoute: 'none' | 'wechatsync' | 'postiz'; canVerify: boolean;
  stage: 'needs_account' | 'needs_login' | 'blocked' | 'manual' | 'ready' | 'unsupported';
  format: string; nativeUrl: string; blockers: string[]; steps: string[]; sources: string[];
  verification: 'operator_record' | 'provider_check' | 'not_checked';
};
const sources: Partial<Record<Platform, string[]>> = {
  reddit: ['https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy', 'https://docs.postiz.com/public-api/providers/reddit'],
  producthunt: ['https://api.producthunt.com/v2/docs', 'https://help.producthunt.com/en/articles/479557-how-to-post-a-product'],
  wechat: ['https://developers.weixin.qq.com/doc/service/api/public/api_freepublish_submit', 'https://github.com/wechatsync/Wechatsync'],
  zhihu: ['https://github.com/wechatsync/Wechatsync'], bilibili: ['https://open.bilibili.com/'],
  xiaohongshu: ['https://www.xiaohongshu.com/protocols/agreements'],
};
const formats: Partial<Record<Platform, string>> = { reddit: '社区文字帖', producthunt: '产品上线资料', wechat: '公众号文章', zhihu: '知乎专栏文章', xiaohongshu: '图文笔记', bilibili: '专栏文章 / 独立视频' };

export function validateRedditTarget(account: Account, currentTime = Date.now()): void {
  const target = account.reddit;
  if (!target) throw new Error('Reddit automation requires one explicit subreddit, its rules and registered/approved App access reference.');
  const url = new URL(target.rulesUrl);
  if (!new RegExp(`^/r/${target.subreddit}/(?:about/)?rules/?$`, 'i').test(url.pathname)) throw new Error('Reddit rules URL must belong to the selected subreddit rules page.');
  const age = currentTime - Date.parse(target.rulesReviewedAt);
  if (age < -60000 || age > 7 * 86400000) throw new Error('Review the current subreddit rules again; the recorded check must be within seven days.');
  if (target.flairRequired && !target.flair) throw new Error('This subreddit requires a flair template.');
}

export function publishingCapability(platform: Platform, kind: ContentKind, account?: Account, config: PublishingCapabilityConfig = {}): PublishingCapability {
  const capability: PublishingCapability = {
    platform, accountId: account?.id ?? null, kind, route: 'native', automatic: false, remoteDraft: false, providerDraft: false, draftRoute: 'none', canVerify: true,
    stage: account ? 'manual' : 'needs_account', format: kind === 'video' ? '独立视频' : formats[platform] ?? '平台文字稿',
    nativeUrl: platform === 'bilibili' && kind === 'article' ? 'https://member.bilibili.com/platform/upload/text' : nativeUrls[platform],
    blockers: [], verification: account?.verifiedAt ? 'operator_record' : 'not_checked',
    steps: ['使用 radarxai@gmail.com 对应的 Chrome profile，核对实际平台身份。', '打开原生编辑器，预览、完成平台验证并保存草稿或发布。', '保存草稿地址时仍等待发布；仅实际作品链接与标识可登记发布回执。'], sources: sources[platform] ?? [],
  };
  if (!account) capability.blockers.push('尚未登记并核对该平台账号。');
  if (account?.status !== 'connected' && account) { capability.stage = account.status === 'needs_login' ? 'needs_login' : 'blocked'; capability.blockers.push(account.note || '账号登录或权限尚未核验。'); }
  if (kind === 'video' && !['youtube', 'tiktok', 'bilibili', 'kuaishou', 'douyin'].includes(platform)) {
    capability.stage = 'unsupported'; capability.canVerify = false; capability.blockers.push('当前独立视频流水线未接入此目标。'); return capability;
  }
  if (platform === 'producthunt') capability.blockers.push('仅产品上线资料；需要真实产品网址和个人账号 onboarding。默认 API 只读；本项目没有创建产品的写入适配器。');
  if (platform === 'wechat') capability.blockers.push('官方发布权限须逐账号检查；个人及部分未认证账号无法使用群发接口。可连接受支持的扩展保存文章草稿，公开发布仍在平台人工完成。');
  if (platform === 'zhihu') capability.blockers.push('当前提供专栏稿件与原生编辑器；未安装或未验证扩展时，不宣称已同步远端草稿。');
  if (platform === 'xiaohongshu') capability.blockers.push('核对账号类别、内容资格及 AI 标识；本项目没有获准的自动发布连接。');
  if (platform === 'bilibili') capability.blockers.push('专栏文章与视频入口不同；自动投稿需官方应用审核及账号授权。');
  if (kind === 'article' && ['wechat', 'zhihu', 'bilibili'].includes(platform) && (!account || account.provider === 'native')) {
    capability.draftRoute = 'wechatsync';
    const connection = account?.draftConnection;
    const bound = connection?.adapter === 'wechatsync' && connection.permissionConfirmed === true && Boolean(connection.userId.trim());
    const matchingExtension = Boolean(config.draftBridgeExtensionId) && connection?.extensionId === config.draftBridgeExtensionId;
    capability.remoteDraft = account?.platform === platform && account.status === 'connected' && bound && matchingExtension && config.draftBridgeConnected === true;
    if (!bound) capability.blockers.push('在“平台与账号”绑定扩展实际身份，并明确允许保存审核后的文章草稿。');
    else if (!matchingExtension) capability.blockers.push('当前扩展与账号的草稿绑定不一致；请核对配对后重新绑定实际身份。');
    if (!config.draftBridgeConnected) capability.blockers.push('本地草稿桥尚未连接浏览器扩展。启用扩展 MCP 连接后刷新状态。');
    capability.steps.unshift('仅保存 article 格式的文章草稿；每次写入前重新核对平台身份，保存后打开草稿链接检查内容。');
  }
  if (kind === 'video' && platform === 'youtube' && account?.provider === 'native') {
    capability.route = 'youtube_api';
    capability.blockers.push('发布前由 delivery worker 检查现有 OAuth、频道和实际视频；浏览器登录不代替授权。');
    if (account.status === 'connected' && account.integrationId === config.expectedYoutubeChannel) { capability.stage = 'ready'; capability.automatic = true; }
  }
  if (kind === 'article' && account?.provider === 'postiz') {
    capability.route = 'postiz_api';
    if (!['reddit', 'x', 'linkedin'].includes(platform)) { capability.stage = 'unsupported'; capability.blockers.push('当前 Postiz 适配器仅支持 X、LinkedIn、Reddit 文字。'); return capability; }
    capability.draftRoute = 'postiz';
    if (!config.postizConfigured) capability.blockers.push('Docker 服务未配置 POSTIZ_API_KEY。');
    if (!account.integrationId || !account.verifiedAt) capability.blockers.push('尚未只读核验匹配的 Postiz integration。');
    if (platform === 'reddit') { try { validateRedditTarget(account); } catch (error) { capability.blockers.push(error instanceof Error ? error.message : 'Reddit target is not ready.'); } }
    if (account.status === 'connected' && capability.blockers.length === 0) { capability.stage = 'ready'; capability.automatic = true; capability.providerDraft = true; capability.verification = 'provider_check'; }
    else capability.stage = 'blocked';
    capability.steps.unshift('每次提交前重新查询 integration；审批引用属于操作人记录，不是平台审批查询结果。');
    capability.steps.unshift('保存草稿使用独立动作，草稿仅保存在 Postiz 审稿区，不会写入目标平台的原生草稿箱。');
  }
  return capability;
}
export function publishingCapabilities(accounts: Account[], config: PublishingCapabilityConfig = {}): PublishingCapability[] {
  const ordered = [...priorityPlatforms, ...platformIds.filter(platform => !priorityPlatforms.includes(platform as typeof priorityPlatforms[number]))];
  return ordered.flatMap(platform => {
    const targets = accounts.filter(account => account.platform === platform);
    return (targets.length ? targets : [undefined]).flatMap(account => (['article', 'video'] as const).map(kind => publishingCapability(platform, kind, account, config)));
  });
}
export function validateLaunchVariant(variant: Variant): void {
  if (variant.platform === 'producthunt' && !variant.launch) throw new Error('Product Hunt requires an explicit product launch kit: public website, name, tagline, description and first comment. News articles cannot be launched as products.');
}
