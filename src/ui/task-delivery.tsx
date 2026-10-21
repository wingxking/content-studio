import type { z } from 'zod';
import { hasAutomaticDelivery, taskDeliveryTargets, taskDeliveryV2Schema } from '../contracts/task-automation.ts';
import type { Account } from '../core/model.ts';
import type { TaskInput } from '../core/task-model.ts';
import { defaultBrandProfile, type BrandProfile } from '../contracts/brand.ts';
import { labels } from './api.ts';

export function TaskDeliverySettings({ value, accounts, onChange }: { value: TaskInput; accounts: Account[]; onChange: (delivery: TaskInput['delivery']) => void }) {
  const delivery = value.delivery;
  const targets = taskDeliveryTargets(delivery);
  const automatic = hasAutomaticDelivery(delivery);
  const set = (patch: Partial<z.infer<typeof taskDeliveryV2Schema>>) => onChange({ version: 2, targets, publicationTime: delivery?.publicationTime ?? '18:00', dayOffset: delivery?.dayOffset ?? 0, ...(delivery?.onceAt ? { onceAt: delivery.onceAt } : {}), authorized: false, ...patch });
  return <section className="note-card"><h3>交付方式</h3><p className="hint">默认生成后待审。每个账号分别设置；草稿保存后仍需在平台公开发布。自动发布能力变化时转待处理，不自动改为草稿。</p>
    {accounts.filter(account => value.platforms.includes(account.platform)).map(account => <label key={account.id}>{labels[account.platform]} · {account.label}<select value={targets.find(target => target.accountId === account.id)?.mode ?? 'review'} onChange={event => set({ targets: [...targets.filter(target => target.accountId !== account.id), { accountId: account.id, mode: event.target.value as 'review' | 'draft' | 'automatic' }] })}><option value="review">生成后待审 · 人工点击发布</option><option value="draft">自动送草稿</option><option value="automatic" disabled={value.kind === 'discovery' || value.pipelineVersion === 2}>规则授权后自动发布</option></select></label>)}
    {!accounts.some(account => value.platforms.includes(account.platform)) ? <p>可以先生产内容，再连接平台账号。</p> : null}
    {value.pipelineVersion === 2 ? <p className="hint">深入研究流程当前需要人工审阅后公开发布，可自动保存已通过质量检查的平台草稿。</p> : null}
    {automatic ? <>{value.frequency.type === 'once' ? <label>公开发布时间<input required type="datetime-local" value={delivery?.onceAt ? localDateTime(delivery.onceAt) : ''} onChange={event => set({ onceAt: event.target.value ? new Date(event.target.value).toISOString() : undefined })}/><span className="hint">此输入采用浏览器本机时区。</span></label> : <div className="form-row"><label>发布时间<input type="time" required value={delivery?.publicationTime ?? '18:00'} onChange={event => set({ publicationTime: event.target.value })}/></label><label>生产后的日期<select value={delivery?.dayOffset ?? 0} onChange={event => set({ dayOffset: Number(event.target.value) })}>{[0,1,2,3,4,5,6,7].map(day => <option key={day} value={day}>{day === 0 ? '当天' : `${day} 天后`}</option>)}</select></label></div>}
    <p className="hint">使用计划时区 {value.frequency.timezone}。到点未就绪转待处理，不集中补发。</p><label className="inline-check"><input type="checkbox" required={value.enabled} checked={delivery?.authorized ?? false} onChange={event => set({ authorized: event.target.checked })}/>授权此任务按当前选题、来源、账号、频率和品牌版本自动发布</label><p className="hint">修改配置后需重新勾选授权。内容评估由模型报告，不代表平台审核。</p></> : null}
  </section>;
}
export function TaskBrandSettings({ brand, onChange }: { brand: BrandProfile | undefined; onChange: (brand: BrandProfile | undefined) => void }) {
  return <details className="note-card"><summary>品牌语气与封面规范{brand ? ` · v${brand.version}` : ''}</summary>
    <label className="inline-check"><input type="checkbox" checked={Boolean(brand)} onChange={event => onChange(event.target.checked ? structuredClone(defaultBrandProfile) : undefined)}/>使用品牌配置</label>
    {brand ? <>
      <label>品牌版本<input required value={brand.version} maxLength={60} onChange={event => onChange({ ...brand, version: event.target.value })}/></label>
      <label>品牌读者<input value={brand.audience} maxLength={1000} onChange={event => onChange({ ...brand, audience: event.target.value })}/></label>
      <label>语气<textarea value={brand.tone} maxLength={1000} onChange={event => onChange({ ...brand, tone: event.target.value })}/></label>
      <label>术语与表达规范<textarea value={brand.terminology} maxLength={2000} onChange={event => onChange({ ...brand, terminology: event.target.value })}/></label>
      <div className="form-row"><label>封面主色<input type="color" value={brand.cover.accent} onChange={event => onChange({ ...brand, cover: { ...brand.cover, accent: event.target.value } })}/></label><label>封面模板<select value={brand.cover.style} onChange={event => onChange({ ...brand, cover: { ...brand.cover, style: event.target.value as BrandProfile['cover']['style'] } })}><option value="clear">清晰信息</option><option value="minimal">简洁留白</option></select></label></div>
      <label>封面规范<textarea maxLength={1000} value={brand.cover.instruction} onChange={event => onChange({ ...brand, cover: { ...brand.cover, instruction: event.target.value } })}/></label>
      <div className="brand-cover-preview" style={{ borderColor: brand.cover.accent, padding: brand.cover.style === 'minimal' ? '2rem' : '1rem' }}><small style={{ color: brand.cover.accent }}>Content Studio · v{brand.version}</small><p>清晰标题，兑现内容承诺</p></div>
      <p className="hint">规范随每次执行固定保存；此处为样式预览，实际封面素材仍须单独生成或上传。</p>
    </> : null}
  </details>;
}
function localDateTime(iso: string): string { const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
