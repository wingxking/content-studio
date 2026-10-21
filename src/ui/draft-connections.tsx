import { companionVersion } from '../contracts/studio-ui.ts';
import { useEffect, useState, type FormEvent } from 'react';
import type { Account } from '../core/model.ts';
import type { EcosystemRoute } from '../core/publishing-ecosystem.ts';
import { errorMessage, labels, request, type RunAction } from './api.ts';
import { DraftRecoveryPanel } from './draft-recovery.tsx';

export type DraftConnectorIdentity = {
  platform: 'wechat' | 'zhihu' | 'bilibili';
  isAuthenticated: boolean;
  userId?: string;
  username?: string;
  error?: string;
  errorCode?: 'timeout' | 'check_failed' | 'identity_incomplete';
};
type DraftConnectorStatus = {
  bridge: { configured: boolean; connected: boolean; extensionId: string | null; bridgePort: number; reconciliationSupported?: boolean };
  accounts: DraftConnectorIdentity[];
  ecosystem: EcosystemRoute[];
};
const reviewedPlatforms = ['wechat', 'zhihu', 'bilibili'] as const;

export function DraftBridgeRecovery({ bridge }: { bridge: DraftConnectorStatus['bridge'] }) {
  if (bridge.connected) return null;
  return <aside className="note-card" aria-label="恢复草稿连接"><h3>{bridge.configured ? '恢复已有扩展连接' : '连接文章同步扩展'}</h3><p>{bridge.configured ? '先在指定 Chrome 资料中打开 Content Studio 扩展，检查连接开关，再刷新状态。连接未恢复前，仍可复制或导出文稿。' : '完成下方配对后，才能核对实际账号并保存平台草稿。'}</p>{bridge.configured ? <p>已保存的扩展 ID：<code>{bridge.extensionId ?? '未知'}</code><br/>本地桥接端口：{bridge.bridgePort}</p> : null}<p className="hint">若扩展管理页中的 ID 与这里不同，属于扩展迁移；先核对已有未确认任务，再迁移配对和账号绑定。不要清除扩展日志或重发结果不明的草稿。</p></aside>;
}

