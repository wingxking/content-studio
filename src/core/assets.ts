import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { dbRequest } from './database.ts';
import { dataDirectory } from './store.ts';
import { LocalAssetStore, localAssetSchema, type LocalAssetRecord } from './localfs.ts';
export { detectMedia } from './localfs.ts';

const assetRowSchema = z.object({ id: z.uuid(), workspace_id: z.uuid(), name: z.string(), mime: z.string(), bytes: z.coerce.number(), sha256: z.string(), object_key: z.string(), created_at: z.string(), storage_provider: z.enum(['supabase', 'localfs']).default('supabase'), status: z.enum(['pending', 'finalized']).default('finalized'), upload_id: z.string().nullable().optional(), localfs_key: z.string().nullable().optional() });
type AssetRow = z.infer<typeof assetRowSchema>;
export type Asset = { id: string; name: string; mime: string; bytes: number; hash: string; createdAt: string; url: string };
export const assetWorkspace = (): string => z.uuid().parse(process.env.STUDIO_WORKSPACE_ID);
export const presentAsset = (row: AssetRow): Asset => ({ id: row.id, name: row.name, mime: row.mime, bytes: row.bytes, hash: row.sha256, createdAt: row.created_at, url: `/api/assets/${row.id}/file` });
export function assetStore(): LocalAssetStore {
  return new LocalAssetStore(async record => {
    const existing = z.array(assetRowSchema).parse(await dbRequest(`studio_assets?id=eq.${record.id}&workspace_id=eq.${record.workspace_id}`))[0];
    if (existing && (existing.storage_provider === 'supabase' || existing.localfs_key)) {
      if (existing.sha256 !== record.sha256 || existing.bytes !== record.bytes) throw new Error('Legacy migration hash differs.');
      if (record.status === 'finalized') await dbRequest(`studio_assets?id=eq.${record.id}&workspace_id=eq.${record.workspace_id}`, { method: 'PATCH', body: { localfs_key: record.object_key, storage_provider: 'localfs', status: 'finalized', upload_id: record.upload_id } });
      return;
    }
    await dbRequest('studio_assets?on_conflict=id', { method: 'POST', body: record, prefer: 'resolution=merge-duplicates' });
  });
}
async function storageResponse(key: string): Promise<Response> {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret || !process.env.SUPABASE_URL) throw new Error('Legacy Storage is not configured.');
  const headers: Record<string, string> = { apikey: secret }; if (secret.startsWith('eyJ')) headers.Authorization = `Bearer ${secret}`;
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/studio-assets/${key.split('/').map(encodeURIComponent).join('/')}`, { headers, signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Legacy asset storage failed (HTTP ${response.status}).`);
  return response;
}
export async function listAssets(): Promise<Asset[]> {
  return z.array(assetRowSchema).parse(await dbRequest(`studio_assets?workspace_id=eq.${assetWorkspace()}&status=eq.finalized&order=created_at.desc&limit=500`)).map(presentAsset);
}
async function assetRow(id: string): Promise<AssetRow> {
  const row = z.array(assetRowSchema).parse(await dbRequest(`studio_assets?id=eq.${z.uuid().parse(id)}&workspace_id=eq.${assetWorkspace()}`))[0];
  if (!row || row.status !== 'finalized') throw new Error('Asset not found or upload is incomplete.'); return row;
}
export async function uploadAssetStream(name: string, stream: Readable): Promise<{ asset: Asset; path: string; reference: string }> {
  const store = assetStore(); const record = await store.ingest(name, stream, assetWorkspace());
  return { asset: presentAsset(record), path: await store.verify(record), reference: `studio-asset:${record.id}` };
}
export async function uploadAsset(name: string, bytes: Buffer): Promise<{ asset: Asset; path: string; reference: string }> { return uploadAssetStream(name, Readable.from([bytes])); }
async function legacyCache(row: AssetRow): Promise<string> {
  const directory = join(dataDirectory(), 'media', 'assets'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, basename(row.object_key));
  const verify = async (candidate: string): Promise<string> => {
    const { inspectMediaFile } = await import('./localfs.ts'); const inspected = await inspectMediaFile(candidate);
    if (inspected.sha256 !== row.sha256 || inspected.bytes !== row.bytes) throw new Error('Asset integrity check failed.'); return candidate;
  };
  try { return await verify(path); } catch { /* Rebuild a missing or invalid cache from the unchanged Storage authority. */ }
  const temporary = join(directory, `${row.id}.${randomUUID()}.tmp`);
  try {
    const response = await storageResponse(row.object_key);
    const reader = response.body!.getReader();
    async function* chunks() { let bytes = 0; try { for (;;) { const chunk = await reader.read(); if (chunk.done) return; bytes += chunk.value.byteLength; if (bytes > row.bytes) throw new Error('Legacy object exceeds registered size.'); yield chunk.value; } } finally { await reader.cancel(); reader.releaseLock(); } }
    await pipeline(Readable.from(chunks()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 })); await verify(temporary);
    const { rename } = await import('node:fs/promises'); await rename(temporary, path); return path;
  } finally { await rm(temporary, { force: true }); }
}
export async function getAsset(id: string): Promise<Asset> { return presentAsset(await assetRow(id)); }
export async function resolveAssetPath(id: string): Promise<string> {
  const row = await assetRow(id); return row.storage_provider === 'localfs' ? assetStore().verify({ ...row, object_key: row.localfs_key ?? row.object_key }) : legacyCache(row);
}
export async function assetMediaReference(id: string): Promise<string> { await assetRow(id); return `studio-asset:${id}`; }
export async function resolveAssetImagePaths(ids: string[]): Promise<string[]> {
  const unique = [...new Set(z.array(z.uuid()).max(12).parse(ids))];
  return Promise.all(unique.map(async id => { const row = await assetRow(id); if (!row.mime.startsWith('image/')) throw new Error('Only images can be used as visual references.'); return resolveAssetPath(id); }));
}
export async function registerGeneratedAsset(path: string): Promise<Asset> { return (await uploadAssetStream(basename(path), createReadStream(path))).asset; }
export async function migrateStorageAssets(): Promise<{ migrated: number; failures: string[] }> {
  const rows = z.array(assetRowSchema).parse(await dbRequest(`studio_assets?workspace_id=eq.${assetWorkspace()}&storage_provider=eq.supabase&status=eq.finalized`));
  let migrated = 0; const failures: string[] = []; const store = assetStore(); await store.initialize();
  for (const row of rows) {
    try {
      const legacy = await legacyCache(row); const source = join(store.intakeDirectory(), row.id);
      await pipeline(createReadStream(legacy), createWriteStream(source, { flags: 'w', mode: 0o600 }));
      // Do not change the registry's old authority until complete LocalFS bytes have been verified.
      const record = await store.finalize(row.id, row.name, row.workspace_id, source, false, row.id);
      await store.alias(legacy, record); migrated++;
    } catch { failures.push(row.id); }
  }
  return { migrated, failures };
}
export async function registerLegacyAlias(literal: string, path: string): Promise<LocalAssetRecord> {
  const absolute = await realpath(path); const root = await realpath(dataDirectory());
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Legacy source escapes the local data directory.');
  const record = await assetStore().ingest(basename(literal), createReadStream(absolute), assetWorkspace());
  await assetStore().alias(literal, record); return localAssetSchema.parse(record);
}
