import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { dataDirectory } from './store.ts';

export const maximumAssetBytes = 500 * 1024 * 1024;
export const maximumImageBytes = 24 * 1024 * 1024;
export const localAssetSchema = z.object({ id: z.uuid(), workspace_id: z.uuid(), name: z.string().min(1).max(200), mime: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), object_key: z.string(), created_at: z.string(), storage_provider: z.literal('localfs'), status: z.enum(['pending', 'finalized']), upload_id: z.string() });
export type LocalAssetRecord = z.infer<typeof localAssetSchema>;
const receiptSchema = z.object({ asset: localAssetSchema, source: z.string(), keepSource: z.boolean() });
export type AssetRegistry = (record: LocalAssetRecord) => Promise<void>;
export function localfsDirectory(): string { return resolve(process.env.STUDIO_LOCALFS_DIR ?? join(dataDirectory(), 'media', 'localfs')); }
export function detectMedia(bytes: Buffer): { mime: string; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: 'image/jpeg', extension: 'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return { mime: 'video/mp4', extension: 'mp4' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return { mime: 'audio/wav', extension: 'wav' };
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ((bytes[1] ?? 0) & 6) !== 0)) return { mime: 'audio/mpeg', extension: 'mp3' };
  if (/^\s*\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(bytes.toString('utf8'))) return { mime: 'application/x-subrip', extension: 'srt' };
  if (bytes.toString('utf8').startsWith('WEBVTT')) return { mime: 'text/vtt', extension: 'vtt' };
  throw new Error('Unsupported file contents. Upload PNG, JPEG, WebP, MP4, WAV or MP3 media.');
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
async function durableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temp, path); const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  finally { await rm(temp, { force: true }); }
}
export async function inspectMediaFile(path: string): Promise<{ bytes: number; sha256: string; mime: string; extension: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > maximumAssetBytes) throw new Error('Upload a non-empty media file up to 500 MiB.');
  const hash = createHash('sha256'); let bytes = 0; let prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumAssetBytes) throw new Error('Upload exceeds 500 MiB.');
    hash.update(buffer);
    if (prefix.length < 64) prefix = Buffer.concat([prefix, buffer.subarray(0, 64 - prefix.length)]);
  }
  const type = detectMedia(prefix);
  if (type.mime.startsWith('image/') && bytes > maximumImageBytes) throw new Error('Images must be at most 24 MiB.');
  if (bytes !== info.size) throw new Error('Media changed while being verified.');
  return { bytes, sha256: hash.digest('hex'), ...type };
}