export function DraftConnections({ accounts, busy, action }: { accounts: Account[]; busy: boolean; action: RunAction }) {
  const [status, setStatus] = useState<DraftConnectorStatus | null>(null);
  const [reviewPlatform, setReviewPlatform] = useState<DraftConnectorIdentity['platform']>('zhihu');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [extensionId, setExtensionId] = useState('');
  const [extensionToken, setExtensionToken] = useState('');
  const [connectionUrl, setConnectionUrl] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const [pairingExpanded, setPairingExpanded] = useState(false);
  useEffect(() => { if (status && !status.bridge.configured) setPairingExpanded(true); }, [status?.bridge.configured]);
  useEffect(() => {
    let active = true;
    void request<DraftConnectorStatus>(`publishing/draft-connectors?platform=${reviewPlatform}`).then(value => {
      if (!active) return;
      setStatus(value); setExtensionId(value.bridge.extensionId ?? ''); setError('');
    }).catch(caught => { if (active) setError(errorMessage(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reviewPlatform]);
  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const value = await request<DraftConnectorStatus>(`publishing/draft-connectors?platform=${reviewPlatform}`);
      setStatus(value); setExtensionId(value.bridge.extensionId ?? '');
      if (value.bridge.connected) { setConnectionUrl(null); setCopyMessage(''); }
    } catch (caught) { setError(errorMessage(caught)); throw caught; }
    finally { setLoading(false); }
  };
  const saveBridge = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => {
      setConnectionUrl(null); setCopyMessage('');
      try {
        const result = await request<{ connectionUrl: string }>('publishing/draft-connectors/bridge', { extensionId: extensionId.trim(), extensionToken });
        setConnectionUrl(result.connectionUrl); setPairingExpanded(true);
        await refresh();
      } finally { setExtensionToken(''); }
    }, '已保存草稿桥私密配对。请启用扩展连接，再刷新实际账号。');
  };
  const connectAccount = async (identity: DraftConnectorIdentity, accountId: string) => {
    if (identity.error || identity.platform !== reviewPlatform || !identity.isAuthenticated || !identity.userId || !status?.bridge.connected) { setError(identity.error ?? '请先刷新并核对当前选择的平台身份。'); return; }
    await action(async () => {
      if (accountId) await request(`accounts/${accountId}/draft-connection`, { adapter: 'wechatsync', expectedUserId: identity.userId, permissionConfirmed: true });
      else await request('publishing/draft-connectors/accounts', { platform: identity.platform, expectedUserId: identity.userId, permissionConfirmed: true });
      await refresh();
    }, '已连接核验后的账号，可授权保存草稿；公开发布仍需单独操作。');
  };
  const disabled = busy || loading;
  return <section className="panel capability-panel">
    <div className="panel-heading"><div><h2>平台草稿连接</h2><p className="hint">将审核后的文章版本保存到微信公众号、知乎或哔哩哔哩草稿箱，再到平台编辑器核对并发布。</p></div><span className={`badge ${status?.bridge.connected ? 'green' : 'amber'}`}>{!status ? loading ? '正在核对连接' : '连接状态未知' : status.bridge.connected ? '扩展已连接' : status.bridge.configured ? '等待扩展连接' : '待完成配对'}</span></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {status ? <DraftBridgeRecovery bridge={status.bridge}/> : null}
    {status?.bridge.connected && status.bridge.reconciliationSupported ? <DraftRecoveryPanel enabled extensionId={status.bridge.extensionId} busy={busy} action={action}/> : null}
    <details open={pairingExpanded} onToggle={event => setPairingExpanded(event.currentTarget.open)}>
      <summary>{status?.bridge.configured ? '修复或迁移插件连接' : '连接 Content Studio 插件'}</summary><p><a className="button" href="/downloads/content-studio-extension.zip" download>下载插件 {companionVersion}</a> <a href="/downloads/content-studio-extension-source.zip" download>对应源码与许可证</a></p>
      <ol className="handoff-steps">
        <li>在 Chrome 的 <strong>radarxai@gmail.com</strong> 个人资料中，打开 Chrome 扩展管理页，启用开发者模式，点击“加载已解压的扩展程序”，选择固定安装目录 <code>extension/artifacts/content-studio-v1/dist</code>。以后更新同一目录并重载，避免改变扩展 ID。</li>
        <li>在插件“连接设置”启用工作台连接，复制扩展 ID 和配对 Token，填入下方。</li>
        <li>保存配对后，将私密连接地址粘贴到插件并点击“保存连接地址”。保持 Chrome 和工作台运行。</li>
        <li>在上述 Chrome 个人资料中登录目标创作者账号，然后点击下方刷新实际账号。</li>
      </ol>
      <form onSubmit={saveBridge}>
        {status?.bridge.configured && extensionId.trim() && extensionId.trim()!==status.bridge.extensionId ? <p role="status" className="hint">将迁移到另一扩展 ID。原账号绑定与未知记录会保留，连接成功后仍需逐账号核对身份。</p> : null}
        <div className="form-row"><label>扩展 ID<input required autoComplete="off" value={extensionId} onChange={event => setExtensionId(event.target.value)} disabled={disabled}/></label><label>配对 Token<input required type="password" autoComplete="off" value={extensionToken} onChange={event => setExtensionToken(event.target.value)} disabled={disabled}/></label></div>
        <button disabled={disabled || !extensionId.trim() || !extensionToken} type="submit">保存私密配对</button>
      </form>
      {status?.bridge.configured && <button className="text-button" disabled={disabled} onClick={() => void action(async () => { const result = await request<{ connectionUrl: string }>('publishing/draft-connectors/bridge-connection'); setConnectionUrl(result.connectionUrl); setPairingExpanded(true); setCopyMessage(''); }, '私密连接地址仅在当前面板显示。')}>显示已有私密连接地址</button>}
      {connectionUrl && <div className="note-card"><label>扩展私密连接地址<input type="password" readOnly value={connectionUrl} spellCheck={false} autoComplete="off"/></label><div className="job-actions"><button disabled={disabled} onClick={() => { void navigator.clipboard.writeText(connectionUrl).then(() => setCopyMessage('已复制。粘贴到扩展后请清空剪贴板。')).catch(() => setCopyMessage('无法自动复制，请手动选中上方地址并复制。')); }}>复制连接地址</button><button onClick={() => { setConnectionUrl(null); setCopyMessage(''); }}>隐藏连接地址</button></div>{copyMessage && <p role="status" className="hint">{copyMessage}</p>}</div>}
      <p className="hint">需使用本项目适配版扩展；官方原版不含 Studio 任务与账号校验协议。配对凭据由本地服务私密保存，此表单不会将其写入浏览器存储。</p>
    </details>
    <div className="section-label"><h3>核对平台实际身份</h3><label>核对平台<select value={reviewPlatform} disabled={disabled} onChange={event => { setStatus(null); setError(''); setLoading(true); setReviewPlatform(event.target.value as DraftConnectorIdentity['platform']); }}>{reviewedPlatforms.map(platform => <option key={platform} value={platform}>{labels[platform]}</option>)}</select></label><button disabled={disabled} onClick={() => void action(refresh, `已刷新${labels[reviewPlatform]}实际身份；未检查其他平台。`)}>{loading ? '正在检查…' : '刷新实际账号'}</button></div>
    <p className="hint">本轮仅核对{labels[reviewPlatform]}，未检查其他平台。初次加载、刷新和保存配对后均只检查当前选择的平台。</p>
    {status && !status.bridge.connected && <p className="hint">连接扩展后才能启用草稿保存；已登记的浏览器登录记录不代表草稿桥已连接。</p>}
    <div className="capability-grid">{reviewedPlatforms.map(platform => {
      const identity = status?.accounts.find(item => item.platform === platform) ?? { platform, isAuthenticated: false };
      return <DraftIdentityCard key={`${platform}:${identity.userId ?? 'none'}:${identity.isAuthenticated}:${status?.bridge.extensionId ?? 'none'}`} identity={identity} accounts={accounts} connected={status?.bridge.connected === true} checked={status?.accounts.some(item => item.platform === platform) === true} extensionId={status?.bridge.extensionId} disabled={disabled} onConnect={connectAccount}/>;
    })}</div>
    {status?.ecosystem.length ? <details><summary>发布与草稿接入方案</summary><PublishingEcosystem routes={status.ecosystem}/></details> : null}
  </section>;
}

