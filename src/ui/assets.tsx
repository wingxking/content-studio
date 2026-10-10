import { useState } from 'react';
import { type Asset, errorMessage, uploadAsset } from './api.ts';

export function AssetPicker({ assets, selected, onChange, onUpload, disabled = false, imagesOnly = true, maxSelected = 12 }: { assets: Asset[]; selected: string[]; onChange: (ids: string[]) => void; onUpload: (asset: Asset) => void; disabled?: boolean; imagesOnly?: boolean; maxSelected?: number }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const available = imagesOnly ? assets.filter(asset => asset.mime.startsWith('image/')) : assets;
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    if (selected.length + files.length > maxSelected) { setError(`最多选择 ${maxSelected} 个素材，请减少选择或上传数量。`); return; }
    setUploading(true); setError('');
    const added: string[] = [];
    try { for (const file of Array.from(files)) { const result = await uploadAsset(file); onUpload(result.asset); added.push(result.asset.id); } onChange([...new Set([...selected, ...added])]); }
    catch (caught) { setError(errorMessage(caught)); if (added.length) onChange([...new Set([...selected, ...added])]); }
    finally { setUploading(false); }
  };
  return <div className="asset-picker"><div className="section-label"><h3>参考素材</h3><label className="upload-button">{uploading ? '上传中…' : imagesOnly ? '+ 上传参考图片' : '+ 上传图片 / 视频'}<input type="file" multiple accept={imagesOnly ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg,image/webp,video/mp4,video/quicktime"} disabled={disabled || uploading} onChange={event => { void upload(event.target.files); event.target.value = ''; }}/></label></div>
    <p className="hint">{imagesOnly ? `选择图片作为模型的视觉参考，最多 ${maxSelected} 张、每张 24 MiB；不会自动作为发布配图。` : "图片最多 24 MiB，视频最多 500 MiB；选择素材管理或附加到稿件。"}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="asset-grid">{available.map(asset => <button type="button" className={`asset-choice ${selected.includes(asset.id) ? 'selected' : ''}`} key={asset.id} disabled={disabled || uploading || (!selected.includes(asset.id) && selected.length >= maxSelected)} aria-pressed={selected.includes(asset.id)} onClick={() => onChange(selected.includes(asset.id) ? selected.filter(id => id !== asset.id) : [...selected, asset.id])}>{asset.mime.startsWith('image/') ? <img src={asset.url} alt={asset.name}/> : <span className="asset-video">▶</span>}<span>{asset.name}</span><small>{(asset.bytes / 1024).toFixed(0)} KB{selected.includes(asset.id) ? ' · 已选' : ''}</small></button>)}</div>
    {!available.length && <div className="compact-empty">还没有素材，上传一张图片开始。</div>}
  </div>;
}

export function AssetsPanel({ assets, onUpload }: { assets: Asset[]; onUpload: (asset: Asset) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <><section className="intro"><span className="eyebrow">MEDIA LIBRARY</span><h1>素材在这里，创作随时引用。</h1><p>统一管理上传素材。任务、AI 调优和视频稿件可以选取同一张图片。</p></section><section className="panel"><AssetPicker assets={assets} selected={selected} onChange={setSelected} onUpload={onUpload} imagesOnly={false} maxSelected={500}/><div className="asset-downloads">{assets.filter(asset => selected.includes(asset.id)).map(asset => <a key={asset.id} className="button" href={asset.url} download={asset.name}>下载 {asset.name} ↗</a>)}</div></section></>;
}