export class LocalAssetStore {
  readonly root: string;
  private readonly active = new Map<string, Promise<LocalAssetRecord>>();
  constructor(private readonly registry: AssetRegistry, root = localfsDirectory()) { this.root = resolve(root); }
  intakeDirectory(): string { return join(this.root, 'intake'); }
  async initialize(): Promise<void> { for (const directory of ['intake', 'upload-state', 'aliases', 'objects']) await mkdir(join(this.root, directory), { recursive: true, mode: 0o700 }); }
  private receiptPath(uploadId: string): string { return join(this.root, 'upload-state', `${z.uuid().parse(uploadId)}.json`); }
  async receipt(uploadId: string): Promise<LocalAssetRecord | null> {
    try { return receiptSchema.parse(JSON.parse(await readFile(this.receiptPath(uploadId), 'utf8'))).asset; }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  async objectPath(key: string): Promise<string> {
    if (!/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}\.(png|jpg|webp|mp4|wav|mp3|srt|vtt)$/.test(key)) throw new Error('Invalid LocalFS object key.');
    const path = await realpath(join(this.root, key)); const root = await realpath(join(this.root, 'objects'));
    if (!path.startsWith(`${root}${sep}`)) throw new Error('LocalFS object escapes its managed directory.');
    return path;
  }
  async verify(record: Pick<LocalAssetRecord, 'object_key' | 'sha256' | 'bytes'>): Promise<string> {
    const path = await this.objectPath(record.object_key); const verified = await inspectMediaFile(path);
    if (verified.sha256 !== record.sha256 || verified.bytes !== record.bytes) throw new Error('Asset integrity check failed.');
    return path;
  }
  async ingest(name: string, source: Readable, workspaceId: string): Promise<LocalAssetRecord> {
    await this.initialize(); const uploadId = randomUUID(); const path = join(this.intakeDirectory(), uploadId); let bytes = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > maximumAssetBytes ? new Error('Upload exceeds 500 MiB.') : null, chunk); } });
    try { await pipeline(source, limit, createWriteStream(path, { flags: 'wx', mode: 0o600 })); return await this.finalize(uploadId, name, workspaceId, path); }
    catch (error) { if (!(await this.receipt(uploadId))) await rm(path, { force: true }); throw error; }
  }
  finalize(uploadId: string, name: string, workspaceId: string, source = join(this.intakeDirectory(), z.uuid().parse(uploadId)), keepSource = false, assetId = uploadId): Promise<LocalAssetRecord> {
    const existing = this.active.get(uploadId); if (existing) return existing;
    const work = this.finalizeOnce(uploadId, name, workspaceId, source, keepSource, assetId).finally(() => this.active.delete(uploadId));
    this.active.set(uploadId, work); return work;
  }
  private async finalizeOnce(uploadId: string, name: string, workspaceId: string, source: string, keepSource: boolean, assetId: string): Promise<LocalAssetRecord> {
    await this.initialize(); const receiptPath = this.receiptPath(uploadId);
    let receipt: z.infer<typeof receiptSchema>;
    try { receipt = receiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8'))); }
    catch (error) {
      if (!missing(error)) throw error;
      const sourcePath = await realpath(source); const intake = await realpath(this.intakeDirectory());
      if (!sourcePath.startsWith(`${intake}${sep}`)) throw new Error('Upload source escapes the managed intake directory.');
      const verified = await inspectMediaFile(sourcePath);
      const file = await open(sourcePath, 'r'); try { await file.sync(); } finally { await file.close(); }
      receipt = { source: sourcePath, keepSource, asset: localAssetSchema.parse({ id: assetId, workspace_id: workspaceId, name: basename(name).slice(0, 200) || 'Media', mime: verified.mime, bytes: verified.bytes, sha256: verified.sha256, object_key: `objects/${verified.sha256.slice(0, 2)}/${verified.sha256}.${verified.extension}`, created_at: new Date().toISOString(), storage_provider: 'localfs', status: 'pending', upload_id: uploadId }) };
      await durableJson(receiptPath, receipt);
    }
    const intakeRoot = await realpath(this.intakeDirectory());
    if (!receipt.source.startsWith(`${intakeRoot}${sep}`)) receipt.source = join(intakeRoot, z.uuid().parse(basename(receipt.source)));
    if (receipt.asset.workspace_id !== workspaceId) throw new Error('Upload belongs to another workspace.');
    if (receipt.asset.status === 'finalized') { await this.verify(receipt.asset); return receipt.asset; }
    await this.registry(receipt.asset);
    const target = join(this.root, receipt.asset.object_key); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // A hard link publishes complete bytes atomically without overwriting an existing immutable object.
    try { await link(receipt.source, target); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) { try { await this.verify(receipt.asset); } catch { throw error; } } }
    await this.verify(receipt.asset);
    const directory = await open(dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    const finalized: LocalAssetRecord = { ...receipt.asset, status: 'finalized' };
    await this.registry(finalized); receipt.asset = finalized; await durableJson(receiptPath, receipt);
    if (!receipt.keepSource) await rm(receipt.source, { force: true });
    return finalized;
  }
  async repair(): Promise<{ repaired: number; failures: string[] }> {
    await this.initialize(); let repaired = 0; const failures: string[] = [];
    for (const name of await readdir(join(this.root, 'upload-state'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const receipt = receiptSchema.parse(JSON.parse(await readFile(join(this.root, 'upload-state', name), 'utf8')));
        if (receipt.asset.status === 'finalized') continue;
        await this.finalize(receipt.asset.upload_id, receipt.asset.name, receipt.asset.workspace_id, receipt.source, receipt.keepSource, receipt.asset.id); repaired++;
      } catch { failures.push(name); }
    }
    return { repaired, failures };
  }
  async alias(literal: string, record: LocalAssetRecord): Promise<void> {
    await this.verify(record); await durableJson(join(this.root, 'aliases', `${createHash('sha256').update(literal).digest('hex')}.json`), { literal, object_key: record.object_key, sha256: record.sha256, bytes: record.bytes });
  }
  async resolveAlias(literal: string): Promise<string | null> {
    const path = join(this.root, 'aliases', `${createHash('sha256').update(literal).digest('hex')}.json`);
    let alias: { literal: string; object_key: string; sha256: string; bytes: number };
    try { alias = z.object({ literal: z.string(), object_key: z.string(), sha256: z.string(), bytes: z.number() }).parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) { if (missing(error)) return null; throw error; }
    if (alias.literal !== literal) throw new Error('Legacy media alias differs from its reference.');
    return this.verify(alias);
  }
}