export function DraftIdentityCard({ identity, accounts, connected, checked = true, extensionId, disabled, onConnect }: { identity: DraftConnectorIdentity; accounts: Account[]; connected: boolean; checked?: boolean; extensionId?: string | null; disabled: boolean; onConnect: (identity: DraftConnectorIdentity, accountId: string) => Promise<void> }) {
  const matchingAccounts = accounts.filter(account => account.platform === identity.platform && account.provider === 'native');
  const boundAccount = matchingAccounts.find(account => account.draftConnection?.adapter === 'wechatsync' && account.draftConnection.userId === identity.userId);
  const [selectedAccountId, setAccountId] = useState<string | null>(null);
  const accountId = selectedAccountId ?? boundAccount?.id ?? '';
  const selectedAccount = matchingAccounts.find(account => account.id === accountId);
  const changedIdentity = Boolean(selectedAccount?.draftConnection && selectedAccount.draftConnection.userId !== identity.userId);
  const changedExtension = Boolean(selectedAccount?.draftConnection && selectedAccount.draftConnection.extensionId !== extensionId);
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const available = checked && connected && !identity.error && identity.isAuthenticated && Boolean(identity.userId);
  const bindingReady = available && boundAccount?.status === 'connected' && boundAccount.draftConnection?.extensionId === extensionId;
  return <article className="note-card">
    <div className="panel-heading"><h3>{labels[identity.platform]}</h3><span className={`badge ${available ? 'green' : 'amber'}`}>{!checked ? '未核对本平台' : identity.error ? identity.errorCode === 'timeout' ? '身份核对超时' : '身份核对不可用' : available ? '已识别实际身份' : '待登录或连接'}</span></div>
    {identity.error && <p className="inline-error">{identity.error}</p>}
    {boundAccount?.draftConnection && <p><span className={`badge ${bindingReady ? 'green' : 'amber'}`}>{bindingReady ? '已启用草稿保存' : '已保存绑定，需重新核对账号与扩展'} · {boundAccount.label}</span><br/>上次核对身份：{new Date(boundAccount.draftConnection.checkedAt).toLocaleString('zh-CN')}</p>}
    {!available ? matchingAccounts.filter(account => account.draftConnection && account !== boundAccount).map(account => <p className="hint" key={account.id}>已保存绑定：{account.label} · {connected ? '等待核对当前实际身份' : '等待扩展连接'}；此记录不表示当前可保存草稿。</p>) : null}
    {available ? <><p><strong>{identity.username || identity.userId}</strong><br/>平台用户 ID：{identity.userId}</p><label>Content Studio 账号<select value={accountId} onChange={event => { setAccountId(event.target.value); setPermissionConfirmed(false); }} disabled={disabled}><option value="">导入此已核验身份</option>{matchingAccounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}</select></label><label className="inline-check"><input type="checkbox" checked={permissionConfirmed} disabled={disabled} onChange={event => setPermissionConfirmed(event.target.checked)}/>我拥有或管理此账号，并允许将审核后的文章版本保存到该账号草稿箱。</label><p className="hint">此确认仅授权草稿保存，不代表平台审批通过，也不授权公开发布。</p></> : <p className="hint">{!connected ? '请先恢复扩展连接，再核对实际身份。连接中断不能证明平台已经退出登录。' : !checked ? '本轮没有访问此平台；如需核对，请在上方明确选择该平台。' : identity.error ? '核对尚未完成，不代表账号已经退出登录；本次不能绑定或保存草稿。' : '请登录目标创作者账号，再刷新并核对其实际身份。'}</p>}
    {available && !accountId && matchingAccounts.some(account=>account.draftConnection && account.draftConnection.userId!==identity.userId) ? <p role="status" className="hint">当前平台身份与已有绑定不同。继续操作会新增账号，不会替换原账号或迁移其历史任务。</p> : null}
    {available && (changedIdentity || changedExtension) ? <p role="status" className="inline-error">{changedIdentity ? '当前检测到的用户 ID 与此账号保存的绑定不同，请先核对目标身份。' : '此账号绑定的扩展 ID 已变化，需要重新核对并授权。'}已有结果不明的写入必须先对账；绑定不会替你处理原任务。</p> : null}
    <button disabled={disabled || !available || !permissionConfirmed} onClick={() => { setPermissionConfirmed(false); void onConnect(identity, accountId); }}>{available && !accountId ? '导入当前身份并启用草稿保存' : '为所选账号启用草稿保存'}</button>
  </article>;
}

export function PublishingEcosystem({ routes }: { routes: EcosystemRoute[] }) {
  const kinds: Record<EcosystemRoute['kind'], string> = { native_draft: '平台原生草稿', provider_draft: '服务商审稿草稿', inbox_upload: '平台收件箱上传', direct_publish: '直接发布', assisted: '人工辅助平台流程' };
  const statuses: Record<EcosystemRoute['status'], string> = { implemented: '流程已实现，需核对账号接入', requires_integration: '尚需完成适配接入', research_only: '仅调研方案' };
  return <div className="capability-grid">{routes.map(route => <article className="note-card" key={route.id}><h3>{route.name}</h3><p>{kinds[route.kind]} · {statuses[route.status]}</p><p>{route.platforms.map(platform => labels[platform]).join(' · ')}</p><ol>{route.setupSteps.map(step => <li key={step}>{step}</li>)}</ol><ul>{route.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul><a href={route.docsUrl} target="_blank" rel="noreferrer">接入步骤与来源文档 ↗</a></article>)}</div>;
}
