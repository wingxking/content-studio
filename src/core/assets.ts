import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { dbRequest } from './database.ts';
import { dataDirectory } from './store.ts';

const assetRowSchema = z.object({ id: z.uuid(), workspace_id: z.uuid(), name: z.string(), mime: z.string(), bytes: z.coerce.number(), sha256: z.string(), object_key: z.string(), created_at: z.string() });
type AssetRow = z.infer<typeof assetRowSchema>;
export type Asset = { id: string; name: string; mime: string; bytes: number; hash: string; createdAt: string; url: string };
const workspace = (): string => z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
const presentation = (row: AssetRow): Asset => ({ id: row.id, name: row.name, mime: row.mime, bytes: row.bytes, hash: row.sha256, createdAt: row.created_at, url: `/api/assets/${row.id}/file` });

export function detectMedia(bytes: Buffer): { mime: string; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  if (bytes.length > 32 && bytes.toString('ascii', 4, 8) === 'ftyp') return { mime: 'video/mp4', extension: 'mp4' };
  throw new Error('Unsupported file contents. Upload a PNG, JPEG, WebP or MP4 file.');
}

async function objectRequest(key: string, method: 'GET' | 'POST', body?: Buffer, mime?: string): Promise<Response> {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret || !process.env.SUPABASE_URL) throw new Error('Local Storage is not configured.');
  const headers: Record<string, string> = { apikey: secret };
  if (secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;
  if (mime) headers['Content-Type'] = mime;
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/studio-assets/${key.split('/').map(encodeURIComponent).join('/')}`, { method, headers, body: body ? new Uint8Array(body).buffer : undefined, signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw new Error(`Local asset storage failed (HTTP ${response.status}).`);
  return response;
}

export async function listAssets(): Promise<Asset[]> {
  return z.array(assetRowSchema).parse(await dbRequest(`studio_assets?workspace_id=eq.${workspace()}&order=created_at.desc&limit=500`)).map(presentation);
}
async function assetRow(id: string): Promise<AssetRow> {
  const row = z.array(assetRowSchema).parse(await dbRequest(`studio_assets?id=eq.${z.uuid().parse(id)}&workspace_id=eq.${workspace()}`))[0];
  if (!row) throw new Error('Asset not found.');
  return row;
}
export async function uploadAsset(name: string, bytes: Buffer): Promise<{ asset: Asset; path: string }> {
  if (bytes.length === 0 || bytes.length > 500 * 1024 * 1024) throw new Error('Upload a non-empty file up to 500 MB.');
  const type = detectMedia(bytes);
  if (type.mime.startsWith('image/') && bytes.length > 24 * 1024 * 1024) throw new Error('Images must be at most 24 MiB so they can be used as model references.');
  const id = randomUUID();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const key = `${workspace()}/${id}.${type.extension}`;
  await objectRequest(key, 'POST', bytes, type.mime);
  const row = assetRowSchema.parse({ id, workspace_id: workspace(), name: basename(name).slice(0, 200), mime: type.mime, bytes: bytes.length, sha256: hash, object_key: key, created_at: new Date().toISOString() });
  await dbRequest('studio_assets', { method: 'POST', body: row });
  const path = await cacheAsset(row, bytes);
  return { asset: presentation(row), path };
}
async function cacheAsset(row: AssetRow, input?: Buffer): Promise<string> {
  const directory = join(dataDirectory(), 'media', 'assets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, basename(row.object_key));
  if (!input) {
    const cached = await readFile(path).catch(() => null);
    if (cached && createHash('sha256').update(cached).digest('hex') === row.sha256) return path;
  }
  const bytes = input ?? Buffer.from(await (await objectRequest(row.object_key, 'GET')).arrayBuffer());
  if (bytes.length !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('Asset integrity check failed.');
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}
export async function resolveAssetPath(id: string): Promise<string> { return cacheAsset(await assetRow(id)); }
export async function resolveAssetImagePaths(ids: string[]): Promise<string[]> {
  const unique = [...new Set(z.array(z.uuid()).max(12).parse(ids))];
  return Promise.all(unique.map(async id => {
    const row = await assetRow(id);
    if (!row.mime.startsWith('image/')) throw new Error('Only images can be used as visual references.');
    return cacheAsset(row);
  }));
}
export async function registerGeneratedAsset(path: string): Promise<Asset> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 500 * 1024 * 1024) throw new Error('Generated media is unavailable or too large.');
  return (await uploadAsset(basename(path), await readFile(path))).asset;
}
