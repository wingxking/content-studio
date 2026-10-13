import { useEffect, useState, type FormEvent } from 'react';
import type { Account } from '../core/model.ts';
import type { EcosystemRoute } from '../core/publishing-ecosystem.ts';
import { errorMessage, labels, request, type RunAction } from './api.ts';

export type DraftConnectorIdentity = {
  platform: 'wechat' | 'zhihu' | 'bilibili';
  isAuthenticated: boolean;
  userId?: string;
  username?: string;
  error?: string;
};
type DraftConnectorStatus = {
  bridge: { configured: boolean; connected: boolean; extensionId: string | null; bridgePort: number };
  accounts: DraftConnectorIdentity[];
  ecosystem: EcosystemRoute[];
};
const reviewedPlatforms = ['wechat', 'zhihu', 'bilibili'] as const;

export function DraftConnections({ accounts, busy, action }: { accounts: Account[]; busy: boolean; action: RunAction }) {
  const [status, setStatus] = useState<DraftConnectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [extensionId, setExtensionId] = useState('');
  const [extensionToken, setExtensionToken] = useState('');
  const [connectionUrl, setConnectionUrl] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState('');
  useEffect(() => {
    let active = true;
    void request<DraftConnectorStatus>('publishing/draft-connectors').then(value => {
      if (!active) return;
      setStatus(value); setExtensionId(value.bridge.extensionId ?? ''); setError('');
    }).catch(caught => { if (active) setError(errorMessage(caught)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const refresh = async () => {
    setLoading(true); setError('');
    try {
      const value = await request<DraftConnectorStatus>('publishing/draft-connectors');
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
        setConnectionUrl(result.connectionUrl);
        await refresh();
      } finally { setExtensionToken(''); }
    }, '已保存草稿桥私密配对。请启用扩展连接，再刷新实际账号。');
  };
  const connectAccount = async (identity: DraftConnectorIdentity, accountId: string) => {
    if (!identity.isAuthenticated || !identity.userId || !status?.bridge.connected) { setError('请先刷新并核对已连接的平台身份。'); return; }
    await action(async () => {
      if (accountId) await request(`accounts/${accountId}/draft-connection`, { adapter: 'wechatsync', expectedUserId: identity.userId, permissionConfirmed: true });
      else await request('publishing/draft-connectors/accounts', { platform: identity.platform, expectedUserId: identity.userId, permissionConfirmed: true });
      await refresh();
    }, '已连接核验后的账号，可授权保存草稿；公开发布仍需单独操作。');
  };
  const disabled = busy || loading;
  return <section className="panel capability-panel">
    <div className="panel-heading"><div><h2>平台草稿连接</h2><p className="hint">将审核后的文章版本保存到微信公众号、知乎或哔哩哔哩草稿箱，再到平台编辑器核对并发布。</p></div><span className={`badge ${status?.bridge.connected ? 'green' : 'amber'}`}>{status?.bridge.connected ? '扩展已连接' : status?.bridge.configured ? '等待扩展连接' : '待完成配对'}</span></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <details open={Boolean(connectionUrl) || status !== null && !status.bridge.configured}>
      <summary>连接 WechatSync 官方扩展</summary>
      <ol className="handoff-steps">
        <li>在 Chrome 的 <strong>radarxai@gmail.com</strong> 个人资料中，从 <a href="https://www.wechatsync.com/" target="_blank" rel="noreferrer">WechatSync 官方网站安装扩展 ↗</a>。</li>
        <li>在扩展设置中启用 MCP 桥，查看其 Token。在 Chrome 扩展管理页启用开发者模式，打开详情获取扩展 ID。将两项填入下方。</li>
        <li>保存配对后，将连接地址复制到扩展的 MCP 服务器地址。保持连接开启，并妥善保管此私密地址。</li>
        <li>在上述 Chrome 个人资料中登录目标创作者账号，然后点击下方刷新实际账号。</li>
      </ol>
      <form onSubmit={saveBridge}>
        <div className="form-row"><label>扩展 ID<input required autoComplete="off" value={extensionId} onChange={event => setExtensionId(event.target.value)} disabled={disabled}/></label><label>配对 Token<input required type="password" autoComplete="off" value={extensionToken} onChange={event => setExtensionToken(event.target.value)} disabled={disabled}/></label></div>
        <button disabled={disabled || !extensionId.trim() || !extensionToken} type="submit">保存私密配对</button>
      </form>
      {status?.bridge.configured && <button className="text-button" disabled={disabled} onClick={() => void action(async () => { const result = await request<{ connectionUrl: string }>('publishing/draft-connectors/bridge-connection'); setConnectionUrl(result.connectionUrl); setCopyMessage(''); }, '私密连接地址仅在当前面板显示。')}>显示已有私密连接地址</button>}
      {connectionUrl && <div className="note-card"><label>扩展私密连接地址<textarea readOnly rows={3} value={connectionUrl} spellCheck={false}/></label><div className="job-actions"><button disabled={disabled} onClick={() => { void navigator.clipboard.writeText(connectionUrl).then(() => setCopyMessage('已复制。粘贴到扩展后请清空剪贴板。')).catch(() => setCopyMessage('无法自动复制，请手动选中上方地址并复制。')); }}>复制连接地址</button><button onClick={() => { setConnectionUrl(null); setCopyMessage(''); }}>隐藏连接地址</button></div>{copyMessage && <p role="status" className="hint">{copyMessage}</p>}</div>}
      <p className="hint">配对凭据由本地服务私密保存，此表单不会将其写入浏览器存储。</p>
    </details>
    <div className="section-label"><h3>核对平台实际身份</h3><button disabled={disabled} onClick={() => void action(refresh, '已刷新草稿桥状态与平台实际身份。')}>{loading ? '正在检查…' : '刷新实际账号'}</button></div>
    {!status?.bridge.connected && <p className="hint">连接扩展后才能启用草稿保存；已登记的浏览器登录记录不代表草稿桥已连接。</p>}
    <div className="capability-grid">{reviewedPlatforms.map(platform => {
      const identity = status?.accounts.find(item => item.platform === platform) ?? { platform, isAuthenticated: false };
      return <DraftIdentityCard key={`${platform}:${identity.userId ?? 'none'}:${identity.isAuthenticated}:${status?.bridge.extensionId ?? 'none'}`} identity={identity} accounts={accounts} connected={status?.bridge.connected === true} extensionId={status?.bridge.extensionId} disabled={disabled} onConnect={connectAccount}/>;
    })}</div>
    {status?.ecosystem.length ? <details><summary>发布与草稿接入方案</summary><PublishingEcosystem routes={status.ecosystem}/></details> : null}
  </section>;
}

export function DraftIdentityCard({ identity, accounts, connected, extensionId, disabled, onConnect }: { identity: DraftConnectorIdentity; accounts: Account[]; connected: boolean; extensionId?: string | null; disabled: boolean; onConnect: (identity: DraftConnectorIdentity, accountId: string) => Promise<void> }) {
  const matchingAccounts = accounts.filter(account => account.platform === identity.platform && account.provider === 'native');
  const boundAccount = matchingAccounts.find(account => account.draftConnection?.adapter === 'wechatsync' && account.draftConnection.userId === identity.userId);
  const [selectedAccountId, setAccountId] = useState<string | null>(null);
  const accountId = selectedAccountId ?? boundAccount?.id ?? '';
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const available = connected && identity.isAuthenticated && Boolean(identity.userId);
  const bindingReady = available && boundAccount?.status === 'connected' && boundAccount.draftConnection?.extensionId === extensionId;
  return <article className="note-card">
    <div className="panel-heading"><h3>{labels[identity.platform]}</h3><span className={`badge ${available ? 'green' : 'amber'}`}>{available ? '已识别实际身份' : '待登录或连接'}</span></div>
    {identity.error && <p className="inline-error">{identity.error}</p>}
    {boundAccount?.draftConnection && <p><span className={`badge ${bindingReady ? 'green' : 'amber'}`}>{bindingReady ? '已启用草稿保存' : '已保存绑定，需重新核对账号与扩展'} · {boundAccount.label}</span><br/>上次核对身份：{new Date(boundAccount.draftConnection.checkedAt).toLocaleString('zh-CN')}</p>}
    {available ? <><p><strong>{identity.username || identity.userId}</strong><br/>平台用户 ID：{identity.userId}</p><label>Content Studio 账号<select value={accountId} onChange={event => { setAccountId(event.target.value); setPermissionConfirmed(false); }} disabled={disabled}><option value="">导入此已核验身份</option>{matchingAccounts.map(account => <option value={account.id} key={account.id}>{account.label}</option>)}</select></label><label className="inline-check"><input type="checkbox" checked={permissionConfirmed} disabled={disabled} onChange={event => setPermissionConfirmed(event.target.checked)}/>我拥有或管理此账号，并允许将审核后的文章版本保存到该账号草稿箱。</label><p className="hint">此确认仅授权草稿保存，不代表平台审批通过，也不授权公开发布。</p></> : <p className="hint">请登录目标创作者账号，再刷新并核对其实际身份。</p>}
    <button disabled={disabled || !available || !permissionConfirmed} onClick={() => { setPermissionConfirmed(false); void onConnect(identity, accountId); }}>为此账号启用草稿保存</button>
  </article>;
}

export function PublishingEcosystem({ routes }: { routes: EcosystemRoute[] }) {
  const kinds: Record<EcosystemRoute['kind'], string> = { native_draft: '平台原生草稿', provider_draft: '服务商审稿草稿', inbox_upload: '平台收件箱上传', direct_publish: '直接发布', assisted: '人工辅助平台流程' };
  const statuses: Record<EcosystemRoute['status'], string> = { implemented: '流程已实现，需核对账号接入', requires_integration: '尚需完成适配接入', research_only: '仅调研方案' };
  return <div className="capability-grid">{routes.map(route => <article className="note-card" key={route.id}><h3>{route.name}</h3><p>{kinds[route.kind]} · {statuses[route.status]}</p><p>{route.platforms.map(platform => labels[platform]).join(' · ')}</p><ol>{route.setupSteps.map(step => <li key={step}>{step}</li>)}</ol><ul>{route.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul><a href={route.docsUrl} target="_blank" rel="noreferrer">接入步骤与来源文档 ↗</a></article>)}</div>;
}
